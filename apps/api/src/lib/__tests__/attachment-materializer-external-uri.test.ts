import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// 这套件专测 fetchExternalUri 的 DNS-rebinding 防护（把已校验 IP 钉进 undici dispatcher）。
// 它 mock 掉 node:dns/promises、undici 与 url-safety-core 的网络出口，因此单独成文件——
// 避免与主 materializer 套件的真实落盘测试互相污染 module mock。

const stagingRootHolder = { path: '' }
const homesRootHolder = { path: '' }

vi.mock('../settings.js', () => ({
  getAttachmentSettings: () => ({
    stagingPath: stagingRootHolder.path,
    stagingTtlHours: 24,
    maxFileSizeBytes: 10 * 1024 * 1024,
    maxFilesPerRequest: 10,
    allowedExtensions: new Set(['png', 'pdf', 'txt']),
  }),
}))

vi.mock('../attachment-access.js', () => ({
  recordAttachmentRefs: () => {},
}))

// DNS 解析可控：默认返回一个公网 IP；私网场景在用例里覆盖。
const dnsLookupMock = vi.fn()
vi.mock('node:dns/promises', () => ({
  lookup: (...args: unknown[]) => dnsLookupMock(...args),
}))

// safeFetch 返回一个最小 2xx 响应，body 是单块字节流。
const safeFetchMock = vi.fn()
vi.mock('../url-safety-core.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../url-safety-core.js')>()
  return {
    ...actual,
    safeFetch: (...args: unknown[]) => safeFetchMock(...args),
  }
})

// undici Agent 记录构造参数并暴露 close spy，验证 dispatcher 被钉住且被释放。
const undiciCloseSpy = vi.fn().mockResolvedValue(undefined)
const undiciCtorSpy = vi.fn()
vi.mock('undici', () => ({
  Agent: class {
    close = undiciCloseSpy
    constructor(opts: unknown) {
      undiciCtorSpy(opts)
    }
  },
}))

import { materializeAttachments, materializeForRun } from '../attachment-materializer.js'

function makeOkResponse(bytes: Buffer, contentType = 'image/png') {
  return {
    ok: true,
    status: 200,
    headers: { get: (k: string) => (k.toLowerCase() === 'content-type' ? contentType : null) },
    body: (async function* () {
      yield new Uint8Array(bytes)
    })(),
  }
}

beforeEach(() => {
  stagingRootHolder.path = mkdtempSync(join(tmpdir(), 'att-ext-stage-'))
  homesRootHolder.path = mkdtempSync(join(tmpdir(), 'att-ext-homes-'))
  process.env.A2WAVE_AGENT_HOMES_DIR = homesRootHolder.path
  dnsLookupMock.mockReset()
  safeFetchMock.mockReset()
  undiciCloseSpy.mockClear()
  undiciCtorSpy.mockClear()
})

afterEach(() => {
  delete process.env.A2WAVE_AGENT_HOMES_DIR
  vi.restoreAllMocks()
})

const baseOpts = {
  agentId: 'agt_ext',
  runId: 'run_ext',
  consumerId: 'usr_test',
  maxBytes: 10 * 1024 * 1024,
  maxCount: 10,
  allowedExtensions: new Set(['png', 'pdf']),
}

describe('fetchExternalUri DNS-rebinding 防护', () => {
  it('校验通过的公网域名：把已解析 IP 钉进 dispatcher 并在结束后 close', async () => {
    dnsLookupMock.mockResolvedValue([{ address: '93.184.216.34', family: 4 }])
    safeFetchMock.mockResolvedValue(makeOkResponse(Buffer.from('imgbytes')))

    const { attachments } = await materializeAttachments(
      [{ kind: 'uri', uri: 'https://example.com/pic.png', name: 'pic.png' }],
      baseOpts,
    )

    expect(attachments).toHaveLength(1)
    // dispatcher 被构造（含自定义 lookup），且 safeFetch 收到了它。
    expect(undiciCtorSpy).toHaveBeenCalledTimes(1)
    const fetchOpts = safeFetchMock.mock.calls[0][1] as {
      maxRedirects: number
      dispatcher: unknown
    }
    expect(fetchOpts.maxRedirects).toBe(0) // 不跟随重定向
    expect(fetchOpts.dispatcher).toBeDefined() // 钉住 IP 的 dispatcher
    // 自定义 lookup 只交出已校验 IP，绝不重新解析。
    const ctorArg = undiciCtorSpy.mock.calls[0][0] as {
      connect: {
        lookup: (h: string, o: unknown, cb: (e: null, a: string, f: number) => void) => void
      }
    }
    const cbSpy = vi.fn()
    ctorArg.connect.lookup('example.com', {}, cbSpy)
    expect(cbSpy).toHaveBeenCalledWith(null, '93.184.216.34', 4)
    // 结束后释放连接池，避免泄漏。
    expect(undiciCloseSpy).toHaveBeenCalledTimes(1)
  })

  it('解析到私网地址：拒绝抓取，不构造 dispatcher，不发起 fetch', async () => {
    dnsLookupMock.mockResolvedValue([{ address: '10.0.0.5', family: 4 }])

    const { attachments } = await materializeAttachments(
      [{ kind: 'uri', uri: 'https://rebind.internal/pic.png', name: 'pic.png' }],
      baseOpts,
    )

    expect(attachments).toHaveLength(0)
    expect(undiciCtorSpy).not.toHaveBeenCalled()
    expect(safeFetchMock).not.toHaveBeenCalled()
  })

  it('close 在 fetch 抛错时仍被调用（finally 释放）', async () => {
    dnsLookupMock.mockResolvedValue([{ address: '93.184.216.34', family: 4 }])
    safeFetchMock.mockRejectedValue(new Error('boom'))

    const { attachments } = await materializeAttachments(
      [{ kind: 'uri', uri: 'https://example.com/pic.png', name: 'pic.png' }],
      baseOpts,
    )

    expect(attachments).toHaveLength(0) // 单附件失败被跳过
    expect(undiciCloseSpy).toHaveBeenCalledTimes(1) // dispatcher 仍被释放
  })

  it('无扩展名的 URI 用 content-type 补扩展名，不被白名单误拒（review [P1]）', async () => {
    dnsLookupMock.mockResolvedValue([{ address: '93.184.216.34', family: 4 }])
    // URL 路径无扩展名（query-only），响应 content-type 为合法 image/png。
    safeFetchMock.mockResolvedValue(makeOkResponse(Buffer.from('imgbytes'), 'image/png'))

    const { attachments } = await materializeAttachments(
      [{ kind: 'uri', uri: 'https://cdn.example.com/download?id=123' }],
      baseOpts,
    )

    // 补出 .png 扩展名后通过白名单（png ∈ allowed）——不再被静默丢弃。
    expect(attachments).toHaveLength(1)
    expect(attachments[0].name.endsWith('.png')).toBe(true)
    expect(attachments[0].isImage).toBe(true)
  })

  it('无扩展名且 content-type 推不出允许扩展名 → 仍被白名单拒（fail-closed）', async () => {
    dnsLookupMock.mockResolvedValue([{ address: '93.184.216.34', family: 4 }])
    safeFetchMock.mockResolvedValue(makeOkResponse(Buffer.from('x'), 'application/x-unknown'))

    const { attachments } = await materializeAttachments(
      [{ kind: 'uri', uri: 'https://cdn.example.com/download?id=9' }],
      baseOpts,
    )

    expect(attachments).toHaveLength(0)
  })

  it('外部 uri 落盘后保留原始 uri（供 rerun 重新 materialize，review 回归）', async () => {
    // 外部 uri 附件无 staging token；若落盘 ref 不保留 uri，rerun 的 token-only 过滤会
    // 静默丢掉它（「带 URL 附件的 A2A run 重跑变纯文本」）。
    dnsLookupMock.mockResolvedValue([{ address: '93.184.216.34', family: 4 }])
    safeFetchMock.mockResolvedValue(makeOkResponse(Buffer.from('imgbytes')))

    const { attachments } = await materializeAttachments(
      [{ kind: 'uri', uri: 'https://example.com/pic.png', name: 'pic.png' }],
      baseOpts,
    )

    expect(attachments).toHaveLength(1)
    expect(attachments[0].uri).toBe('https://example.com/pic.png')
    expect(attachments[0].token).toBeUndefined()
  })

  it('materializeForRun 的审计 ref（runSteps.input.attachments）也带 uri', async () => {
    // 审计 ref 是 rerun 的读取源；这里断言 uri 贯穿到 materialized 输出。
    dnsLookupMock.mockResolvedValue([{ address: '93.184.216.34', family: 4 }])
    safeFetchMock.mockResolvedValue(makeOkResponse(Buffer.from('imgbytes')))

    const r = await materializeForRun({
      agentId: 'agt_ext',
      runId: 'run_ext_audit',
      message: 'look',
      sources: [{ kind: 'uri', uri: 'https://example.com/pic.png', name: 'pic.png' }],
      consumerId: 'agent:agt_ext',
    })

    expect(r.materialized).toHaveLength(1)
    expect(r.materialized[0]).toMatchObject({
      uri: 'https://example.com/pic.png',
      name: 'pic.png',
    })
    expect(r.materialized[0].token).toBeUndefined()
  })
})
