import { afterEach, describe, expect, it, vi } from 'vitest'

const { fetchFeishuDocByUrlMock, fetchNotionDocByUrlMock } = vi.hoisted(() => ({
  fetchFeishuDocByUrlMock: vi.fn(),
  fetchNotionDocByUrlMock: vi.fn(),
}))

vi.mock('../feishu-doc-fetcher.js', () => ({
  fetchFeishuDocByUrl: fetchFeishuDocByUrlMock,
}))
vi.mock('../notion-doc-fetcher.js', () => ({
  fetchNotionDocByUrl: fetchNotionDocByUrlMock,
}))

import {
  REMOTE_KB_SOURCES,
  fetchRemoteKbContent,
  hasRemoteKbCredentials,
  isRemoteKbSource,
} from '../kb-remote-fetch.js'

afterEach(() => {
  vi.useRealTimers()
})

describe('isRemoteKbSource', () => {
  it('accepts feishu and notion, rejects upload and unknowns', async () => {
    expect(REMOTE_KB_SOURCES).toEqual(['feishu', 'notion'])
    expect(isRemoteKbSource('feishu')).toBe(true)
    expect(isRemoteKbSource('notion')).toBe(true)
    expect(isRemoteKbSource('upload')).toBe(false)
    expect(isRemoteKbSource('other')).toBe(false)
  })
})

describe('hasRemoteKbCredentials', () => {
  it('requires url + appId + appSecret for feishu docs', async () => {
    const base = { sourceType: 'feishu', feishuUrl: 'u', feishuAppId: 'a', feishuAppSecret: 's' }
    expect(hasRemoteKbCredentials(base)).toBe(true)
    expect(hasRemoteKbCredentials({ ...base, feishuUrl: null })).toBe(false)
    expect(hasRemoteKbCredentials({ ...base, feishuAppId: null })).toBe(false)
    expect(hasRemoteKbCredentials({ ...base, feishuAppSecret: null })).toBe(false)
  })

  it('requires url + token for notion docs', async () => {
    const base = { sourceType: 'notion', notionUrl: 'u', notionToken: 't' }
    expect(hasRemoteKbCredentials(base)).toBe(true)
    expect(hasRemoteKbCredentials({ ...base, notionUrl: null })).toBe(false)
    expect(hasRemoteKbCredentials({ ...base, notionToken: null })).toBe(false)
  })

  it('returns false for non-remote sources', async () => {
    expect(hasRemoteKbCredentials({ sourceType: 'upload' })).toBe(false)
  })
})

describe('fetchRemoteKbContent', () => {
  it('dispatches feishu docs to the feishu fetcher', async () => {
    fetchFeishuDocByUrlMock.mockResolvedValue({
      title: 'F',
      content: 'fc',
      contentHash: 'fh',
      token: 'tok',
      type: 'docx',
    })
    const result = await fetchRemoteKbContent({
      sourceType: 'feishu',
      feishuUrl: 'https://x.feishu.cn/docx/T',
      feishuAppId: 'app',
      feishuAppSecret: 'secret',
    })
    expect(fetchFeishuDocByUrlMock).toHaveBeenCalledWith(
      'https://x.feishu.cn/docx/T',
      'app',
      'secret',
    )
    expect(result).toEqual({ title: 'F', content: 'fc', contentHash: 'fh' })
  })

  it('dispatches notion docs to the notion fetcher', async () => {
    fetchNotionDocByUrlMock.mockResolvedValue({
      title: 'N',
      content: 'nc',
      contentHash: 'nh',
      pageId: 'pid',
    })
    const result = await fetchRemoteKbContent({
      sourceType: 'notion',
      notionUrl: 'https://www.notion.so/x',
      notionToken: 'tok',
    })
    expect(fetchNotionDocByUrlMock).toHaveBeenCalledWith('https://www.notion.so/x', 'tok')
    expect(result).toEqual({ title: 'N', content: 'nc', contentHash: 'nh' })
  })

  it('rejects docs with missing credentials or unsupported source types', async () => {
    await expect(fetchRemoteKbContent({ sourceType: 'notion', notionUrl: null })).rejects.toThrow()
    await expect(fetchRemoteKbContent({ sourceType: 'upload' })).rejects.toThrow()
  })

  it('times out a remote fetch that never settles', async () => {
    vi.useFakeTimers()
    fetchFeishuDocByUrlMock.mockReturnValue(new Promise(() => {}))

    // Deliberately NOT awaited here: the underlying fetcher never settles, so
    // only the timeout can resolve this promise.
    const pending = fetchRemoteKbContent({
      sourceType: 'feishu',
      feishuUrl: 'https://x.feishu.cn/docx/T',
      feishuAppId: 'app',
      feishuAppSecret: 'secret',
    })
    const rejection = expect(pending).rejects.toThrow(/timed out/i)
    await Promise.resolve()
    expect(vi.getTimerCount()).toBeGreaterThan(0)

    await vi.advanceTimersByTimeAsync(5 * 60 * 1000)
    await rejection
  })
})
