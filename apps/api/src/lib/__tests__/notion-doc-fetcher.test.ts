import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('../logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}))

import { computeContentHash } from '../feishu-doc-fetcher.js'
import {
  type NotionBlockNode,
  fetchNotionBlockTree,
  fetchNotionDocByUrl,
  fetchNotionPageTitle,
  notionBlocksToMarkdown,
  parseNotionErrorMessage,
  parseNotionPageUrl,
} from '../notion-doc-fetcher.js'

const PAGE_ID_RAW = '2dc2541e45a5495e817e2ac6e189ea5a'
const PAGE_ID = '2dc2541e-45a5-495e-817e-2ac6e189ea5a'

function jsonResponse(body: unknown, status = 200, headers: Record<string, string> = {}) {
  const lower = Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]))
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (key: string) => lower[key.toLowerCase()] ?? null },
    json: async () => body,
  }
}

const ANNOTATIONS = {
  bold: false,
  italic: false,
  strikethrough: false,
  underline: false,
  code: false,
  color: 'default',
}

function richText(text: string, overrides: Record<string, unknown> = {}) {
  return {
    type: 'text',
    plain_text: text,
    href: null,
    annotations: { ...ANNOTATIONS },
    ...overrides,
  }
}

function block(
  type: string,
  payload: Record<string, unknown>,
  extra: Record<string, unknown> = {},
) {
  return {
    object: 'block',
    id: `blk-${type}`,
    type,
    has_children: false,
    [type]: payload,
    ...extra,
  }
}

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('parseNotionPageUrl', () => {
  it('parses a notion.so URL with workspace and slug', async () => {
    expect(parseNotionPageUrl(`https://www.notion.so/myws/My-Page-${PAGE_ID_RAW}`)).toEqual({
      pageId: PAGE_ID,
    })
  })

  it('parses a bare notion.so URL', async () => {
    expect(parseNotionPageUrl(`https://www.notion.so/${PAGE_ID_RAW}`)).toEqual({ pageId: PAGE_ID })
  })

  it('parses a hyphenated UUID path segment', async () => {
    expect(parseNotionPageUrl(`https://www.notion.so/${PAGE_ID}`)).toEqual({ pageId: PAGE_ID })
  })

  it('parses a notion.site public URL', async () => {
    expect(parseNotionPageUrl(`https://myws.notion.site/Hello-World-${PAGE_ID_RAW}`)).toEqual({
      pageId: PAGE_ID,
    })
  })

  it('parses an app.notion.com /p/ URL', async () => {
    expect(parseNotionPageUrl(`https://app.notion.com/p/rooobin/${PAGE_ID_RAW}`)).toEqual({
      pageId: PAGE_ID,
    })
  })

  it('parses a peek link with ?p= query param', async () => {
    expect(parseNotionPageUrl(`https://www.notion.so/myws/Some-Doc?p=${PAGE_ID_RAW}&pm=s`)).toEqual(
      { pageId: PAGE_ID },
    )
  })

  it('prefers a valid peek page id when the URL also has a database view id', async () => {
    expect(
      parseNotionPageUrl(
        `https://www.notion.so/myws/Database?v=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa&p=${PAGE_ID_RAW}`,
      ),
    ).toEqual({ pageId: PAGE_ID })
  })

  it('rejects a database view URL (?v=)', async () => {
    expect(() =>
      parseNotionPageUrl(
        `https://www.notion.so/myws/${PAGE_ID_RAW}?v=abcd1234abcd1234abcd1234abcd1234`,
      ),
    ).toThrow(/database/i)
  })

  it('rejects a URL without a page id', async () => {
    expect(() => parseNotionPageUrl('https://www.notion.so/')).toThrow(/Invalid Notion/)
    expect(() => parseNotionPageUrl('https://www.notion.so/myws/just-a-slug')).toThrow(
      /Invalid Notion/,
    )
  })

  it('rejects a non-URL string', async () => {
    expect(() => parseNotionPageUrl('not a url')).toThrow()
  })
})

describe('parseNotionErrorMessage', () => {
  it('maps 401 to an invalid token hint', async () => {
    expect(parseNotionErrorMessage(401, { code: 'unauthorized', message: 'x' })).toMatch(
      /Invalid Notion token/,
    )
  })

  it('maps 404 to a not-shared hint that also mentions databases', async () => {
    const msg = parseNotionErrorMessage(404, { code: 'object_not_found', message: 'x' })
    expect(msg).toMatch(/not shared with the Integration/)
    expect(msg).toMatch(/database/i)
  })

  it('maps 403 to a restricted hint', async () => {
    expect(
      parseNotionErrorMessage(403, { code: 'restricted_from_public_api', message: 'x' }),
    ).toMatch(/permission|restrict/i)
  })

  it('maps 400 validation errors with the original message', async () => {
    expect(parseNotionErrorMessage(400, { code: 'validation_error', message: 'bad id' })).toMatch(
      /bad id/,
    )
  })

  it('maps 429 to a rate limit hint', async () => {
    expect(parseNotionErrorMessage(429, { code: 'rate_limited', message: 'x' })).toMatch(
      /rate limit/i,
    )
  })

  it('formats unknown errors with code and message', async () => {
    expect(
      parseNotionErrorMessage(500, { code: 'internal_server_error', message: 'boom' }),
    ).toMatch(/internal_server_error.*boom/)
  })

  it('returns null when there is no body', async () => {
    expect(parseNotionErrorMessage(500, null)).toBeNull()
  })
})

describe('fetchNotionPageTitle', () => {
  it('joins the plain_text of the title-type property regardless of its key', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse({
        object: 'page',
        id: PAGE_ID,
        properties: {
          Tags: { type: 'multi_select', multi_select: [] },
          自定义标题: { type: 'title', title: [richText('Hello'), richText(' World')] },
        },
      }),
    )
    vi.stubGlobal('fetch', fetchMock)

    await expect(fetchNotionPageTitle('tok', PAGE_ID)).resolves.toBe('Hello World')
    expect(fetchMock).toHaveBeenCalledWith(
      `https://api.notion.com/v1/pages/${PAGE_ID}`,
      expect.objectContaining({
        headers: expect.objectContaining({
          Authorization: 'Bearer tok',
          'Notion-Version': '2022-06-28',
        }),
      }),
    )
  })

  it('falls back to "Untitled" when the title is empty', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        jsonResponse({
          object: 'page',
          id: PAGE_ID,
          properties: { title: { type: 'title', title: [] } },
        }),
      ),
    )
    await expect(fetchNotionPageTitle('tok', PAGE_ID)).resolves.toBe('Untitled')
  })

  it('throws a friendly error on 401', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(jsonResponse({ code: 'unauthorized', message: 'no' }, 401)),
    )
    await expect(fetchNotionPageTitle('bad', PAGE_ID)).rejects.toThrow(/Invalid Notion token/)
  })

  it('throws a connectivity hint when fetch itself fails', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('fetch failed')))
    await expect(fetchNotionPageTitle('tok', PAGE_ID)).rejects.toThrow(
      /Cannot reach the Notion API/,
    )
  })

  it('uses an abort signal and reports a friendly timeout error', async () => {
    const controller = new AbortController()
    const timeoutSpy = vi.spyOn(AbortSignal, 'timeout').mockReturnValue(controller.signal)
    vi.stubGlobal(
      'fetch',
      vi.fn().mockImplementation((_url: string, init?: RequestInit) => {
        if (!init?.signal) return Promise.reject(new Error('missing abort signal'))
        return new Promise((_resolve, reject) => {
          init.signal?.addEventListener('abort', () => reject(init.signal?.reason), { once: true })
        })
      }),
    )

    const titlePromise = fetchNotionPageTitle('tok', PAGE_ID)
    controller.abort(new DOMException('timed out', 'TimeoutError'))

    await expect(titlePromise).rejects.toThrow(/Notion API.*timed out/)
    expect(timeoutSpy).toHaveBeenCalledWith(300_000)
  })

  it('reports the same friendly timeout when reading the response body stalls', async () => {
    const controller = new AbortController()
    let markBodyStarted: () => void = () => undefined
    const bodyStarted = new Promise<void>((resolve) => {
      markBodyStarted = resolve
    })
    vi.spyOn(AbortSignal, 'timeout').mockReturnValue(controller.signal)
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ...jsonResponse({}),
        json: () =>
          new Promise((_resolve, reject) => {
            markBodyStarted()
            controller.signal.addEventListener('abort', () => reject(controller.signal.reason), {
              once: true,
            })
          }),
      }),
    )

    const titlePromise = fetchNotionPageTitle('tok', PAGE_ID)
    await bodyStarted
    controller.abort(new DOMException('timed out', 'TimeoutError'))

    await expect(titlePromise).rejects.toThrow(/Notion API.*timed out/)
  })

  it('retries on 429 honoring Retry-After and eventually succeeds', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse({ code: 'rate_limited', message: 'slow down' }, 429, { 'Retry-After': '0' }),
      )
      .mockResolvedValueOnce(
        jsonResponse({
          object: 'page',
          id: PAGE_ID,
          properties: { title: { type: 'title', title: [richText('Ok')] } },
        }),
      )
    vi.stubGlobal('fetch', fetchMock)

    await expect(fetchNotionPageTitle('tok', PAGE_ID)).resolves.toBe('Ok')
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it.each([undefined, ''])(
    'uses the default retry delay when Retry-After is %s',
    async (retryAfter) => {
      vi.useFakeTimers()
      const headers: Record<string, string> =
        retryAfter === undefined ? {} : { 'Retry-After': retryAfter }
      const fetchMock = vi
        .fn()
        .mockResolvedValueOnce(
          jsonResponse({ code: 'rate_limited', message: 'slow down' }, 429, headers),
        )
        .mockResolvedValueOnce(
          jsonResponse({
            object: 'page',
            id: PAGE_ID,
            properties: { title: { type: 'title', title: [richText('Ok')] } },
          }),
        )
      vi.stubGlobal('fetch', fetchMock)

      const titlePromise = fetchNotionPageTitle('tok', PAGE_ID)
      await vi.advanceTimersByTimeAsync(999)
      expect(fetchMock).toHaveBeenCalledTimes(1)
      await vi.advanceTimersByTimeAsync(1)

      await expect(titlePromise).resolves.toBe('Ok')
      expect(fetchMock).toHaveBeenCalledTimes(2)
    },
  )

  it('caps an excessive Retry-After delay', async () => {
    vi.useFakeTimers()
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse({ code: 'rate_limited', message: 'slow down' }, 429, {
          'Retry-After': '3600',
        }),
      )
      .mockResolvedValueOnce(
        jsonResponse({
          object: 'page',
          id: PAGE_ID,
          properties: { title: { type: 'title', title: [richText('Ok')] } },
        }),
      )
    vi.stubGlobal('fetch', fetchMock)

    const titlePromise = fetchNotionPageTitle('tok', PAGE_ID)
    await vi.advanceTimersByTimeAsync(9_999)
    expect(fetchMock).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(1)

    await expect(titlePromise).resolves.toBe('Ok')
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('gives up after exhausting 429 retries', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(
        jsonResponse({ code: 'rate_limited', message: 'slow down' }, 429, { 'Retry-After': '0' }),
      )
    vi.stubGlobal('fetch', fetchMock)

    await expect(fetchNotionPageTitle('tok', PAGE_ID)).rejects.toThrow(/rate limit/i)
    expect(fetchMock.mock.calls.length).toBeGreaterThan(1)
  })
})

describe('fetchNotionBlockTree', () => {
  it('merges paginated results across cursors', async () => {
    const fetchMock = vi.fn().mockImplementation((url: string) => {
      if (url.includes('start_cursor=cur2')) {
        return Promise.resolve(
          jsonResponse({
            results: [block('paragraph', { rich_text: [richText('second')] })],
            has_more: false,
            next_cursor: null,
          }),
        )
      }
      return Promise.resolve(
        jsonResponse({
          results: [block('paragraph', { rich_text: [richText('first')] })],
          has_more: true,
          next_cursor: 'cur2',
        }),
      )
    })
    vi.stubGlobal('fetch', fetchMock)

    const tree = await fetchNotionBlockTree('tok', PAGE_ID)
    expect(tree).toHaveLength(2)
    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(String(fetchMock.mock.calls[0][0])).toContain(
      `https://api.notion.com/v1/blocks/${PAGE_ID}/children?page_size=100`,
    )
  })

  it('recursively fetches children of nested blocks', async () => {
    const fetchMock = vi.fn().mockImplementation((url: string) => {
      if (url.includes('/blocks/toggle-1/')) {
        return Promise.resolve(
          jsonResponse({
            results: [block('paragraph', { rich_text: [richText('inside')] })],
            has_more: false,
            next_cursor: null,
          }),
        )
      }
      return Promise.resolve(
        jsonResponse({
          results: [
            {
              ...block('toggle', { rich_text: [richText('open me')] }),
              id: 'toggle-1',
              has_children: true,
            },
          ],
          has_more: false,
          next_cursor: null,
        }),
      )
    })
    vi.stubGlobal('fetch', fetchMock)

    const tree = await fetchNotionBlockTree('tok', PAGE_ID)
    expect(tree[0].children).toHaveLength(1)
    expect((tree[0].children?.[0] as NotionBlockNode).type).toBe('paragraph')
  })

  it('does not recurse into child_page blocks', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse({
        results: [
          {
            ...block('child_page', { title: 'Sub Page' }),
            id: 'sub-1',
            has_children: true,
          },
        ],
        has_more: false,
        next_cursor: null,
      }),
    )
    vi.stubGlobal('fetch', fetchMock)

    const tree = await fetchNotionBlockTree('tok', PAGE_ID)
    expect(tree[0].children).toBeUndefined()
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('rejects blocks with children beyond the supported nesting depth', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        jsonResponse({
          results: [
            {
              ...block('toggle', { rich_text: [richText('too deep')] }),
              id: 'deep-toggle',
              has_children: true,
            },
          ],
          has_more: false,
          next_cursor: null,
        }),
      ),
    )

    await expect(fetchNotionBlockTree('tok', PAGE_ID, 10)).rejects.toThrow(
      /nesting depth exceeds the sync limit \(10 levels\)/,
    )
  })
})

describe('notionBlocksToMarkdown', () => {
  it('renders headings, paragraphs and dividers', async () => {
    const md = notionBlocksToMarkdown([
      block('heading_1', { rich_text: [richText('Big')] }),
      block('heading_2', { rich_text: [richText('Mid')] }),
      block('heading_3', { rich_text: [richText('Small')] }),
      block('paragraph', { rich_text: [richText('Body text')] }),
      block('divider', {}),
    ] as NotionBlockNode[])
    expect(md).toBe('# Big\n\n## Mid\n\n### Small\n\nBody text\n\n---')
  })

  it('renders rich text annotations and links', async () => {
    const md = notionBlocksToMarkdown([
      block('paragraph', {
        rich_text: [
          richText('bold', { annotations: { ...ANNOTATIONS, bold: true } }),
          richText(' and '),
          richText('code', { annotations: { ...ANNOTATIONS, code: true } }),
          richText(' and '),
          richText('link', { href: 'https://example.com' }),
        ],
      }),
    ] as NotionBlockNode[])
    expect(md).toBe('**bold** and `code` and [link](https://example.com)')
  })

  it('renders bulleted, numbered and to_do lists with nesting', async () => {
    const nested = {
      ...block('bulleted_list_item', { rich_text: [richText('parent')] }),
      children: [block('bulleted_list_item', { rich_text: [richText('child')] })],
    }
    const md = notionBlocksToMarkdown([
      nested,
      block('numbered_list_item', { rich_text: [richText('one')] }),
      block('numbered_list_item', { rich_text: [richText('two')] }),
      block('to_do', { rich_text: [richText('done')], checked: true }),
      block('to_do', { rich_text: [richText('todo')], checked: false }),
    ] as NotionBlockNode[])
    expect(md).toBe('- parent\n  - child\n1. one\n2. two\n- [x] done\n- [ ] todo')
  })

  it('renders quote, callout, code and equation blocks', async () => {
    const md = notionBlocksToMarkdown([
      block('quote', { rich_text: [richText('wise words')] }),
      block('callout', {
        rich_text: [richText('note this')],
        icon: { type: 'emoji', emoji: '💡' },
      }),
      block('code', { rich_text: [richText('const a = 1')], language: 'typescript' }),
      block('equation', { expression: 'E = mc^2' }),
    ] as NotionBlockNode[])
    expect(md).toContain('> wise words')
    expect(md).toContain('> 💡 note this')
    expect(md).toContain('```typescript\nconst a = 1\n```')
    expect(md).toContain('$$\nE = mc^2\n$$')
  })

  it('renders tables as markdown tables', async () => {
    const table = {
      ...block('table', { table_width: 2, has_column_header: true }),
      children: [
        block('table_row', { cells: [[richText('h1')], [richText('h2')]] }),
        block('table_row', { cells: [[richText('a')], [richText('b')]] }),
      ],
    }
    const md = notionBlocksToMarkdown([table] as NotionBlockNode[])
    expect(md).toBe('| h1 | h2 |\n| --- | --- |\n| a | b |')
  })

  it('keeps every row as data when a table has no column header', async () => {
    const table = {
      ...block('table', { table_width: 2, has_column_header: false, has_row_header: true }),
      children: [
        block('table_row', { cells: [[richText('a')], [richText('b')]] }),
        block('table_row', { cells: [[richText('c')], [richText('d')]] }),
      ],
    }

    expect(notionBlocksToMarkdown([table] as NotionBlockNode[])).toBe(
      '|  |  |\n| --- | --- |\n| a | b |\n| c | d |',
    )
  })

  it('renders media blocks as links and images', async () => {
    const md = notionBlocksToMarkdown([
      block('image', {
        type: 'external',
        external: { url: 'https://img.example/x.png' },
        caption: [],
      }),
      block('bookmark', { url: 'https://example.com', caption: [richText('site')] }),
    ] as NotionBlockNode[])
    expect(md).toContain('![image](https://img.example/x.png)')
    expect(md).toContain('[site](https://example.com)')
  })

  it('replaces Notion-hosted media URLs with a stable readable placeholder', async () => {
    const first = notionBlocksToMarkdown([
      block('image', {
        type: 'file',
        file: { url: 'https://prod-files-secure.s3.us-west-2.amazonaws.com/first-signature' },
        caption: [richText('diagram')],
      }),
    ] as NotionBlockNode[])
    const second = notionBlocksToMarkdown([
      block('image', {
        type: 'file',
        file: { url: 'https://prod-files-secure.s3.us-west-2.amazonaws.com/second-signature' },
        caption: [richText('diagram')],
      }),
    ] as NotionBlockNode[])

    expect(first).toBe('Notion-hosted media: diagram (temporary link not saved)')
    expect(second).toBe(first)
    expect(computeContentHash(second)).toBe(computeContentHash(first))
  })

  it('renders child pages as unsynced placeholders and flattens columns', async () => {
    const columns = {
      ...block('column_list', {}),
      children: [
        {
          ...block('column', {}),
          children: [block('paragraph', { rich_text: [richText('in column')] })],
        },
      ],
    }
    const md = notionBlocksToMarkdown([
      block('child_page', { title: 'Sub Doc' }),
      columns,
    ] as NotionBlockNode[])
    expect(md).toContain('📄 Sub Doc (subpage, not synced)')
    expect(md).toContain('in column')
  })

  it('skips unsupported blocks', async () => {
    const md = notionBlocksToMarkdown([
      block('unsupported', {}),
      block('paragraph', { rich_text: [richText('kept')] }),
    ] as NotionBlockNode[])
    expect(md).toBe('kept')
  })
})

describe('fetchNotionDocByUrl', () => {
  it('shares one five-minute deadline across the entire fetch operation', async () => {
    const timeoutSpy = vi
      .spyOn(AbortSignal, 'timeout')
      .mockReturnValue(new AbortController().signal)
    const requestSignals: Array<AbortSignal | null | undefined> = []
    vi.stubGlobal(
      'fetch',
      vi.fn().mockImplementation((url: string, init?: RequestInit) => {
        requestSignals.push(init?.signal)
        if (url.includes('/pages/')) {
          return Promise.resolve(
            jsonResponse({
              properties: { title: { type: 'title', title: [richText('My Doc')] } },
            }),
          )
        }
        return Promise.resolve(jsonResponse({ results: [], has_more: false, next_cursor: null }))
      }),
    )

    await fetchNotionDocByUrl(`https://www.notion.so/${PAGE_ID_RAW}`, 'tok')

    expect(timeoutSpy).toHaveBeenCalledTimes(1)
    expect(timeoutSpy).toHaveBeenCalledWith(300_000)
    expect(requestSignals).toHaveLength(2)
    expect(requestSignals[0]).toBeInstanceOf(AbortSignal)
    expect(requestSignals[1]).toBe(requestSignals[0])
  })

  it('composes parse → title → blocks → markdown → hash', async () => {
    const fetchMock = vi.fn().mockImplementation((url: string) => {
      if (url.includes('/pages/')) {
        return Promise.resolve(
          jsonResponse({
            object: 'page',
            id: PAGE_ID,
            properties: { title: { type: 'title', title: [richText('My Doc')] } },
          }),
        )
      }
      return Promise.resolve(
        jsonResponse({
          results: [block('paragraph', { rich_text: [richText('hello world')] })],
          has_more: false,
          next_cursor: null,
        }),
      )
    })
    vi.stubGlobal('fetch', fetchMock)

    const result = await fetchNotionDocByUrl(
      `https://www.notion.so/myws/My-Doc-${PAGE_ID_RAW}`,
      'tok',
    )
    expect(result.pageId).toBe(PAGE_ID)
    expect(result.title).toBe('My Doc')
    expect(result.content).toBe('# My Doc\n\nhello world')
    expect(result.contentHash).toBe(computeContentHash(result.content))
  })
})
