import type { Context } from 'hono'
/**
 * agent-access permission helper tests.
 *
 * We mock `db/client.js` and drive `db.select` per scenario. For the two-query
 * branch (membership lookup) we wire `db.select` to return the agent chain on
 * the first call and the membership chain on the second call.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { db } from '../../db/client.js'
import { createTestAgent } from '../../test/factories.js'

vi.mock('../../db/client.js', () => ({
  db: {
    select: vi.fn(),
    insert: vi.fn(),
    update: vi.fn(),
    delete: vi.fn(),
  },
}))

import {
  getAgentPermission,
  getAgentReadFilter,
  getArtifactReadFilter,
  getRunReadFilter,
  hasAgentScopedAccess,
  loadAgentWithPerm,
  requireAgentOwner,
  requireAgentRead,
  requireAgentWrite,
} from '../agent-access.js'
import { ForbiddenError, NotFoundError } from '../errors.js'

import { asyncQuery } from '../../test/async-query.js'

type Mocked = { select: ReturnType<typeof vi.fn> }
const mockedDb = db as unknown as Mocked

/** Build a minimal Hono Context stub that supports c.get('userRole') / c.get('userId'). */
function makeCtx(opts: { userId: string; userRole: 'admin' | 'user' }): Context {
  const store: Record<string, unknown> = {
    userId: opts.userId,
    userRole: opts.userRole,
  }
  return {
    get: (key: string) => store[key],
    set: (key: string, val: unknown) => {
      store[key] = val
    },
  } as unknown as Context
}

/** Mock chain that supports `.from(...).where(...).get()`. */
function selectChain(getReturn: unknown) {
  return {
    from: vi.fn().mockReturnValue(
      asyncQuery({
        where: vi.fn().mockReturnValue(
          asyncQuery({
            get: vi.fn().mockReturnValue(getReturn),
          }),
        ),
      }),
    ),
  }
}

beforeEach(() => {
  mockedDb.select.mockReset()
})

// ---- getAgentPermission ----

describe('getAgentPermission', () => {
  it('admin caller is owner of any agent (including null-owner legacy agents)', async () => {
    const c = makeCtx({ userId: 'usr_admin', userRole: 'admin' })
    const ownedAgent = createTestAgent({ userId: 'usr_someone' })
    const nullOwnerAgent = createTestAgent({ userId: null })
    expect(getAgentPermission(c, ownedAgent as never)).toBe('owner')
    expect(getAgentPermission(c, nullOwnerAgent as never)).toBe('owner')
  })

  it('non-admin caller whose userId matches agent.userId is owner', async () => {
    const c = makeCtx({ userId: 'usr_alice', userRole: 'user' })
    const agent = createTestAgent({ userId: 'usr_alice' })
    expect(getAgentPermission(c, agent as never)).toBe('owner')
  })

  it('non-admin caller against null-owner agent → null', async () => {
    const c = makeCtx({ userId: 'usr_alice', userRole: 'user' })
    const agent = createTestAgent({ userId: null })
    expect(getAgentPermission(c, agent as never)).toBeNull()
  })

  it('non-admin caller, agent owned by someone else → null (no DB call)', async () => {
    const c = makeCtx({ userId: 'usr_alice', userRole: 'user' })
    const agent = createTestAgent({ userId: 'usr_bob' })
    expect(getAgentPermission(c, agent as never)).toBeNull()
    expect(mockedDb.select).not.toHaveBeenCalled()
  })
})

// ---- loadAgentWithPerm ----

describe('loadAgentWithPerm', () => {
  it('returns null when agent does not exist', async () => {
    mockedDb.select.mockReturnValueOnce(selectChain(undefined))
    const c = makeCtx({ userId: 'usr_alice', userRole: 'user' })
    expect(await loadAgentWithPerm(c, 'agt_missing')).toBeNull()
    expect(mockedDb.select).toHaveBeenCalledTimes(1)
  })

  it('owner via agents.userId — returns "owner", no membership query', async () => {
    const agent = createTestAgent({ id: 'agt_a', userId: 'usr_alice' })
    mockedDb.select.mockReturnValueOnce(selectChain(agent))
    const c = makeCtx({ userId: 'usr_alice', userRole: 'user' })
    const got = await loadAgentWithPerm(c, 'agt_a')
    expect(got).toEqual({ agent, permission: 'owner' })
    expect(mockedDb.select).toHaveBeenCalledTimes(1)
  })

  it('admin caller → "owner", no membership query (even if not the owner)', async () => {
    const agent = createTestAgent({ id: 'agt_a', userId: 'usr_bob' })
    mockedDb.select.mockReturnValueOnce(selectChain(agent))
    const c = makeCtx({ userId: 'usr_admin', userRole: 'admin' })
    const got = await loadAgentWithPerm(c, 'agt_a')
    expect(got).toEqual({ agent, permission: 'owner' })
    expect(mockedDb.select).toHaveBeenCalledTimes(1)
  })

  it('editor member → "editor", membership query DID happen', async () => {
    const agent = createTestAgent({ id: 'agt_a', userId: 'usr_bob' })
    mockedDb.select
      .mockReturnValueOnce(selectChain(agent))
      .mockReturnValueOnce(selectChain({ role: 'editor' }))
    const c = makeCtx({ userId: 'usr_alice', userRole: 'user' })
    const got = await loadAgentWithPerm(c, 'agt_a')
    expect(got).toEqual({ agent, permission: 'editor' })
    expect(mockedDb.select).toHaveBeenCalledTimes(2)
  })

  it('viewer member → "viewer"', async () => {
    const agent = createTestAgent({ id: 'agt_a', userId: 'usr_bob' })
    mockedDb.select
      .mockReturnValueOnce(selectChain(agent))
      .mockReturnValueOnce(selectChain({ role: 'viewer' }))
    const c = makeCtx({ userId: 'usr_alice', userRole: 'user' })
    const got = await loadAgentWithPerm(c, 'agt_a')
    expect(got).toEqual({ agent, permission: 'viewer' })
    expect(mockedDb.select).toHaveBeenCalledTimes(2)
  })

  it('unrelated user with no membership row → null after empty membership query', async () => {
    const agent = createTestAgent({ id: 'agt_a', userId: 'usr_bob' })
    mockedDb.select
      .mockReturnValueOnce(selectChain(agent))
      .mockReturnValueOnce(selectChain(undefined))
    const c = makeCtx({ userId: 'usr_alice', userRole: 'user' })
    expect(await loadAgentWithPerm(c, 'agt_a')).toBeNull()
    expect(mockedDb.select).toHaveBeenCalledTimes(2)
  })

  it('null-owner agent + non-admin caller → null, membership query is NOT issued', async () => {
    const agent = createTestAgent({ id: 'agt_legacy', userId: null })
    mockedDb.select.mockReturnValueOnce(selectChain(agent))
    const c = makeCtx({ userId: 'usr_alice', userRole: 'user' })
    expect(await loadAgentWithPerm(c, 'agt_legacy')).toBeNull()
    expect(mockedDb.select).toHaveBeenCalledTimes(1)
  })
})

// ---- require* guards ----

describe('requireAgentRead', () => {
  it('throws NotFoundError when invisible', async () => {
    mockedDb.select.mockReturnValueOnce(selectChain(undefined))
    const c = makeCtx({ userId: 'usr_alice', userRole: 'user' })
    await expect(requireAgentRead(c, 'agt_missing')).rejects.toThrow(NotFoundError)
  })

  it('returns AgentWithPermission for viewer', async () => {
    const agent = createTestAgent({ id: 'agt_a', userId: 'usr_bob' })
    mockedDb.select
      .mockReturnValueOnce(selectChain(agent))
      .mockReturnValueOnce(selectChain({ role: 'viewer' }))
    const c = makeCtx({ userId: 'usr_alice', userRole: 'user' })
    const got = await requireAgentRead(c, 'agt_a')
    expect((await got).permission).toBe('viewer')
  })
})

describe('requireAgentWrite', () => {
  it('viewer → ForbiddenError (status 403)', async () => {
    const agent = createTestAgent({ id: 'agt_a', userId: 'usr_bob' })
    mockedDb.select
      .mockReturnValueOnce(selectChain(agent))
      .mockReturnValueOnce(selectChain({ role: 'viewer' }))
    const c = makeCtx({ userId: 'usr_alice', userRole: 'user' })
    let caught: unknown
    try {
      await requireAgentWrite(c, 'agt_a')
    } catch (err) {
      caught = err
    }
    expect(caught).toBeInstanceOf(ForbiddenError)
    expect((caught as ForbiddenError).statusCode).toBe(403)
  })

  it('editor → returns', async () => {
    const agent = createTestAgent({ id: 'agt_a', userId: 'usr_bob' })
    mockedDb.select
      .mockReturnValueOnce(selectChain(agent))
      .mockReturnValueOnce(selectChain({ role: 'editor' }))
    const c = makeCtx({ userId: 'usr_alice', userRole: 'user' })
    expect((await requireAgentWrite(c, 'agt_a')).permission).toBe('editor')
  })

  it('owner → returns', async () => {
    const agent = createTestAgent({ id: 'agt_a', userId: 'usr_alice' })
    mockedDb.select.mockReturnValueOnce(selectChain(agent))
    const c = makeCtx({ userId: 'usr_alice', userRole: 'user' })
    expect((await requireAgentWrite(c, 'agt_a')).permission).toBe('owner')
  })
})

describe('requireAgentOwner', () => {
  it('editor → ForbiddenError', async () => {
    const agent = createTestAgent({ id: 'agt_a', userId: 'usr_bob' })
    mockedDb.select
      .mockReturnValueOnce(selectChain(agent))
      .mockReturnValueOnce(selectChain({ role: 'editor' }))
    const c = makeCtx({ userId: 'usr_alice', userRole: 'user' })
    await expect(requireAgentOwner(c, 'agt_a')).rejects.toThrow(ForbiddenError)
  })

  it('owner → returns', async () => {
    const agent = createTestAgent({ id: 'agt_a', userId: 'usr_alice' })
    mockedDb.select.mockReturnValueOnce(selectChain(agent))
    const c = makeCtx({ userId: 'usr_alice', userRole: 'user' })
    expect((await requireAgentOwner(c, 'agt_a')).permission).toBe('owner')
  })
})

// ---- getAgentReadFilter ----

describe('getAgentReadFilter', () => {
  it('admin → undefined', async () => {
    const c = makeCtx({ userId: 'usr_admin', userRole: 'admin' })
    expect(getAgentReadFilter(c)).toBeUndefined()
  })

  it('non-admin → consults agent_members and binds userId as a parameter', async () => {
    const { SQLiteSyncDialect } = await import('drizzle-orm/sqlite-core')
    const dialect = new SQLiteSyncDialect()
    const c = makeCtx({ userId: 'usr_alice', userRole: 'user' })
    const filter = getAgentReadFilter(c)
    expect(filter).toBeDefined()
    // biome-ignore lint/style/noNonNullAssertion: validated by toBeDefined above
    const query = dialect.sqlToQuery(filter!)
    expect(query.sql.toLowerCase()).toContain('agent_members')
    // userId binding is parameterized, never inlined into the SQL text.
    expect(query.sql).not.toContain('usr_alice')
    expect(query.params).toContain('usr_alice')
    // Row-level semantics are asserted against a real SQLite fixture below.
  })
})

// ---- getRunReadFilter ----
//
// Regression: run visibility used to be gated on `runs.user_id` alone, which is
// an *attribution* column, not an ACL. It is NULL for every channel without a
// logged-in a2wave user (Feishu / gateway API key / OAuth), so a non-admin agent
// owner saw none of their own agent's production traffic, and editor/viewer
// members saw nothing at all. These tests execute the generated SQL against a
// real SQLite fixture so they assert row-level semantics, not string shape.

describe('getRunReadFilter', () => {
  it('admin → undefined (no filter)', async () => {
    const c = makeCtx({ userId: 'usr_admin', userRole: 'admin' })
    expect(getRunReadFilter(c)).toBeUndefined()
  })

  it('non-admin → binds userId as a parameter, never inlined', async () => {
    const { SQLiteSyncDialect } = await import('drizzle-orm/sqlite-core')
    const c = makeCtx({ userId: 'usr_alice', userRole: 'user' })
    const filter = getRunReadFilter(c)
    expect(filter).toBeDefined()
    // biome-ignore lint/style/noNonNullAssertion: validated by toBeDefined above
    const query = new SQLiteSyncDialect().sqlToQuery(filter!)
    expect(query.sql).not.toContain('usr_alice')
    expect(query.params).toContain('usr_alice')
  })

  describe('row-level semantics against a real SQLite fixture', () => {
    /**
     * Fixture (caller = usr_alice, a non-admin):
     *   agt_mine   owned by alice
     *   agt_shared owned by bob, alice is a viewer member
     *   agt_other  owned by bob, alice has no relationship
     *   agt_legacy null owner (legacy/system agent — non-admins never see these)
     */
    async function visibleRunIds(userRole: 'admin' | 'user'): Promise<string[]> {
      const { default: Database } = await import('better-sqlite3')
      const { SQLiteSyncDialect } = await import('drizzle-orm/sqlite-core')
      const sqlite = new Database(':memory:')
      try {
        sqlite.exec(`
          CREATE TABLE agents (id TEXT PRIMARY KEY, user_id TEXT);
          CREATE TABLE agent_members (agent_id TEXT, user_id TEXT, role TEXT);
          CREATE TABLE runs (id TEXT PRIMARY KEY, user_id TEXT, initiator_agent_id TEXT);
          INSERT INTO agents VALUES
            ('agt_mine', 'usr_alice'), ('agt_shared', 'usr_bob'),
            ('agt_edit', 'usr_bob'),
            ('agt_other', 'usr_bob'), ('agt_legacy', NULL);
          -- A membership row on a NULL-owner agent is a reachable state:
          -- requireAgentOwner treats admin as owner of every agent, so an admin
          -- can add members to a legacy/system agent. loadAgentWithPerm still
          -- denies it, and the SQL filter must agree.
          INSERT INTO agent_members VALUES
            ('agt_shared', 'usr_alice', 'viewer'),
            ('agt_edit',   'usr_alice', 'editor'),
            ('agt_legacy', 'usr_alice', 'viewer');
          INSERT INTO runs VALUES
            ('run_own_debug',    'usr_alice', 'agt_other'),
            ('run_mine_feishu',  NULL,        'agt_mine'),
            ('run_mine_debug',   'usr_bob',   'agt_mine'),
            ('run_shared_api',   NULL,        'agt_shared'),
            ('run_edit_feishu',  NULL,        'agt_edit'),
            ('run_other_feishu', NULL,        'agt_other'),
            ('run_other_debug',  'usr_bob',   'agt_other'),
            ('run_legacy',       NULL,        'agt_legacy'),
            ('run_orphan',       NULL,        NULL);
        `)

        const filter = getRunReadFilter(makeCtx({ userId: 'usr_alice', userRole }))
        if (!filter)
          return sqlite
            .prepare('SELECT id FROM runs')
            .all()
            .map((r) => (r as { id: string }).id)

        const query = new SQLiteSyncDialect().sqlToQuery(filter)
        const rows = sqlite
          .prepare(`SELECT id FROM runs WHERE ${query.sql}`)
          .all(...(query.params as string[]))
        return rows.map((r) => (r as { id: string }).id)
      } finally {
        sqlite.close()
      }
    }

    it('admin sees every run', async () => {
      const asAdmin = await visibleRunIds('admin')
      const asUser = await visibleRunIds('user')
      // Asserted by semantics rather than a row count, so adding a fixture row
      // does not fail an unrelated test: admin must see precisely the rows a
      // non-admin is denied — unrelated, null-owner, and agent-less runs.
      expect(asAdmin).toEqual(
        expect.arrayContaining(['run_other_feishu', 'run_other_debug', 'run_legacy', 'run_orphan']),
      )
      expect(asAdmin.length).toBeGreaterThan(asUser.length)
    })

    it('owner sees their agent runs regardless of who triggered them', async () => {
      const visible = await visibleRunIds('user')
      // The actual bug: a Feishu/gateway/OAuth run carries no user_id at all.
      expect(visible).toContain('run_mine_feishu')
      // ...and a run triggered on my agent by another logged-in user.
      expect(visible).toContain('run_mine_debug')
    })

    it('member sees runs of the agent shared with them', async () => {
      expect(await visibleRunIds('user')).toContain('run_shared_api')
    })

    // Read access is role-agnostic: any agent_members row grants it. Covering only
    // 'viewer' would let an editor-excluding regression slip through — and editor is
    // the role a collaborator is most often given.
    it('editor member sees the shared agent runs too, not just viewer', async () => {
      expect(await visibleRunIds('user')).toContain('run_edit_feishu')
    })

    it('caller still sees runs they triggered on an agent they cannot read', async () => {
      expect(await visibleRunIds('user')).toContain('run_own_debug')
    })

    it('runs of unrelated, null-owner, and agent-less rows stay hidden', async () => {
      const visible = await visibleRunIds('user')
      expect(visible).not.toContain('run_other_feishu')
      expect(visible).not.toContain('run_other_debug')
      expect(visible).not.toContain('run_legacy')
      expect(visible).not.toContain('run_orphan')
    })

    /**
     * `GET /runs/leaderboard` and `/runs/stats` apply this filter to a query that
     * ALREADY joins `agents` in the outer scope. The subquery names `agents` again,
     * so correctness rests on each arm carrying its own FROM/JOIN and binding to the
     * inner scope. Drop that self-reference in a future edit and the name silently
     * resolves to the OUTER agents row — the filter degenerates into a tautology and
     * leaks every run. This pins the behaviour in the shape that would break.
     */
    async function visibleRunIdsJoinedWithAgents(): Promise<string[]> {
      const { default: Database } = await import('better-sqlite3')
      const { SQLiteSyncDialect } = await import('drizzle-orm/sqlite-core')
      const sqlite = new Database(':memory:')
      try {
        sqlite.exec(`
          CREATE TABLE agents (id TEXT PRIMARY KEY, user_id TEXT, name TEXT);
          CREATE TABLE agent_members (agent_id TEXT, user_id TEXT, role TEXT);
          CREATE TABLE runs (id TEXT PRIMARY KEY, user_id TEXT, initiator_agent_id TEXT);
          INSERT INTO agents VALUES
            ('agt_mine', 'usr_alice', 'Mine'), ('agt_other', 'usr_bob', 'Other');
          INSERT INTO runs VALUES
            ('run_mine_feishu',  NULL,      'agt_mine'),
            ('run_other_feishu', NULL,      'agt_other'),
            ('run_other_debug',  'usr_bob', 'agt_other');
        `)

        const filter = getRunReadFilter(makeCtx({ userId: 'usr_alice', userRole: 'user' }))
        if (!filter) throw new Error('expected a filter for a non-admin caller')
        const query = new SQLiteSyncDialect().sqlToQuery(filter)
        return sqlite
          .prepare(
            `SELECT runs.id FROM runs
               INNER JOIN agents ON runs.initiator_agent_id = agents.id
              WHERE ${query.sql}`,
          )
          .all(...(query.params as string[]))
          .map((r) => (r as { id: string }).id)
      } finally {
        sqlite.close()
      }
    }

    it('still isolates when the outer query also joins agents (leaderboard shape)', async () => {
      const visible = await visibleRunIdsJoinedWithAgents()
      expect(visible).toEqual(['run_mine_feishu'])
    })
  })
})

// ---- getArtifactReadFilter ----
//
// Same defect class as runs: `artifacts.user_id` is inherited from the run that
// produced the artifact, so it is NULL for Feishu / gateway / OAuth runs. The
// run-detail drawer lists artifacts through this filter and renders nothing when
// the list is empty, so the whole "运行产物" block silently vanished for the
// agent's own non-admin owner.

describe('getArtifactReadFilter', () => {
  it('admin → undefined (no filter)', async () => {
    const c = makeCtx({ userId: 'usr_admin', userRole: 'admin' })
    expect(getArtifactReadFilter(c)).toBeUndefined()
  })

  it('non-admin → binds userId as a parameter, never inlined', async () => {
    const { SQLiteSyncDialect } = await import('drizzle-orm/sqlite-core')
    const c = makeCtx({ userId: 'usr_alice', userRole: 'user' })
    const filter = getArtifactReadFilter(c)
    expect(filter).toBeDefined()
    // biome-ignore lint/style/noNonNullAssertion: validated by toBeDefined above
    const query = new SQLiteSyncDialect().sqlToQuery(filter!)
    expect(query.sql).not.toContain('usr_alice')
    expect(query.params).toContain('usr_alice')
  })

  describe('row-level semantics against a real SQLite fixture', () => {
    async function visibleArtifactIds(): Promise<string[]> {
      const { default: Database } = await import('better-sqlite3')
      const { SQLiteSyncDialect } = await import('drizzle-orm/sqlite-core')
      const sqlite = new Database(':memory:')
      try {
        sqlite.exec(`
          CREATE TABLE agents (id TEXT PRIMARY KEY, user_id TEXT);
          CREATE TABLE agent_members (agent_id TEXT, user_id TEXT, role TEXT);
          CREATE TABLE artifacts (id TEXT PRIMARY KEY, user_id TEXT, agent_id TEXT);
          INSERT INTO agents VALUES
            ('agt_mine', 'usr_alice'), ('agt_shared', 'usr_bob'),
            ('agt_other', 'usr_bob'), ('agt_legacy', NULL);
          INSERT INTO agent_members VALUES
            ('agt_shared', 'usr_alice', 'viewer'),
            ('agt_legacy', 'usr_alice', 'viewer');
          INSERT INTO artifacts VALUES
            ('art_mine_feishu', NULL,        'agt_mine'),
            ('art_shared_api',  NULL,        'agt_shared'),
            ('art_own_debug',   'usr_alice', 'agt_other'),
            ('art_other',       NULL,        'agt_other'),
            ('art_legacy',      NULL,        'agt_legacy'),
            ('art_orphan',      NULL,        NULL);
        `)

        const filter = getArtifactReadFilter(makeCtx({ userId: 'usr_alice', userRole: 'user' }))
        // biome-ignore lint/style/noNonNullAssertion: non-admin always yields a filter
        const query = new SQLiteSyncDialect().sqlToQuery(filter!)
        return sqlite
          .prepare(`SELECT id FROM artifacts WHERE ${query.sql}`)
          .all(...(query.params as string[]))
          .map((r) => (r as { id: string }).id)
      } finally {
        sqlite.close()
      }
    }

    it('shows artifacts of agents the caller can read, plus their own', async () => {
      const visible = await visibleArtifactIds()
      expect(visible).toContain('art_mine_feishu') // the actual bug: user_id IS NULL
      expect(visible).toContain('art_shared_api')
      expect(visible).toContain('art_own_debug')
    })

    it('hides artifacts of unrelated and agent-less rows', async () => {
      const visible = await visibleArtifactIds()
      expect(visible).not.toContain('art_other')
      expect(visible).not.toContain('art_orphan')
      // A membership row must not resurrect a NULL-owner agent.
      expect(visible).not.toContain('art_legacy')
    })
  })
})

// ---- hasAgentScopedAccess ----
//
// Row-level counterpart of the two SQL filters above, for endpoints that have
// already loaded the row (artifact download / delete, run cancel).

describe('hasAgentScopedAccess', () => {
  const row = (userId: string | null, agentId: string | null) => ({ userId, agentId })

  it('admin passes for read and write without touching the DB', async () => {
    const c = makeCtx({ userId: 'usr_admin', userRole: 'admin' })
    expect(await hasAgentScopedAccess(c, row(null, null), 'read')).toBe(true)
    expect(await hasAgentScopedAccess(c, row(null, 'agt_a'), 'write')).toBe(true)
    expect(mockedDb.select).not.toHaveBeenCalled()
  })

  it('the row’s own trigger passes for read and write, no agent lookup', async () => {
    const c = makeCtx({ userId: 'usr_alice', userRole: 'user' })
    expect(await hasAgentScopedAccess(c, row('usr_alice', 'agt_other'), 'read')).toBe(true)
    expect(await hasAgentScopedAccess(c, row('usr_alice', 'agt_other'), 'write')).toBe(true)
    expect(mockedDb.select).not.toHaveBeenCalled()
  })

  it('viewer member can read but not write', async () => {
    const c = makeCtx({ userId: 'usr_alice', userRole: 'user' })
    const agent = createTestAgent({ id: 'agt_shared', userId: 'usr_bob' })
    mockedDb.select
      .mockReturnValueOnce(selectChain(agent))
      .mockReturnValueOnce(selectChain({ role: 'viewer' }))
    expect(await hasAgentScopedAccess(c, row(null, 'agt_shared'), 'read')).toBe(true)

    mockedDb.select
      .mockReturnValueOnce(selectChain(agent))
      .mockReturnValueOnce(selectChain({ role: 'viewer' }))
    expect(await hasAgentScopedAccess(c, row(null, 'agt_shared'), 'write')).toBe(false)
  })

  it('editor member can read and write', async () => {
    const c = makeCtx({ userId: 'usr_alice', userRole: 'user' })
    const agent = createTestAgent({ id: 'agt_shared', userId: 'usr_bob' })
    mockedDb.select
      .mockReturnValueOnce(selectChain(agent))
      .mockReturnValueOnce(selectChain({ role: 'editor' }))
    expect(await hasAgentScopedAccess(c, row(null, 'agt_shared'), 'write')).toBe(true)
  })

  it('agent owner passes for a row with no trigger identity (the NULL user_id case)', async () => {
    const c = makeCtx({ userId: 'usr_alice', userRole: 'user' })
    mockedDb.select.mockReturnValueOnce(
      selectChain(createTestAgent({ id: 'agt_mine', userId: 'usr_alice' })),
    )
    expect(await hasAgentScopedAccess(c, row(null, 'agt_mine'), 'write')).toBe(true)
  })

  it('stranger is denied', async () => {
    const c = makeCtx({ userId: 'usr_alice', userRole: 'user' })
    mockedDb.select
      .mockReturnValueOnce(selectChain(createTestAgent({ id: 'agt_other', userId: 'usr_bob' })))
      .mockReturnValueOnce(selectChain(undefined))
    expect(await hasAgentScopedAccess(c, row(null, 'agt_other'), 'read')).toBe(false)
  })

  it('a row with neither trigger identity nor agent is denied', async () => {
    const c = makeCtx({ userId: 'usr_alice', userRole: 'user' })
    expect(await hasAgentScopedAccess(c, row(null, null), 'read')).toBe(false)
    expect(mockedDb.select).not.toHaveBeenCalled()
  })
})

// ---- getAgentReadFilter row-level semantics ----
//
// The listing filter and loadAgentWithPerm must agree on NULL-owner agents,
// otherwise `GET /agents` lists an agent whose detail route answers 404.

describe('getAgentReadFilter row-level semantics', () => {
  it('lists owned and shared agents but never a NULL-owner one, even with a membership row', async () => {
    const { default: Database } = await import('better-sqlite3')
    const { SQLiteSyncDialect } = await import('drizzle-orm/sqlite-core')
    const sqlite = new Database(':memory:')
    try {
      sqlite.exec(`
        CREATE TABLE agents (id TEXT PRIMARY KEY, user_id TEXT);
        CREATE TABLE agent_members (agent_id TEXT, user_id TEXT, role TEXT);
        INSERT INTO agents VALUES
          ('agt_mine', 'usr_alice'), ('agt_shared', 'usr_bob'),
          ('agt_other', 'usr_bob'), ('agt_legacy', NULL);
        INSERT INTO agent_members VALUES
          ('agt_shared', 'usr_alice', 'viewer'),
          ('agt_legacy', 'usr_alice', 'viewer');
      `)
      const filter = getAgentReadFilter(makeCtx({ userId: 'usr_alice', userRole: 'user' }))
      // biome-ignore lint/style/noNonNullAssertion: non-admin always yields a filter
      const query = new SQLiteSyncDialect().sqlToQuery(filter!)
      const visible = sqlite
        .prepare(`SELECT id FROM agents WHERE ${query.sql}`)
        .all(...(query.params as string[]))
        .map((r) => (r as { id: string }).id)

      expect(visible).toContain('agt_mine')
      expect(visible).toContain('agt_shared')
      expect(visible).not.toContain('agt_other')
      // Matches loadAgentWithPerm: a NULL-owner agent is admin-only regardless
      // of any agent_members row.
      expect(visible).not.toContain('agt_legacy')
    } finally {
      sqlite.close()
    }
  })
})
