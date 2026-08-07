import { describe, expect, it, vi } from 'vitest'

vi.mock('../logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}))

const { ClientMock, httpRequestMock } = vi.hoisted(() => ({
  ClientMock: vi.fn(),
  httpRequestMock: vi.fn(),
}))
vi.mock('@larksuiteoapi/node-sdk', () => ({
  Client: ClientMock,
  AppType: { SelfBuild: 'self-build' },
  defaultHttpInstance: {
    request: (...args: unknown[]) => httpRequestMock(...args),
  },
}))

import {
  computeContentHash,
  createFeishuClient,
  fetchFeishuDocByUrl,
  fetchFeishuDocContent,
  parseFeishuDocUrl,
} from '../feishu-doc-fetcher.js'

describe('parseFeishuDocUrl', () => {
  it('parses a docx URL', async () => {
    expect(parseFeishuDocUrl('https://example.feishu.cn/docx/TOK123')).toEqual({
      token: 'TOK123',
      type: 'docx',
    })
  })

  it('parses a wiki URL on larksuite.com', async () => {
    expect(parseFeishuDocUrl('https://example.larksuite.com/wiki/WTOK')).toEqual({
      token: 'WTOK',
      type: 'wiki',
    })
  })

  it('rejects an unsupported document type', async () => {
    expect(() => parseFeishuDocUrl('https://example.feishu.cn/sheets/X')).toThrow(
      /Unsupported Feishu document type/,
    )
  })

  it('rejects a URL without enough path parts', async () => {
    expect(() => parseFeishuDocUrl('https://example.feishu.cn/docx')).toThrow(/Invalid Feishu/)
  })
})

describe('createFeishuClient', () => {
  it('passes the credentials and a bounded transport to the lark Client', async () => {
    ClientMock.mockClear()
    createFeishuClient('app', 'secret')
    expect(ClientMock).toHaveBeenCalledTimes(1)
    expect(ClientMock).toHaveBeenCalledWith({
      appId: 'app',
      appSecret: 'secret',
      appType: 'self-build',
      httpInstance: expect.objectContaining({ request: expect.any(Function) }),
    })

    const httpInstance = ClientMock.mock.calls[0]?.[0].httpInstance
    await httpInstance.request({ url: 'https://open.feishu.cn/test', timeout: 0 })
    expect(httpRequestMock).toHaveBeenCalledWith(
      expect.objectContaining({ url: 'https://open.feishu.cn/test', timeout: 60_000 }),
    )
  })
})

describe('computeContentHash', () => {
  it('produces a stable sha-256 hex digest', async () => {
    expect(computeContentHash('abc')).toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    )
    expect(computeContentHash('abc')).toBe(computeContentHash('abc'))
    expect(computeContentHash('abcd')).not.toBe(computeContentHash('abc'))
  })
})

describe('fetchFeishuDocContent', () => {
  it('reads docx raw content directly when type=docx', async () => {
    const rawContent = vi.fn().mockResolvedValue({ data: { content: 'Title line\nbody' } })
    const client = { docx: { document: { rawContent } } } as never
    const result = await fetchFeishuDocContent(client, 'tok', 'docx')
    expect(result).toEqual({ title: 'Title line', content: 'Title line\nbody' })
    expect(rawContent).toHaveBeenCalledWith({ path: { document_id: 'tok' }, params: { lang: 0 } })
  })

  it('resolves wiki node to its obj_token before fetching', async () => {
    const getNode = vi.fn().mockResolvedValue({ data: { node: { obj_token: 'real-tok' } } })
    const rawContent = vi.fn().mockResolvedValue({ data: { content: 'hello' } })
    const client = {
      wiki: { space: { getNode } },
      docx: { document: { rawContent } },
    } as never
    await fetchFeishuDocContent(client, 'wiki-tok', 'wiki')
    expect(getNode).toHaveBeenCalledWith({ params: { token: 'wiki-tok' } })
    expect(rawContent).toHaveBeenCalledWith({
      path: { document_id: 'real-tok' },
      params: { lang: 0 },
    })
  })

  it('falls back to "Untitled" when content is empty', async () => {
    const rawContent = vi.fn().mockResolvedValue({ data: { content: '' } })
    const client = { docx: { document: { rawContent } } } as never
    const result = await fetchFeishuDocContent(client, 'tok', 'docx')
    expect(result).toEqual({ title: 'Untitled', content: '' })
  })

  it('maps the 99991672 (permission) error to a Chinese hint', async () => {
    const rawContent = vi
      .fn()
      .mockRejectedValue({ response: { data: { code: 99991672, msg: 'need [docx:read]' } } })
    const client = { docx: { document: { rawContent } } } as never
    await expect(fetchFeishuDocContent(client, 'tok', 'docx')).rejects.toThrow(
      /飞书应用权限不足.*docx:read/,
    )
  })

  it('maps the 99991668 (invalid credential) error', async () => {
    const rawContent = vi
      .fn()
      .mockRejectedValue({ response: { data: { code: 99991668, msg: '' } } })
    const client = { docx: { document: { rawContent } } } as never
    await expect(fetchFeishuDocContent(client, 'tok', 'docx')).rejects.toThrow(/飞书应用凭证无效/)
  })

  it('maps the 99991663 (token expired) error', async () => {
    const rawContent = vi
      .fn()
      .mockRejectedValue({ response: { data: { code: 99991663, msg: '' } } })
    const client = { docx: { document: { rawContent } } } as never
    await expect(fetchFeishuDocContent(client, 'tok', 'docx')).rejects.toThrow(/飞书访问令牌过期/)
  })

  it('uses the original error message when no specific code matches', async () => {
    const rawContent = vi.fn().mockRejectedValue(new Error('network down'))
    const client = { docx: { document: { rawContent } } } as never
    await expect(fetchFeishuDocContent(client, 'tok', 'docx')).rejects.toThrow(/network down/)
  })

  it('formats other feishu codes with their msg', async () => {
    const rawContent = vi
      .fn()
      .mockRejectedValue({ response: { data: { code: 1234, msg: 'oops' } } })
    const client = { docx: { document: { rawContent } } } as never
    await expect(fetchFeishuDocContent(client, 'tok', 'docx')).rejects.toThrow(
      /飞书 API 错误 \(1234\): oops/,
    )
  })
})

describe('fetchFeishuDocByUrl', () => {
  it('composes parse → client → fetch → hash into one shot', async () => {
    const rawContent = vi.fn().mockResolvedValue({ data: { content: 'My doc\nbody' } })
    ClientMock.mockImplementation(function (this: unknown) {
      return { docx: { document: { rawContent } } }
    })
    const result = await fetchFeishuDocByUrl('https://example.feishu.cn/docx/TOK', 'app', 'secret')
    expect(result.token).toBe('TOK')
    expect(result.type).toBe('docx')
    expect(result.title).toBe('My doc')
    expect(result.content).toBe('My doc\nbody')
    expect(result.contentHash).toBe(computeContentHash('My doc\nbody'))
  })
})
