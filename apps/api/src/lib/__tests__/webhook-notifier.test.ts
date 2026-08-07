import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// --- Hoisted mocks ---

const mockGetCategorySettings = vi.hoisted(() => vi.fn())
const mockSafePublicFetch = vi.hoisted(() => vi.fn())

vi.mock('../../env.js', () => ({
  env: { TRUSTED_IMPORT_HOSTS: '' },
}))

vi.mock('../settings.js', () => ({
  getCategorySettings: mockGetCategorySettings,
}))

vi.mock('../logger.js', () => ({
  logger: { warn: vi.fn(), error: vi.fn(), info: vi.fn() },
}))

// The notifier sends through safePublicFetch (resolve-pin + no-redirect SSRF
// guard). Mock only that call so these tests drive retry/format logic without
// real DNS; assertSafePublicUrl (the URL-literal pre-check) stays real.
vi.mock('../url-safety.js', async () => {
  const actual = await vi.importActual<typeof import('../url-safety.js')>('../url-safety.js')
  return { ...actual, safePublicFetch: mockSafePublicFetch }
})

import { UnsafeUrlError } from '../url-safety.js'
import { notifyRunError, notifyScmSyncError, sendWebhookTest } from '../webhook-notifier.js'

// ----------------------------------------------------------------
// Helpers
// ----------------------------------------------------------------

const defaultParams = {
  agentId: 'agt_001',
  agentName: 'test-agent',
  runId: 'run_001',
  errorMsg: 'Execution failed',
  errorTime: new Date('2024-01-01T12:00:00.000Z'),
}

function makeSettings(overrides: Record<string, string> = {}) {
  return {
    enabled: 'true',
    url: 'https://example.com/hook',
    type: 'custom',
    maxRetries: '3',
    ...overrides,
  }
}

/** Replace setTimeout with an immediate executor; returns a restore function. */
function mockImmediateTimers(delays?: number[]) {
  const spy = vi.spyOn(globalThis, 'setTimeout').mockImplementation((fn, delay) => {
    delays?.push(delay as number)
    if (typeof fn === 'function') fn()
    return 0 as unknown as ReturnType<typeof setTimeout>
  })
  return () => spy.mockRestore()
}

// ----------------------------------------------------------------
// notifyRunError
// ----------------------------------------------------------------

describe('notifyRunError', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  // --- early-exit guards ---

  it('skips when disabled', async () => {
    mockGetCategorySettings.mockReturnValue(makeSettings({ enabled: 'false' }))
    await notifyRunError(defaultParams)
    expect(mockSafePublicFetch).not.toHaveBeenCalled()
  })

  it('skips when url is empty', async () => {
    mockGetCategorySettings.mockReturnValue(makeSettings({ url: '' }))
    await notifyRunError(defaultParams)
    expect(mockSafePublicFetch).not.toHaveBeenCalled()
  })

  // --- message format ---

  it('formats feishu post message correctly', async () => {
    mockGetCategorySettings.mockReturnValue(
      makeSettings({ type: 'feishu', url: 'https://feishu.com/hook' }),
    )
    mockSafePublicFetch.mockResolvedValueOnce({ ok: true } as Response)

    await notifyRunError(defaultParams)

    expect(mockSafePublicFetch).toHaveBeenCalledOnce()
    const [url, options] = mockSafePublicFetch.mock.calls[0]
    expect(url).toBe('https://feishu.com/hook')
    const body = JSON.parse((options as RequestInit).body as string)
    expect(body.msg_type).toBe('post')
    expect(body.content.post.zh_cn.title).toBe('Agent 运行错误')
    const rows = body.content.post.zh_cn.content
    expect(rows[0][0].text).toContain('12:00:00')
    expect(rows[1][0].text).toContain('test-agent')
    expect(rows[1][0].text).toContain('agt_001')
    expect(rows[2][0].text).toContain('run_001')
    expect(rows[3][0].text).toContain('Execution failed')
  })

  it('formats custom json body correctly', async () => {
    mockGetCategorySettings.mockReturnValue(
      makeSettings({ type: 'custom', url: 'https://custom.com/hook' }),
    )
    mockSafePublicFetch.mockResolvedValueOnce({ ok: true } as Response)

    await notifyRunError(defaultParams)

    const [url, options] = mockSafePublicFetch.mock.calls[0]
    expect(url).toBe('https://custom.com/hook')
    const body = JSON.parse((options as RequestInit).body as string)
    expect(body.event).toBe('run.failed')
    expect(body.timestamp).toBe('2024-01-01T12:00:00.000Z')
    expect(body.agent).toEqual({ id: 'agt_001', name: 'test-agent' })
    expect(body.run).toEqual({ id: 'run_001' })
    expect(body.error).toBe('Execution failed')
  })

  it('sends POST with Content-Type application/json', async () => {
    mockGetCategorySettings.mockReturnValue(makeSettings())
    mockSafePublicFetch.mockResolvedValueOnce({ ok: true } as Response)

    await notifyRunError(defaultParams)

    const [, options] = mockSafePublicFetch.mock.calls[0]
    expect((options as RequestInit).method).toBe('POST')
    expect(((options as RequestInit).headers as Record<string, string>)['Content-Type']).toBe(
      'application/json',
    )
  })

  // --- SSRF handling ---

  it('stops immediately (no retry) when the SSRF guard rejects the URL', async () => {
    mockGetCategorySettings.mockReturnValue(makeSettings({ maxRetries: '5' }))
    // A rebinding / blocked target surfaces as UnsafeUrlError from safePublicFetch.
    mockSafePublicFetch.mockRejectedValue(new UnsafeUrlError('blocked', 'private address'))
    const restore = mockImmediateTimers()

    await notifyRunError(defaultParams)

    // Terminal: retrying the same blocked URL is pointless, so only one attempt.
    expect(mockSafePublicFetch).toHaveBeenCalledTimes(1)
    restore()
  })

  // --- retry logic ---

  it('retries the configured number of times on non-ok response', async () => {
    mockGetCategorySettings.mockReturnValue(makeSettings({ maxRetries: '3' }))
    mockSafePublicFetch.mockResolvedValue({ ok: false, status: 500 } as Response)
    const restore = mockImmediateTimers()

    await notifyRunError(defaultParams)

    expect(mockSafePublicFetch).toHaveBeenCalledTimes(3)
    restore()
  })

  it('enforces minimum of 3 retries even when setting is lower', async () => {
    mockGetCategorySettings.mockReturnValue(makeSettings({ maxRetries: '1' }))
    mockSafePublicFetch.mockResolvedValue({ ok: false, status: 500 } as Response)
    const restore = mockImmediateTimers()

    await notifyRunError(defaultParams)

    expect(mockSafePublicFetch).toHaveBeenCalledTimes(3)
    restore()
  })

  it('enforces maximum of 10 retries even when setting is higher', async () => {
    mockGetCategorySettings.mockReturnValue(makeSettings({ maxRetries: '20' }))
    mockSafePublicFetch.mockResolvedValue({ ok: false, status: 500 } as Response)
    const restore = mockImmediateTimers()

    await notifyRunError(defaultParams)

    expect(mockSafePublicFetch).toHaveBeenCalledTimes(10)
    restore()
  })

  it('stops retrying immediately after a successful response', async () => {
    mockGetCategorySettings.mockReturnValue(makeSettings({ maxRetries: '5' }))
    mockSafePublicFetch
      .mockResolvedValueOnce({ ok: false, status: 500 } as Response)
      .mockResolvedValueOnce({ ok: true } as Response)
    const restore = mockImmediateTimers()

    await notifyRunError(defaultParams)

    expect(mockSafePublicFetch).toHaveBeenCalledTimes(2)
    restore()
  })

  it('retries on network error (safePublicFetch throws)', async () => {
    mockGetCategorySettings.mockReturnValue(makeSettings({ maxRetries: '3' }))
    mockSafePublicFetch.mockRejectedValue(new Error('ECONNREFUSED'))
    const restore = mockImmediateTimers()

    await notifyRunError(defaultParams)

    expect(mockSafePublicFetch).toHaveBeenCalledTimes(3)
    restore()
  })

  it('applies exponential backoff between retries', async () => {
    mockGetCategorySettings.mockReturnValue(makeSettings({ maxRetries: '3' }))
    mockSafePublicFetch.mockResolvedValue({ ok: false, status: 500 } as Response)
    const delays: number[] = []
    const restore = mockImmediateTimers(delays)

    await notifyRunError(defaultParams)

    // attempt 0: no sleep
    // attempt 1: 2^1 * 1000 = 2000 ms
    // attempt 2: 2^2 * 1000 = 4000 ms
    expect(delays).toEqual([2000, 4000])
    restore()
  })
})

// ----------------------------------------------------------------
// notifyScmSyncError
// ----------------------------------------------------------------

const defaultScmParams = {
  sourceId: 'scm_001',
  sourceName: 'my-repo',
  errorMsg: 'Git clone failed',
  errorTime: new Date('2024-06-01T08:00:00.000Z'),
}

describe('notifyScmSyncError', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('skips when disabled', async () => {
    mockGetCategorySettings.mockReturnValue(makeSettings({ enabled: 'false' }))
    await notifyScmSyncError(defaultScmParams)
    expect(mockSafePublicFetch).not.toHaveBeenCalled()
  })

  it('skips when url is empty', async () => {
    mockGetCategorySettings.mockReturnValue(makeSettings({ url: '' }))
    await notifyScmSyncError(defaultScmParams)
    expect(mockSafePublicFetch).not.toHaveBeenCalled()
  })

  it('formats feishu message correctly for scm sync failure', async () => {
    mockGetCategorySettings.mockReturnValue(
      makeSettings({ type: 'feishu', url: 'https://feishu.com/hook' }),
    )
    mockSafePublicFetch.mockResolvedValueOnce({ ok: true } as Response)

    await notifyScmSyncError(defaultScmParams)

    const body = JSON.parse((mockSafePublicFetch.mock.calls[0][1] as RequestInit).body as string)
    expect(body.msg_type).toBe('post')
    expect(body.content.post.zh_cn.title).toBe('代码源同步失败')
    const rows = body.content.post.zh_cn.content
    expect(rows[0][0].text).toContain('08:00:00')
    expect(rows[1][0].text).toContain('my-repo')
    expect(rows[1][0].text).toContain('scm_001')
    expect(rows[2][0].text).toContain('Git clone failed')
  })

  it('formats custom json body with event scm.sync.failed', async () => {
    mockGetCategorySettings.mockReturnValue(
      makeSettings({ type: 'custom', url: 'https://custom.com/hook' }),
    )
    mockSafePublicFetch.mockResolvedValueOnce({ ok: true } as Response)

    await notifyScmSyncError(defaultScmParams)

    const body = JSON.parse((mockSafePublicFetch.mock.calls[0][1] as RequestInit).body as string)
    expect(body.event).toBe('scm.sync.failed')
    expect(body.timestamp).toBe('2024-06-01T08:00:00.000Z')
    expect(body.source).toEqual({ id: 'scm_001', name: 'my-repo' })
    expect(body.error).toBe('Git clone failed')
  })

  it('retries the configured number of times on failure', async () => {
    mockGetCategorySettings.mockReturnValue(makeSettings({ maxRetries: '3' }))
    mockSafePublicFetch.mockResolvedValue({ ok: false, status: 500 } as Response)
    const restore = mockImmediateTimers()

    await notifyScmSyncError(defaultScmParams)

    expect(mockSafePublicFetch).toHaveBeenCalledTimes(3)
    restore()
  })
})

// ----------------------------------------------------------------
// sendWebhookTest
// ----------------------------------------------------------------

describe('sendWebhookTest', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('returns ok:true on 200', async () => {
    mockSafePublicFetch.mockResolvedValueOnce({ ok: true, status: 200 } as Response)
    const result = await sendWebhookTest('https://example.com/hook', 'feishu')
    expect(result).toEqual({ ok: true })
  })

  it('returns ok:false with status on non-ok response', async () => {
    mockSafePublicFetch.mockResolvedValueOnce({ ok: false, status: 404 } as Response)
    const result = await sendWebhookTest('https://example.com/hook', 'custom')
    expect(result).toEqual({ ok: false, status: 404, error: 'HTTP 404' })
  })

  it('returns ok:false with error message on network failure', async () => {
    mockSafePublicFetch.mockRejectedValueOnce(new Error('fetch failed'))
    const result = await sendWebhookTest('https://example.com/hook', 'feishu')
    expect(result.ok).toBe(false)
    expect(result.error).toBe('fetch failed')
  })

  it('returns a blocked error and never fetches when the URL is private (pre-check)', async () => {
    // assertSafePublicUrl is real here — a private literal is rejected before any send.
    const result = await sendWebhookTest('http://169.254.169.254/latest/meta-data/', 'custom')
    expect(result.ok).toBe(false)
    expect(result.error).toMatch(/blocked/i)
    expect(mockSafePublicFetch).not.toHaveBeenCalled()
  })

  it('surfaces an SSRF rejection from safePublicFetch as a blocked error', async () => {
    // Rebinding is only caught at resolve-time inside safePublicFetch.
    mockSafePublicFetch.mockRejectedValueOnce(new UnsafeUrlError('blocked', 'private address'))
    const result = await sendWebhookTest('https://rebind.example.com/hook', 'custom')
    expect(result.ok).toBe(false)
    expect(result.error).toMatch(/blocked/i)
  })

  it('sends feishu format for type=feishu', async () => {
    mockSafePublicFetch.mockResolvedValueOnce({ ok: true } as Response)
    await sendWebhookTest('https://example.com/hook', 'feishu')
    const body = JSON.parse((mockSafePublicFetch.mock.calls[0][1] as RequestInit).body as string)
    expect(body.msg_type).toBe('post')
  })

  it('sends custom format for type=custom', async () => {
    mockSafePublicFetch.mockResolvedValueOnce({ ok: true } as Response)
    await sendWebhookTest('https://example.com/hook', 'custom')
    const body = JSON.parse((mockSafePublicFetch.mock.calls[0][1] as RequestInit).body as string)
    expect(body.event).toBe('run.failed')
  })

  it('does not retry on failure', async () => {
    mockSafePublicFetch.mockResolvedValue({ ok: false, status: 500 } as Response)
    await sendWebhookTest('https://example.com/hook', 'custom')
    expect(mockSafePublicFetch).toHaveBeenCalledTimes(1)
  })
})
