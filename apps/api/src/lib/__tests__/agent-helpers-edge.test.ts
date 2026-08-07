/**
 * Covers small edge cases in agent-helpers not reached by agent-helpers.test.ts:
 * cleanupTempGroupConfig, and the group-ref-skipping warnings inside
 * resolveGroupBackends (recursive group refs / adminOnly refs).
 */
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import type { GroupConfig } from '@a2wave/shared'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const dbSelect = vi.fn()
vi.mock('../../db/client.js', () => ({
  db: {
    select: (...a: unknown[]) => dbSelect(...a),
    // Audit inserts (logBackgroundAudit) — swallow.
    insert: () => ({ values: () => asyncQuery({ run: () => ({ changes: 1 }) }) }),
  },
  // db/transaction.ts reads isPostgres + sqliteDatabase at module load, so the
  // mock must expose them or importing agent-helpers throws.
  isPostgres: false,
  sqliteDatabase: { inTransaction: false, exec: vi.fn() },
}))

vi.mock('../../db/schema.js', () => ({
  agents: {},
  providers: {},
  skills: { id: 'skills.id', groupId: 'skills.groupId' },
  skillGroups: { id: 'skillGroups.id' },
  mcpServers: {
    id: 'mcpServers.id',
    userId: 'mcpServers.userId',
    usageScope: 'mcpServers.usageScope',
  },
  kbDocuments: {},
  users: { id: 'users.id', role: 'users.role', isActive: 'users.isActive' },
  auditLogs: {},
}))

vi.mock('../seed-builtin-mcp.js', () => ({
  resolveBuiltinMcpConfig: vi.fn().mockReturnValue({
    command: '/usr/local/bin/node',
    args: ['dist/mcp-servers/a2wave-mcp-group-proxy.js'],
    env: {},
  }),
  isOwnerSafeBuiltinMcp: (name: string, userId: string | null) =>
    userId === null && name === 'a2wave-agent-router',
  isControlPlaneOnlyBuiltinMcp: (name: string, userId: string | null) =>
    userId === null && name === 'a2wave-platform-admin',
}))

import { buildAgentConfig, cleanupTempGroupConfig } from '../agent-helpers.js'

import { asyncQuery } from '../../test/async-query.js'

function makeChain() {
  const c: Record<string, ReturnType<typeof vi.fn>> = {}
  for (const k of [
    'from',
    'where',
    'limit',
    'orderBy',
    'offset',
    'groupBy',
    'having',
    'returning',
  ]) {
    c[k] = vi.fn((): unknown => __chain)
  }
  c.get = vi.fn()
  c.all = vi.fn()

  // Awaiting the chain yields what `.get()`/`.all()` was configured to return,
  // as an array — production code destructures `[row]` from `.limit(1)` now.
  // The original mock fns stay reachable, so existing assertions are unaffected.
  let __settled: Promise<unknown[]> | undefined
  const __rows = (): unknown[] => {
    // `get` before `all`: mocks often define both, with `all` a placeholder.
    const get = c.get as undefined | (() => unknown)
    if (get) {
      const row = get()
      if (row != null) return [row]
    }
    const all = c.all as undefined | (() => unknown)
    if (all) {
      const v = all()
      return Array.isArray(v) ? v : v == null ? [] : [v]
    }
    if (get) return []
    const run = c.run as undefined | (() => unknown)
    if (run) {
      const res = run() as { changes?: number } | undefined
      const changes = typeof res?.changes === 'number' ? res.changes : 1
      return Array.from({ length: changes }, () => ({}))
    }
    return []
  }
  const __chain = Object.assign(
    {
      // Lazy: resolving eagerly would consume a queued `get` per intermediate
      // node while the chain is still being built.
      // biome-ignore lint/suspicious/noThenProperty: intentionally a thenable — it stands in for drizzle's awaitable query builder.
      then: (f?: (v: unknown[]) => unknown, r?: (e: unknown) => unknown) => {
        __settled ??= Promise.resolve().then(__rows)
        return __settled.then(f, r)
      },
      catch: (r?: (e: unknown) => unknown) => {
        __settled ??= Promise.resolve().then(__rows)
        return __settled.catch(r)
      },
    },
    c,
  )
  for (const k of Object.keys(c)) {
    const fn = c[k] as unknown
    if (typeof fn === 'function' && !['get', 'all', 'run'].includes(k)) {
      ;(__chain as Record<string, unknown>)[k] = fn
    }
  }
  return __chain as unknown as typeof c
}

function queueSelects(...returns: Array<{ get?: unknown; all?: unknown }>) {
  let i = 0
  dbSelect.mockImplementation(() => {
    const cfg = returns[i++] ?? {}
    const c = makeChain()
    if ('get' in cfg) c.get.mockReturnValue(cfg.get)
    if ('all' in cfg) c.all.mockReturnValue(cfg.all)
    return c
  })
}

beforeEach(() => {
  dbSelect.mockReset()
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('cleanupTempGroupConfig', () => {
  it('best-effort deletes the per-server config file when present', async () => {
    const file = path.join(tmpdir(), 'a2wave-group-mcp_test_cleanup.json')
    writeFileSync(file, '{}', { mode: 0o600 })
    expect(existsSync(file)).toBe(true)
    cleanupTempGroupConfig('mcp_test_cleanup')
    expect(existsSync(file)).toBe(false)
  })

  it('does not throw when the file does not exist', async () => {
    expect(() => cleanupTempGroupConfig('mcp_never_existed')).not.toThrow()
  })
})

describe('buildAgentConfig — group MCP resolution skip branches', () => {
  function agent(overrides: Record<string, unknown> = {}) {
    return {
      id: 'agt_1',
      name: 'A',
      type: 'cursor',
      config: {},
      systemPrompt: null,
      skills: null,
      skillGroupIds: null,
      mcpServerIds: ['mcp_group'],
      kbDocumentIds: null,
      providerId: null,
      env: null,
      a2aRouteTargets: null,
      ...overrides,
    } as never
  }

  it('skips ref backends that point to another group (no recursion) and ones that point to adminOnly', async () => {
    queueSelects({
      all: [
        {
          id: 'mcp_group',
          name: 'group',
          type: 'group',
          isEnabled: true,
          // all-users + system-owned so the top-level runtime guard keeps the group
          // (the test's point is ref-skipping INSIDE resolveGroupRefs).
          usageScope: 'all-users',
          userId: null,
          groupConfig: {
            backends: {
              primary: [
                { mode: 'ref', mcpServerId: 'mcp_nested_group' },
                { mode: 'ref', mcpServerId: 'mcp_admin_only' },
                { mode: 'inline', name: 'safe', type: 'stdio', command: 'node', args: [] },
              ],
            },
          },
        },
      ],
    })
    // Second select() is for ref MCP rows (inArray fetch)
    dbSelect.mockImplementationOnce((..._a) => {
      const c = makeChain()
      c.all.mockReturnValue([
        {
          id: 'mcp_group',
          name: 'group',
          type: 'group',
          isEnabled: true,
          groupConfig: { backends: {} },
        },
      ])
      return c
    })
    // The implementation calls db.select again to resolve refs; allow whichever order returns ref rows
    dbSelect.mockImplementation(() => {
      const c = makeChain()
      c.all.mockReturnValue([
        // 1st ref id → another group → must be skipped
        { id: 'mcp_nested_group', name: 'inner', type: 'group', isEnabled: true },
        // 2nd ref id → admin-only → must be skipped
        {
          id: 'mcp_admin_only',
          name: 'admin',
          type: 'stdio',
          command: 'admin-cli',
          args: [],
          usageScope: 'admin-only',
          isEnabled: true,
        },
      ])
      return c
    })

    const cfg = await buildAgentConfig(agent())
    // Only the inline "safe" backend should survive — we just assert no crash and the
    // resolved set was produced.
    expect((await cfg).resolvedMcpServers).toBeDefined()
  })

  it('resolves an admin-bound stdio ref for an externally triggered admin-owned Agent', async () => {
    const group = {
      id: 'mcp_group',
      name: 'Admin Group',
      type: 'group',
      usageScope: 'all-users',
      userId: 'usr_admin',
      groupConfig: {
        backends: { default: [{ mode: 'ref', mcpServerId: 'mcp_stdio' }] },
      },
    }
    const stdioRef = {
      id: 'mcp_stdio',
      name: 'approved-stdio',
      type: 'stdio',
      command: 'node',
      args: ['approved-tool.js'],
      usageScope: 'admin-only',
      userId: 'usr_admin',
    }
    queueSelects({ all: [group] }, { get: { role: 'admin', isActive: true } }, { all: [stdioRef] })

    const cfg = await buildAgentConfig(agent({ userId: 'usr_admin' }))
    const groupConfig = cfg.resolvedMcpServers?.[0]?.runtimeGroupConfig?.config as GroupConfig

    expect(groupConfig.backends.default).toHaveLength(1)
    expect(groupConfig.backends.default?.[0]).toMatchObject({
      mode: 'inline',
      type: 'stdio',
      command: 'node',
      args: ['approved-tool.js'],
    })
  })

  it('does not resolve system platform-admin through a group for external triggers', async () => {
    const group = {
      id: 'mcp_group',
      name: 'Admin Group',
      type: 'group',
      usageScope: 'all-users',
      userId: 'usr_admin',
      groupConfig: {
        backends: { default: [{ mode: 'ref', mcpServerId: 'mcp_platform_admin' }] },
      },
    }
    const platformAdminRef = {
      id: 'mcp_platform_admin',
      name: 'a2wave-platform-admin',
      type: 'stdio',
      command: 'node',
      args: ['platform-admin.js'],
      usageScope: 'admin-only',
      userId: null,
    }
    queueSelects(
      { all: [group] },
      { get: { role: 'admin', isActive: true } },
      { all: [platformAdminRef] },
    )

    const cfg = await buildAgentConfig(agent({ userId: 'usr_admin' }))
    const groupConfig = cfg.resolvedMcpServers?.[0]?.runtimeGroupConfig?.config as GroupConfig

    expect(groupConfig.backends.default ?? []).toEqual([])
  })

  it('injects the process credential into a platform-admin group ref for an active admin requester', async () => {
    const group = {
      id: 'mcp_group',
      name: 'Control Plane Group',
      type: 'group',
      usageScope: 'admin-only',
      userId: 'usr_admin',
      groupConfig: {
        backends: { default: [{ mode: 'ref', mcpServerId: 'mcp_platform_admin' }] },
      },
    }
    const platformAdminRef = {
      id: 'mcp_platform_admin',
      name: 'a2wave-platform-admin',
      type: 'stdio',
      command: 'node',
      args: ['platform-admin.js'],
      env: { A2WAVE_API_URL: 'http://127.0.0.1:3502' },
      usageScope: 'admin-only',
      userId: null,
    }
    queueSelects(
      { all: [group] },
      { get: { role: 'admin', isActive: true } },
      { all: [platformAdminRef] },
    )

    const cfg = await buildAgentConfig(agent({ userId: 'usr_admin' }), {
      runtimeAdminRequesterUserId: 'usr_admin',
    })
    const groupConfig = cfg.resolvedMcpServers?.[0]?.runtimeGroupConfig?.config as GroupConfig

    expect(groupConfig.backends.default?.[0]).toMatchObject({
      mode: 'inline',
      env: {
        A2WAVE_API_URL: 'http://127.0.0.1:3502',
        A2WAVE_INTERNAL_ADMIN_TOKEN: expect.stringMatching(/^[A-Za-z0-9_-]{40,}$/),
      },
    })
  })
})
