import { Hono } from 'hono'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { asyncQuery } from '../../test/async-query.js'

type Mock = ReturnType<typeof vi.fn>

/**
 * A query builder that is also awaitable.
 *
 * Production no longer terminates a chain with `.get()` / `.all()`; it awaits
 * the builder, which resolves to a row array. The chain keeps both legacy
 * terminators so the per-test `nextChain({ get })` / `{ all }` configuration is
 * unchanged, and `asyncQuery` derives the resolved rows from whichever one the
 * test configured.
 */
function makeChain(): Record<string, Mock> & { get: Mock; all: Mock } {
  const get = vi.fn()
  const all = vi.fn()
  const chain = asyncQuery({ get, all }) as Record<string, Mock> & { get: Mock; all: Mock }
  for (const key of ['from', 'where', 'orderBy', 'limit', 'offset', 'leftJoin', 'groupBy']) {
    chain[key] = vi.fn(() => chain)
  }
  return chain
}

const dbSelect = vi.fn()
vi.mock('../../db/client.js', () => ({
  db: {
    select: (...args: unknown[]) => dbSelect(...args),
  },
}))

vi.mock('../../db/schema.js', () => ({
  agents: { id: 'agents.id', name: 'agents.name', createdAt: 'agents.createdAt' },
  auditLogs: { id: 'auditLogs.id', createdAt: 'auditLogs.createdAt' },
  mcpServers: { id: 'mcpServers.id', createdAt: 'mcpServers.createdAt' },
  providers: { id: 'providers.id', createdAt: 'providers.createdAt' },
  runSteps: { id: 'runSteps.id', runId: 'runSteps.runId' },
  runs: {
    id: 'runs.id',
    intent: 'runs.intent',
    status: 'runs.status',
    result: 'runs.result',
    initiatorAgentId: 'runs.initiatorAgentId',
    triggerSource: 'runs.triggerSource',
    createdAt: 'runs.createdAt',
    updatedAt: 'runs.updatedAt',
  },
  skillGroups: { id: 'skillGroups.id', createdAt: 'skillGroups.createdAt' },
  skills: { id: 'skills.id', createdAt: 'skills.createdAt' },
  users: {
    id: 'users.id',
    username: 'users.username',
    displayName: 'users.displayName',
    role: 'users.role',
    isActive: 'users.isActive',
    createdAt: 'users.createdAt',
  },
}))

const getAllSettingsMock = vi.fn()
vi.mock('../../lib/settings.js', () => ({
  getAllSettings: () => getAllSettingsMock(),
}))

const maskAgentSecretsMock = vi.fn(<T>(x: T) => ({ ...(x as object), _masked: true }))
vi.mock('../agents.js', () => ({
  maskAgentSecrets: (x: unknown) => maskAgentSecretsMock(x),
}))

import internalAdmin from '../internal-admin.js'

function nextChain(...returns: Array<{ get?: unknown; all?: unknown }>) {
  let i = 0
  dbSelect.mockImplementation(() => {
    const cfg = returns[i++] ?? {}
    const chain = makeChain()
    if ('get' in cfg) chain.get.mockReturnValue(cfg.get)
    if ('all' in cfg) chain.all.mockReturnValue(cfg.all)
    return chain
  })
}

beforeEach(() => {
  dbSelect.mockReset()
  getAllSettingsMock.mockReset()
  maskAgentSecretsMock.mockClear()
})

afterEach(() => {
  vi.restoreAllMocks()
})

function buildApp() {
  return new Hono().route('/internal', internalAdmin)
}

describe('routes/internal-admin', () => {
  it('GET /agents returns paginated agents with secrets masked', async () => {
    nextChain({ get: { count: 2 } }, { all: [{ id: 'agt_1' }, { id: 'agt_2' }] })
    const res = await buildApp().request('/internal/agents?page=1&pageSize=10')
    expect(res.status).toBe(200)
    const body = (await res.json()) as any
    expect(body.data).toEqual([
      { id: 'agt_1', _masked: true },
      { id: 'agt_2', _masked: true },
    ])
    expect(body.pagination).toEqual({ total: 2, page: 1, pageSize: 10, totalPages: 1 })
  })

  it('GET /agents clamps pageSize to 200', async () => {
    nextChain({ get: { count: 0 } }, { all: [] })
    const res = await buildApp().request('/internal/agents?pageSize=1000')
    const body = (await res.json()) as any
    expect(body.pagination.pageSize).toBe(200)
  })

  it('GET /agents/:id returns 404 when missing', async () => {
    nextChain({ get: undefined })
    const res = await buildApp().request('/internal/agents/agt_404')
    expect(res.status).toBe(404)
    expect((await res.json()) as any).toEqual({ error: 'Agent not found' })
  })

  it('GET /agents/:id returns the masked agent', async () => {
    nextChain({ get: { id: 'agt_1', apiKey: 'secret' } })
    const res = await buildApp().request('/internal/agents/agt_1')
    expect(res.status).toBe(200)
    const body = (await res.json()) as any
    expect(body.data).toEqual({ id: 'agt_1', apiKey: 'secret', _masked: true })
  })

  it('GET /runs supports filtering by agentId', async () => {
    nextChain(
      { get: { count: 1 } },
      { all: [{ id: 'run_1', status: 'completed', agentName: 'A' }] },
    )
    const res = await buildApp().request('/internal/runs?agentId=agt_1')
    expect(res.status).toBe(200)
    const body = (await res.json()) as any
    expect(body.data).toHaveLength(1)
    expect(body.pagination.total).toBe(1)
  })

  it('GET /runs/stats aggregates by status, today and duration', async () => {
    nextChain(
      {
        all: [
          { status: 'completed', cnt: 8 },
          { status: 'failed', cnt: 2 },
        ],
      },
      { get: { cnt: 3 } },
      { get: { avg: 4123.7 } },
    )
    const res = await buildApp().request('/internal/runs/stats')
    expect(res.status).toBe(200)
    const body = (await res.json()) as any
    expect(body).toEqual({
      total: 10,
      todayRuns: 3,
      avgDuration: 4124,
      successRate: 80,
      byStatus: { completed: 8, failed: 2 },
    })
  })

  it('GET /runs/stats falls back when no runs exist', async () => {
    nextChain({ all: [] }, { get: undefined }, { get: { avg: null } })
    const res = await buildApp().request('/internal/runs/stats')
    const body = (await res.json()) as any
    expect(body.total).toBe(0)
    expect(body.todayRuns).toBe(0)
    expect(body.avgDuration).toBe(0)
    expect(body.successRate).toBe(0)
  })

  it('GET /runs/:id returns 404 for missing', async () => {
    nextChain({ get: undefined })
    const res = await buildApp().request('/internal/runs/run_404')
    expect(res.status).toBe(404)
    expect((await res.json()) as any).toEqual({ error: 'Run not found' })
  })

  it('GET /runs/:id returns the run with its steps', async () => {
    nextChain(
      {
        get: {
          id: 'run_1',
          status: 'completed',
          executionMetadata: { oauthPreviousChatId: 'chat_internal' },
        },
      },
      { all: [{ id: 'step_1' }] },
    )
    const res = await buildApp().request('/internal/runs/run_1')
    expect(res.status).toBe(200)
    const body = (await res.json()) as any
    expect(body.data).toEqual({ id: 'run_1', status: 'completed', steps: [{ id: 'step_1' }] })
  })

  it.each([
    ['/internal/skills', { all: [{ id: 'skl_1' }] }, [{ id: 'skl_1' }]],
    ['/internal/skill-groups', { all: [{ id: 'skg_1' }] }, [{ id: 'skg_1' }]],
  ] as const)('lists from %s', async (path, chainCfg, expected) => {
    nextChain(chainCfg)
    const res = await buildApp().request(path)
    expect(res.status).toBe(200)
    const body = (await res.json()) as any
    expect(body.data).toEqual(expected)
  })

  it('GET /mcp-servers returns masked operational DTOs, never runtime credentials', async () => {
    nextChain({
      all: [
        {
          id: 'mcp_1',
          name: 'Remote MCP',
          type: 'http',
          url: 'https://user:pass@mcp.example.com/sse/private?token=query-secret',
          env: { CUSTOM_VALUE: 'hidden-env-secret' },
          headers: { 'X-Custom': 'hidden-header-secret' },
        },
      ],
    })

    const res = await buildApp().request('/internal/mcp-servers')
    const body = (await res.json()) as any
    const serialized = JSON.stringify(body)
    expect(body.data[0].url).toBe('https://mcp.example.com/********')
    expect(body.data[0].env).toEqual({ CUSTOM_VALUE: '********' })
    expect(body.data[0].headers).toEqual({ 'X-Custom': '********' })
    expect(serialized).not.toContain('query-secret')
    expect(serialized).not.toContain('hidden-env-secret')
    expect(serialized).not.toContain('hidden-header-secret')
  })

  it('GET /providers omits scripts, local paths, and arbitrary extension config', async () => {
    nextChain({
      all: [
        {
          id: 'prv_1',
          kind: 'codex',
          name: 'Codex',
          initScript: 'curl https://example.invalid/install?token=secret | sh',
          checkScript: 'secret-probe-command',
          skillsDir: '/private/skills',
          mcpConfigPath: '/private/mcp.json',
          config: { customCredential: 'hidden-provider-secret' },
        },
      ],
    })

    const res = await buildApp().request('/internal/providers')
    const body = (await res.json()) as any
    expect(body.data).toEqual([{ id: 'prv_1', kind: 'codex', name: 'Codex' }])
    expect(JSON.stringify(body)).not.toContain('hidden-provider-secret')
    expect(JSON.stringify(body)).not.toContain('secret-probe-command')
    expect(JSON.stringify(body)).not.toContain('/private/')
  })

  it.each([
    ['/internal/mcp-servers/x', 'MCP Server not found'],
    ['/internal/skills/x', 'Skill not found'],
    ['/internal/skill-groups/x', 'Skill group not found'],
    ['/internal/providers/x', 'Provider not found'],
  ] as const)('GET %s returns 404 when missing', async (path, error) => {
    nextChain({ get: undefined })
    const res = await buildApp().request(path)
    expect(res.status).toBe(404)
    expect((await res.json()) as any).toEqual({ error })
  })

  it('GET /settings returns a minimal operational map without secrets or storage paths', async () => {
    getAllSettingsMock.mockReturnValue({
      webhook: { enabled: 'true', type: 'feishu', url: 'https://hooks.example/secret' },
      artifacts: { retentionHours: '168', storagePath: '/private/artifacts' },
      sso: { oidcClientSecretEnc: 'encrypted-client-secret' },
      auth: { oauthDefaultRole: 'user' },
    })
    const res = await buildApp().request('/internal/settings')
    expect(res.status).toBe(200)
    const body = (await res.json()) as any
    // allowlist 语义：未登记的整个 category（这里的 sso）连同其密文一起被丢弃
    expect(body.data).toEqual({
      webhook: { enabled: 'true', type: 'feishu' },
      artifacts: { retentionHours: '168' },
      auth: { oauthDefaultRole: 'user' },
    })
    expect(JSON.stringify(body)).not.toContain('hooks.example')
    expect(JSON.stringify(body)).not.toContain('/private/artifacts')
    expect(JSON.stringify(body)).not.toContain('encrypted-client-secret')
  })

  it('GET /users returns the user list (no password fields)', async () => {
    nextChain({ all: [{ id: 'usr_1', username: 'admin', role: 'admin', isActive: true }] })
    const res = await buildApp().request('/internal/users')
    const body = (await res.json()) as any
    expect(body.data).toHaveLength(1)
    expect(body.data[0]).not.toHaveProperty('passwordHash')
  })

  it('GET /audit-logs returns paginated rows', async () => {
    nextChain({ get: { count: 1 } }, { all: [{ id: 'aud_1' }] })
    const res = await buildApp().request('/internal/audit-logs?page=1&pageSize=10')
    const body = (await res.json()) as any
    expect(body.data).toEqual([{ id: 'aud_1' }])
    expect(body.pagination).toEqual({ total: 1, page: 1, pageSize: 10, totalPages: 1 })
  })

  it('treats malformed page/pageSize as defaults across endpoints', async () => {
    nextChain({ get: { count: 0 } }, { all: [] })
    const res = await buildApp().request('/internal/audit-logs?page=foo&pageSize=bar')
    const body = (await res.json()) as any
    expect(body.pagination.page).toBe(1)
    expect(body.pagination.pageSize).toBe(50)
  })
})
