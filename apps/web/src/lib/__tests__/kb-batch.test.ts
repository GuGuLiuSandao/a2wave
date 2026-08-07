import {
  KB_BATCH_MAX,
  type KbBatchItem,
  isLikelySourceUrl,
  parseKbSourceUrls,
  runKbBatch,
} from '@/lib/kb-batch'
import { describe, expect, it, vi } from 'vitest'

describe('parseKbSourceUrls', () => {
  it('splits on newlines and trims each line', () => {
    expect(parseKbSourceUrls('  https://a.com  \n\thttps://b.com\t')).toEqual([
      'https://a.com',
      'https://b.com',
    ])
  })

  it('drops blank and whitespace-only lines', () => {
    expect(parseKbSourceUrls('https://a.com\n\n   \n\nhttps://b.com\n')).toEqual([
      'https://a.com',
      'https://b.com',
    ])
  })

  it('handles CRLF line endings', () => {
    expect(parseKbSourceUrls('https://a.com\r\nhttps://b.com')).toEqual([
      'https://a.com',
      'https://b.com',
    ])
  })

  it('collapses exact duplicates, keeping first-seen order', () => {
    // Two rows for the same page would each carry their own auto-sync timer.
    expect(parseKbSourceUrls('https://b.com\nhttps://a.com\nhttps://b.com')).toEqual([
      'https://b.com',
      'https://a.com',
    ])
  })

  it('treats differently-cased URLs as distinct', () => {
    // Notion page slugs are case-sensitive; "smart" normalising would merge real pages.
    expect(parseKbSourceUrls('https://a.com/Page\nhttps://a.com/page')).toHaveLength(2)
  })

  it('returns an empty array for empty or whitespace-only input', () => {
    expect(parseKbSourceUrls('')).toEqual([])
    expect(parseKbSourceUrls('  \n \n ')).toEqual([])
  })

  it('does not cap at KB_BATCH_MAX — silently dropping links is worse than an error', () => {
    const raw = Array.from({ length: KB_BATCH_MAX + 5 }, (_, i) => `https://a.com/${i}`).join('\n')
    expect(parseKbSourceUrls(raw)).toHaveLength(KB_BATCH_MAX + 5)
  })
})

describe('isLikelySourceUrl', () => {
  it('accepts absolute http and https URLs', () => {
    expect(isLikelySourceUrl('https://x.feishu.cn/docx/abc')).toBe(true)
    expect(isLikelySourceUrl('http://x.feishu.cn/wiki/abc')).toBe(true)
  })

  it('rejects input the server-side parsers could never accept', () => {
    expect(isLikelySourceUrl('www.notion.so/abc')).toBe(false)
    expect(isLikelySourceUrl('ftp://x.com/a')).toBe(false)
    expect(isLikelySourceUrl('javascript:alert(1)')).toBe(false)
    expect(isLikelySourceUrl('')).toBe(false)
    expect(isLikelySourceUrl('   ')).toBe(false)
    expect(isLikelySourceUrl('not a url at all')).toBe(false)
  })
})

describe('runKbBatch', () => {
  const opts = (over: Partial<Parameters<typeof runKbBatch>[2]> = {}) => ({
    onProgress: vi.fn(),
    formatError: (err: unknown) => (err as Error).message,
    ...over,
  })

  it('runs items strictly one at a time', async () => {
    const active: number[] = []
    let concurrent = 0
    await runKbBatch(
      ['a', 'b', 'c'],
      async () => {
        concurrent += 1
        active.push(concurrent)
        await Promise.resolve()
        concurrent -= 1
        return {}
      },
      opts(),
    )
    expect(active).toEqual([1, 1, 1])
  })

  it('passes the label and index to the create callback in order', async () => {
    const create = vi.fn(async () => ({}))
    await runKbBatch(['a', 'b'], create, opts())
    expect(create.mock.calls).toEqual([
      ['a', 0],
      ['b', 1],
    ])
  })

  it('reports progress on every status transition', async () => {
    const onProgress = vi.fn()
    await runKbBatch(['a'], async () => ({ name: 'Doc' }), opts({ onProgress }))

    const statuses = onProgress.mock.calls.map((call) =>
      (call[0] as KbBatchItem[]).map((i) => i.status),
    )
    expect(statuses).toContainEqual(['running'])
    expect(statuses.at(-1)).toEqual(['success'])
  })

  it('records the returned name on success', async () => {
    const { items, succeeded } = await runKbBatch(['a'], async () => ({ name: 'Doc' }), opts())
    expect(items).toEqual([{ label: 'a', status: 'success', name: 'Doc' }])
    expect(succeeded).toBe(1)
  })

  it('captures a rejection and keeps going', async () => {
    const { items, succeeded, remaining } = await runKbBatch(
      ['a', 'b', 'c'],
      async (label) => {
        if (label === 'b') throw new Error('no permission')
        return {}
      },
      opts(),
    )

    expect(items.map((i) => i.status)).toEqual(['success', 'error', 'success'])
    expect(items[1].error).toBe('no permission')
    expect(succeeded).toBe(2)
    expect(remaining).toEqual(['b'])
  })

  it('stops between items and reports the untried labels as remaining', async () => {
    let stop = false
    const create = vi.fn(async () => {
      stop = true
      return {}
    })

    const { items, succeeded, remaining } = await runKbBatch(
      ['a', 'b', 'c'],
      create,
      opts({ shouldStop: () => stop }),
    )

    expect(create).toHaveBeenCalledTimes(1)
    expect(succeeded).toBe(1)
    expect(remaining).toEqual(['b', 'c'])
    expect(items.map((i) => i.status)).toEqual(['success', 'pending', 'pending'])
  })

  it('keeps failures and skipped items in input order in remaining', async () => {
    let stop = false
    const { remaining } = await runKbBatch(
      ['a', 'b', 'c', 'd'],
      async (label) => {
        if (label === 'a') throw new Error('boom')
        if (label === 'b') stop = true
        return {}
      },
      opts({ shouldStop: () => stop }),
    )
    expect(remaining).toEqual(['a', 'c', 'd'])
  })

  it('handles an empty label list', async () => {
    const onProgress = vi.fn()
    const result = await runKbBatch([], async () => ({}), opts({ onProgress }))
    expect(result).toEqual({
      items: [],
      succeeded: 0,
      remaining: [],
      createdIds: [],
      firstError: '',
    })
    expect(onProgress).not.toHaveBeenCalled()
  })

  it('works without an onProgress callback', async () => {
    const { succeeded } = await runKbBatch(['a'], async () => ({}), {
      formatError: (err) => (err as Error).message,
    })
    expect(succeeded).toBe(1)
  })

  it('collects created ids in completion order, skipping failures', async () => {
    const { createdIds } = await runKbBatch(
      ['a', 'b', 'c'],
      async (label) => {
        if (label === 'b') throw new Error('nope')
        return { id: `kbd_${label}` }
      },
      opts(),
    )
    expect(createdIds).toEqual(['kbd_a', 'kbd_c'])
  })

  it('reports the first failure message, not the last', async () => {
    const { firstError } = await runKbBatch(
      ['a', 'b', 'c'],
      async (label) => {
        if (label !== 'a') throw new Error(`fail-${label}`)
        return {}
      },
      opts(),
    )
    expect(firstError).toBe('fail-b')
  })

  it('leaves firstError empty when nothing failed', async () => {
    const { firstError } = await runKbBatch(['a'], async () => ({}), opts())
    expect(firstError).toBe('')
  })
})
