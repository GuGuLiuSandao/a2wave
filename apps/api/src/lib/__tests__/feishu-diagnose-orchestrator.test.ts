/**
 * Covers probeFeishuBotCredentials and runAgentFeishuDiagnose, which are not
 * exercised by feishu-diagnose.test.ts (that file focuses on the pure check
 * collectors).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const getExclusiveSlotHolderMock = vi.fn()
const normalizeFeishuConfigMock = vi.fn((cfg: unknown) => cfg)

vi.mock('../feishu-service.js', () => ({
  feishuConnectionManager: {
    getExclusiveSlotHolder: (id: string) => getExclusiveSlotHolderMock(id),
  },
  normalizeFeishuConfig: (cfg: unknown) => normalizeFeishuConfigMock(cfg),
}))

const ClientMock = vi.hoisted(() => ({ Client: vi.fn() }))

vi.mock('@larksuiteoapi/node-sdk', () => ({
  Client: ClientMock.Client,
  AppType: { SelfBuild: 'self-build' },
  LoggerLevel: { error: 0, warn: 1, info: 2 },
}))

import { probeFeishuBotCredentials, runAgentFeishuDiagnose } from '../feishu-diagnose.js'

function happyAgent(overrides: Record<string, unknown> = {}) {
  return {
    id: 'agt_1',
    publishChannels: ['feishu'],
    publishStatus: 'published',
    feishuConfig: {
      appId: 'app',
      appSecret: 'sec',
      replyContentType: 'text',
      groupTriggerOnAt: true,
      topicTriggerOnAt: true,
    },
    ...overrides,
  } as never
}

beforeEach(() => {
  getExclusiveSlotHolderMock.mockReset()
  normalizeFeishuConfigMock.mockReset().mockImplementation((cfg: unknown) => cfg)
  ClientMock.Client.mockReset()
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('probeFeishuBotCredentials', () => {
  it('returns ok-info when bot/v3/info responds', async () => {
    const request = vi.fn().mockResolvedValue({ ok: true })
    ClientMock.Client.mockImplementation(function (this: unknown) {
      return { request }
    })
    const result = await probeFeishuBotCredentials('a', 's')
    expect(result).toMatchObject({ id: 'feishu_bot_api_ok', severity: 'info' })
    expect(request).toHaveBeenCalledWith({ method: 'GET', url: '/open-apis/bot/v3/info' })
  })

  it('returns an error check when the request throws', async () => {
    const request = vi.fn().mockRejectedValue(new Error('forbidden'))
    ClientMock.Client.mockImplementation(function (this: unknown) {
      return { request }
    })
    const result = await probeFeishuBotCredentials('a', 's')
    expect(result).toMatchObject({ id: 'feishu_bot_api_failed', severity: 'error' })
  })
})

describe('runAgentFeishuDiagnose', () => {
  it('reports ok=true with sorted checks when config is sound and bot probe passes', async () => {
    const request = vi.fn().mockResolvedValue({})
    ClientMock.Client.mockImplementation(function (this: unknown) {
      return { request }
    })

    const result = await runAgentFeishuDiagnose({
      agent: happyAgent(),
      publishedFeishuAgentsSameOwner: [],
      wsRegistered: true,
      wsSocketOpen: true,
    })
    expect(result.ok).toBe(true)
    expect(result.meta.scope).toBe('current_api_process')
    expect(result.meta.checkedAt).toMatch(/T/)
    const order = { error: 0, warn: 1, info: 2 } as const
    const seq = result.checks.map((c) => order[c.severity])
    for (let i = 1; i < seq.length; i++) {
      expect(seq[i]).toBeGreaterThanOrEqual(seq[i - 1])
    }
  })

  it('skips bot probe when there are config errors (avoids needless network)', async () => {
    const result = await runAgentFeishuDiagnose({
      agent: happyAgent({ feishuConfig: { appId: '', appSecret: '' } }),
      publishedFeishuAgentsSameOwner: [],
      wsRegistered: false,
      wsSocketOpen: false,
    })
    expect(ClientMock.Client).not.toHaveBeenCalled()
    expect(result.ok).toBe(false)
    expect(result.checks.map((c) => c.id)).toEqual(
      expect.arrayContaining(['feishu_app_id_empty', 'feishu_app_secret_empty']),
    )
  })

  it('filters out ws_not_registered when the slot is held by a peer', async () => {
    getExclusiveSlotHolderMock.mockReturnValue('agt_other')
    // Block the network probe so the test stays offline.
    ClientMock.Client.mockImplementation(function (this: unknown) {
      return {
        request: vi.fn().mockRejectedValue(new Error('skip')),
      }
    })
    const result = await runAgentFeishuDiagnose({
      agent: happyAgent({ id: 'agt_1' }),
      publishedFeishuAgentsSameOwner: [],
      wsRegistered: false,
      wsSocketOpen: false,
    })
    const ids = result.checks.map((c) => c.id)
    expect(ids).toContain('feishu_app_id_held_by_peer')
    expect(ids).not.toContain('ws_not_registered')
  })

  it('still emits ok=true when bot probe is skipped because feishu channel is off', async () => {
    const result = await runAgentFeishuDiagnose({
      agent: happyAgent({ publishChannels: ['api'] }),
      publishedFeishuAgentsSameOwner: [],
      wsRegistered: false,
      wsSocketOpen: false,
    })
    expect(ClientMock.Client).not.toHaveBeenCalled()
    expect(result.ok).toBe(true)
  })
})
