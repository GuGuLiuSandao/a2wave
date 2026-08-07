import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const savedInternalAdminToken = process.env.A2WAVE_INTERNAL_ADMIN_TOKEN

beforeEach(() => {
  vi.restoreAllMocks()
  vi.resetModules()
  process.env.A2WAVE_INTERNAL_ADMIN_TOKEN = 'process-scoped-admin-token'
})

afterEach(() => {
  if (savedInternalAdminToken === undefined) {
    Reflect.deleteProperty(process.env, 'A2WAVE_INTERNAL_ADMIN_TOKEN')
  } else {
    process.env.A2WAVE_INTERNAL_ADMIN_TOKEN = savedInternalAdminToken
  }
})

function mockFetch(response: { ok: boolean; status?: number; body?: unknown }) {
  globalThis.fetch = vi.fn().mockResolvedValue({
    ok: response.ok,
    status: response.status ?? (response.ok ? 200 : 500),
    json: () => Promise.resolve(response.body),
    text: () =>
      Promise.resolve(
        typeof response.body === 'string' ? response.body : JSON.stringify(response.body ?? ''),
      ),
  }) as unknown as typeof fetch
}

describe('a2wave-platform-admin tool handlers', () => {
  it('module exports startServer function', async () => {
    const mod = await import('../a2wave-platform-admin.js')
    expect(typeof mod.startServer).toBe('function')
  })

  it('listAgents calls /api/internal/admin/agents with correct URL', async () => {
    const agents = [{ id: 'agt_1', name: 'Agent A' }]
    mockFetch({ ok: true, body: { data: agents, pagination: { total: 1 } } })

    const { listAgents } = await import('../a2wave-platform-admin.js')
    const result = await listAgents({ page: 2, pageSize: 10 })

    expect(globalThis.fetch).toHaveBeenCalledTimes(1)
    const calledUrl = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0][0] as string
    expect(calledUrl).toContain('/api/internal/admin/agents')
    expect(calledUrl).toContain('page=2')
    expect(calledUrl).toContain('pageSize=10')
    const calledInit = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0][1] as {
      headers: Record<string, string>
    }
    expect(calledInit.headers['x-a2wave-internal-admin-token']).toBe('process-scoped-admin-token')
    expect(result.content[0].text).toContain('agt_1')
  })

  it('getRunStats calls /api/internal/admin/runs/stats', async () => {
    mockFetch({ ok: true, body: { total: 100, todayRuns: 5, byStatus: {} } })

    const { getRunStats } = await import('../a2wave-platform-admin.js')
    const result = await getRunStats()

    expect(globalThis.fetch).toHaveBeenCalledTimes(1)
    const calledUrl = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0][0] as string
    expect(calledUrl).toContain('/api/internal/admin/runs/stats')
    expect(result.content[0].text).toContain('100')
  })

  it('getPlatformOverview calls multiple internal admin endpoints', async () => {
    mockFetch({ ok: true, body: { data: [], pagination: { total: 0 } } })

    const { getPlatformOverview } = await import('../a2wave-platform-admin.js')
    await getPlatformOverview()

    const calls = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls
    expect(calls.length).toBeGreaterThanOrEqual(6)
    const urls = calls.map((c: unknown[]) => c[0] as string)
    expect(urls.some((u: string) => u.includes('/api/internal/admin/agents'))).toBe(true)
    expect(urls.some((u: string) => u.includes('/api/internal/admin/runs/stats'))).toBe(true)
    expect(urls.some((u: string) => u.includes('/api/internal/admin/mcp-servers'))).toBe(true)
  })

  it('fetchJson throws on non-ok response', async () => {
    mockFetch({ ok: false, status: 500, body: 'Internal Server Error' })

    const { listAgents } = await import('../a2wave-platform-admin.js')
    await expect(listAgents({})).rejects.toThrow('HTTP 500')
  })
})
