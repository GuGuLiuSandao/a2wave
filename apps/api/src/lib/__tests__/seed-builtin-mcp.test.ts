import { beforeEach, describe, expect, it, vi } from 'vitest'

import { asyncQuery } from '../../test/async-query.js'

const envMock = vi.hoisted(() => ({
  PORT: 3502,
  NODE_ENV: 'development',
  ALLOW_PRIVATE_ROUTE_TARGETS: true,
  TRUSTED_A2A_ROUTE_HOSTS: 'agents.internal.example',
  TRUSTED_MCP_HOSTS: 'mcp.internal.example',
}))

// Mock db and env before importing
const mockGet = vi.fn()
const mockRun = vi.fn()
const mockValues = vi.fn(() => asyncQuery({ run: mockRun }))
const mockInsert = vi.fn(() => ({ values: mockValues }))
const mockSet = vi.fn(() => ({ where: vi.fn(() => asyncQuery({ run: mockRun })) }))
const mockUpdate = vi.fn(() => ({ set: mockSet }))
const mockWhere = vi.fn(() => asyncQuery({ get: mockGet }))
const mockFrom = vi.fn(() => ({ where: mockWhere }))
const mockSelect = vi.fn(() => ({ from: mockFrom }))

vi.mock('../../db/client.js', () => ({
  db: {
    select: () => mockSelect(),
    insert: () => mockInsert(),
    update: () => mockUpdate(),
  },
}))

vi.mock('../../db/schema.js', () => ({
  mcpServers: { name: 'name', id: 'id', userId: 'user_id' },
}))

// Capture the SQL predicate structure so tests can assert HOW the seeder queries,
// not merely THAT it queried. Each operator returns an introspectable marker.
vi.mock('drizzle-orm', () => ({
  eq: (col: unknown, val: unknown) => ({ op: 'eq', col, val }),
  and: (...conds: unknown[]) => ({ op: 'and', conds }),
  isNull: (col: unknown) => ({ op: 'isNull', col }),
}))

vi.mock('../id.js', () => ({
  createId: (prefix: string) => `${prefix}_test123`,
}))

vi.mock('../logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}))

vi.mock('../../env.js', () => ({
  env: envMock,
}))

describe('seed-builtin-mcp', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    envMock.ALLOW_PRIVATE_ROUTE_TARGETS = true
  })

  it('classifies only the system-owned platform-admin row as control-plane-only', async () => {
    const { isControlPlaneOnlyBuiltinMcp } = await import('../seed-builtin-mcp.js')

    expect(isControlPlaneOnlyBuiltinMcp('a2wave-platform-admin', null)).toBe(true)
    expect(isControlPlaneOnlyBuiltinMcp('a2wave-platform-admin', 'usr_admin')).toBe(false)
    expect(isControlPlaneOnlyBuiltinMcp('a2wave-agent-router', null)).toBe(false)
  })

  it('inserts built-in MCP records when they do not exist', async () => {
    mockGet.mockReturnValue(undefined)

    const { seedBuiltinMcpServers } = await import('../seed-builtin-mcp.js')
    await seedBuiltinMcpServers()

    expect(mockInsert).toHaveBeenCalledTimes(2)
    expect(mockValues).toHaveBeenCalledWith(
      expect.objectContaining({
        id: 'mcp_test123',
        name: 'a2wave-agent-router',
        type: 'stdio',
        isEnabled: true,
        usageScope: 'all-users',
        userId: null,
      }),
    )
    expect(mockValues).toHaveBeenCalledWith(
      expect.objectContaining({
        name: 'a2wave-platform-admin',
        type: 'stdio',
        isEnabled: true,
        usageScope: 'admin-only',
        userId: null,
      }),
    )
  })

  it('updates built-in MCP records when they already exist', async () => {
    mockGet.mockReturnValue({ id: 'mcp_existing', name: 'a2wave-agent-router' })

    const { seedBuiltinMcpServers } = await import('../seed-builtin-mcp.js')
    await seedBuiltinMcpServers()

    expect(mockUpdate).toHaveBeenCalledTimes(2)
    // Re-asserts type (a same-named user row must never diverge type) + isEnabled.
    expect(mockSet).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'stdio',
        isEnabled: true,
      }),
    )
  })

  it('looks up the builtin scoped to the SYSTEM row (name AND userId IS NULL), never by name alone', async () => {
    // Security: a non-admin could create a same-named private row. The seeder must
    // match only the system builtin (userId IS NULL) so it neither promotes the
    // user's row nor treats it as "the builtin exists". Assert the actual predicate,
    // so this test FAILS if the seeder regresses to matching by name alone.
    mockGet.mockReturnValue(undefined)
    const { seedBuiltinMcpServers } = await import('../seed-builtin-mcp.js')
    await seedBuiltinMcpServers()

    expect(mockWhere).toHaveBeenCalled()
    for (const call of mockWhere.mock.calls as unknown as Array<
      [{ op: string; conds?: unknown[] }]
    >) {
      const cond = call[0]
      // Must be an `and(...)` of a name-eq AND a userId isNull — not a lone eq(name).
      expect(cond.op, 'select must use and(name, isNull(userId))').toBe('and')
      const conds = (cond.conds ?? []) as Array<{ op: string; col?: unknown; val?: unknown }>
      expect(conds).toContainEqual(
        expect.objectContaining({ op: 'eq', col: 'name', val: expect.any(String) }),
      )
      expect(conds).toContainEqual(expect.objectContaining({ op: 'isNull', col: 'user_id' }))
    }
  })

  it('updates the real system row by its PRIMARY KEY (eq id), not by name', async () => {
    // Capture the update .where() predicate to prove it targets existing.id, so a
    // same-named user row is never touched. FAILS if it regresses to eq(name).
    const updateWhere = vi.fn(() => asyncQuery({ run: mockRun }))
    mockSet.mockReturnValue({ where: updateWhere })
    mockGet.mockReturnValue({ id: 'mcp_system_router', name: 'a2wave-agent-router' })

    const { seedBuiltinMcpServers } = await import('../seed-builtin-mcp.js')
    await seedBuiltinMcpServers()

    expect(updateWhere).toHaveBeenCalled()
    for (const call of updateWhere.mock.calls as unknown as Array<
      [{ op: string; col?: unknown; val?: unknown }]
    >) {
      const cond = call[0]
      expect(cond).toEqual({ op: 'eq', col: 'id', val: 'mcp_system_router' })
    }
  })

  it('resolves dev mode config correctly', async () => {
    const { resolveBuiltinMcpConfig } = await import('../seed-builtin-mcp.js')
    const config = resolveBuiltinMcpConfig()
    const platformAdminConfig = resolveBuiltinMcpConfig('a2wave-platform-admin')
    const groupProxyConfig = resolveBuiltinMcpConfig('a2wave-mcp-group-proxy')

    expect(config.args[0]).toBe('tsx')
    expect(config.args[1]).toContain('a2wave-agent-router.ts')
    expect(config.args[1]).toContain('mcp-servers')
    expect(config.env.A2WAVE_API_URL).toBe('http://127.0.0.1:3502')
    expect(config.env.A2WAVE_ALLOW_PRIVATE_ROUTE_TARGETS).toBe('1')
    expect(config.env.A2WAVE_TRUSTED_A2A_ROUTE_HOSTS).toBe('agents.internal.example')
    expect(groupProxyConfig.env.A2WAVE_TRUSTED_MCP_HOSTS).toBe('mcp.internal.example')
    expect(platformAdminConfig.env.A2WAVE_TRUSTED_A2A_ROUTE_HOSTS).toBeUndefined()
    expect(platformAdminConfig.env.A2WAVE_TRUSTED_MCP_HOSTS).toBeUndefined()
    expect(config.env.A2WAVE_INTERNAL_ADMIN_TOKEN).toBeUndefined()
    expect(platformAdminConfig.env.A2WAVE_INTERNAL_ADMIN_TOKEN).toBeUndefined()
  })

  it('passes both private-network and explicit public-only policies only to the Agent router', async () => {
    const { resolveBuiltinMcpConfig } = await import('../seed-builtin-mcp.js')

    expect(resolveBuiltinMcpConfig().env.A2WAVE_ALLOW_PRIVATE_ROUTE_TARGETS).toBe('1')
    expect(
      resolveBuiltinMcpConfig('a2wave-platform-admin').env.A2WAVE_ALLOW_PRIVATE_ROUTE_TARGETS,
    ).toBeUndefined()
    expect(
      resolveBuiltinMcpConfig('a2wave-mcp-group-proxy').env.A2WAVE_ALLOW_PRIVATE_ROUTE_TARGETS,
    ).toBeUndefined()

    envMock.ALLOW_PRIVATE_ROUTE_TARGETS = false
    expect(resolveBuiltinMcpConfig().env.A2WAVE_ALLOW_PRIVATE_ROUTE_TARGETS).toBe('0')
  })

  it('never persists the process-scoped internal admin token in SQLite MCP config', async () => {
    mockGet.mockReturnValue(undefined)

    const { seedBuiltinMcpServers } = await import('../seed-builtin-mcp.js')
    await seedBuiltinMcpServers()

    for (const [row] of mockValues.mock.calls as unknown as Array<
      [{ env?: Record<string, string> }]
    >) {
      expect(row.env?.A2WAVE_INTERNAL_ADMIN_TOKEN).toBeUndefined()
      expect(JSON.stringify(row)).not.toContain('A2WAVE_INTERNAL_ADMIN_TOKEN')
    }
  })

  it('resolves production mode config with .js extension and node command', async () => {
    vi.doMock('../../env.js', () => ({
      env: { PORT: 3502, NODE_ENV: 'production' },
    }))
    vi.resetModules()
    const { resolveBuiltinMcpConfig } = await import('../seed-builtin-mcp.js')
    const config = resolveBuiltinMcpConfig()

    expect(config.args).toHaveLength(1)
    // MCP Server 产物由 tsup --format esm 输出，扩展名应为 .js；
    // 与 apps/api/package.json 的 build 脚本保持一致。
    expect(config.args[0]).toMatch(/a2wave-agent-router\.js$/)
    expect(config.args[0]).toContain('mcp-servers')
    expect(config.command).toContain('node')
    expect(config.command).not.toContain('npx')
  })
})
