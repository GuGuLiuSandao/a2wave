/**
 * Route-level tests for agent membership endpoints.
 *
 * Strategy: mock `db` from `db/client.js` and drive each test by queueing
 * `db.select.mockReturnValueOnce(...)` calls in the order the route + the
 * `agent-access` lib will issue them. This keeps the tests close to the
 * runtime path without standing up a real SQLite database.
 *
 * Call orders:
 *
 *   GET    /:id/members       — when agent has owner:
 *     1. loadAgentWithPerm: select agents (get)
 *     2. (non-admin & non-owner-by-userId) select agentMembers role (get)
 *     3. select members joined with users (all) [orderBy].
 *     4. select owner from users (get)
 *
 *   GET    /:id/members       — NULL-owner agent + admin:
 *     1. loadAgentWithPerm: select agents (get) → admin shortcuts to owner
 *     2. select members (all)        (no owner row appended)
 *
 *   POST   /:id/members
 *     1. loadAgentWithPerm: select agents (get)
 *     2. (non-admin & non-owner) select agentMembers role  (skipped for owner)
 *     3. select target user (get)
 *     4. insert agentMembers (run)
 *     5. select inserted row (get)
 *
 *   PATCH  /:id/members/:userId
 *     1. loadAgentWithPerm: select agents (get)
 *     2. select existing agentMembers row (get)
 *     3. update row (run)
 *     4. select target user (get)
 *     5. select updated row (get)
 *
 *   DELETE /:id/members/:userId
 *     1. loadAgentWithPerm: select agents (get)
 *     2. select existing agentMembers row (get)
 *     3. delete row (run)
 */
import { Hono } from 'hono'
import { type Mock, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../../db/client.js', () => ({
  db: {
    select: vi.fn(),
    insert: vi.fn(),
    update: vi.fn(),
    delete: vi.fn(),
  },
}))

vi.mock('../../lib/audit.js', () => ({
  logAudit: vi.fn(),
}))

import { db } from '../../db/client.js'
import { logAudit } from '../../lib/audit.js'
import { AppError } from '../../lib/errors.js'

import { asyncQuery } from '../../test/async-query.js'

const mockDb = db as unknown as {
  select: Mock
  insert: Mock
  update: Mock
  delete: Mock
}
const mockLogAudit = logAudit as unknown as Mock

interface AgentRow {
  id: string
  userId: string | null
  createdAt: Date
}

interface UserRow {
  id: string
  username: string
  displayName: string | null
  email: string | null
  isActive: boolean
  createdAt: Date
}

interface MemberDbRow {
  agentId: string
  userId: string
  role: 'viewer' | 'editor'
  createdAt: Date
}

const NOW = new Date('2025-01-01T00:00:00Z')

const AGENT: AgentRow = { id: 'agt_1', userId: 'usr_owner', createdAt: NOW }
const NULL_OWNER_AGENT: AgentRow = { id: 'agt_sys', userId: null, createdAt: NOW }

const OWNER_USER: UserRow = {
  id: 'usr_owner',
  username: 'owner',
  displayName: 'Owner',
  email: 'owner@example.com',
  isActive: true,
  createdAt: NOW,
}
const TARGET_USER: UserRow = {
  id: 'usr_target',
  username: 'target',
  displayName: 'Target',
  email: 'target@example.com',
  isActive: true,
  createdAt: NOW,
}
const INACTIVE_USER: UserRow = { ...TARGET_USER, id: 'usr_inactive', isActive: false }

/**
 * Single-leaf select chain: returns `result` for `.get()` and
 * `[result]`/result-array for `.all()` and `.orderBy().all()`.
 *
 * Supports `.leftJoin().where().orderBy().all()` shape used by the GET handler.
 */
function selectChain(result: unknown): Record<string, unknown> {
  const arr = Array.isArray(result) ? result : result != null ? [result] : []
  const leaf = {
    get: vi.fn().mockReturnValue(result),
    all: vi.fn().mockReturnValue(arr),
  }
  const orderByLeaf = { all: vi.fn().mockReturnValue(arr) }
  const where = {
    get: leaf.get,
    all: leaf.all,
    orderBy: vi.fn().mockReturnValue(orderByLeaf),
  }
  return {
    from: vi.fn().mockReturnValue(
      asyncQuery({
        where: vi.fn().mockReturnValue(where),
        leftJoin: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue(
            asyncQuery({
              orderBy: vi.fn().mockReturnValue(orderByLeaf),
              all: vi.fn().mockReturnValue(arr),
            }),
          ),
        }),
      }),
    ),
  }
}

function insertChain(
  opts: { throwError?: { code: string } | Error } = {},
): Record<string, unknown> {
  const run = vi.fn(() => {
    if (opts.throwError) throw opts.throwError
  })
  return {
    values: vi.fn().mockReturnValue(asyncQuery({ run })),
  }
}

function updateChain(): Record<string, unknown> {
  return {
    set: vi.fn().mockReturnValue(
      asyncQuery({
        where: vi.fn().mockReturnValue(asyncQuery({ run: vi.fn() })),
      }),
    ),
  }
}

function deleteChain(): Record<string, unknown> {
  return {
    where: vi.fn().mockReturnValue(asyncQuery({ run: vi.fn() })),
  }
}

/**
 * Build a Hono app mounting the agent-members router behind a fake auth
 * middleware that injects `userId` / `userRole`. Also installs an `onError`
 * matching the production handler so AppError-derived statuses surface.
 */
async function buildApp(opts: { userId: string; role: 'admin' | 'user' }) {
  const mod = await import('../agent-members.js')
  const app = new Hono()
  app.use('*', async (c, next) => {
    c.set('userId' as never, opts.userId as never)
    c.set('userRole' as never, opts.role as never)
    await next()
  })
  app.route('/api/agents', mod.default)
  app.onError((err, c) => {
    if (err instanceof AppError) {
      return c.json({ error: err.message, code: err.code }, err.statusCode as never)
    }
    return c.json({ error: 'Internal Server Error' }, 500)
  })
  return app
}

beforeEach(() => {
  // resetAllMocks (vs clearAllMocks) drops queued mockReturnValueOnce
  // implementations so leftovers from a previous test don't bleed in.
  vi.resetAllMocks()
})

// ---------------------------------------------------------------------------
// GET /api/agents/:id/members
// ---------------------------------------------------------------------------

describe('GET /api/agents/:id/members', () => {
  it('owner: returns synthetic owner row + member rows', async () => {
    const memberJoined = [
      {
        userId: TARGET_USER.id,
        username: TARGET_USER.username,
        displayName: TARGET_USER.displayName,
        email: TARGET_USER.email,
        role: 'editor' as const,
        createdAt: NOW,
      },
    ]
    // 1. loadAgentWithPerm: agents.get() — owner's userId === me, so no
    //    second membership lookup.
    mockDb.select.mockReturnValueOnce(selectChain(AGENT))
    // 2. join select members
    mockDb.select.mockReturnValueOnce(selectChain(memberJoined))
    // 3. owner user lookup
    mockDb.select.mockReturnValueOnce(selectChain(OWNER_USER))

    const app = await buildApp({ userId: 'usr_owner', role: 'user' })
    const res = await app.request('/api/agents/agt_1/members')
    expect(res.status).toBe(200)
    const body = (await res.json()) as { data: Array<{ userId: string; isOwner: boolean }> }
    expect(body.data).toHaveLength(2)
    expect(body.data[0]?.userId).toBe('usr_owner')
    expect(body.data[0]?.isOwner).toBe(true)
    expect(body.data[1]?.userId).toBe('usr_target')
    expect(body.data[1]?.isOwner).toBe(false)
  })

  it('editor (member): returns owner + members', async () => {
    // 1. agents.get() — caller is not owner; lib will then query agentMembers.
    mockDb.select.mockReturnValueOnce(selectChain(AGENT))
    // 2. agentMembers role lookup → 'editor'
    mockDb.select.mockReturnValueOnce(selectChain({ role: 'editor' }))
    // 3. join select members
    mockDb.select.mockReturnValueOnce(selectChain([]))
    // 4. owner user lookup
    mockDb.select.mockReturnValueOnce(selectChain(OWNER_USER))

    const app = await buildApp({ userId: 'usr_editor', role: 'user' })
    const res = await app.request('/api/agents/agt_1/members')
    expect(res.status).toBe(200)
    const body = (await res.json()) as { data: Array<{ role: string; isOwner: boolean }> }
    expect(body.data).toHaveLength(1)
    expect(body.data[0]?.role).toBe('owner')
  })

  it('viewer (member): returns owner + members', async () => {
    mockDb.select.mockReturnValueOnce(selectChain(AGENT))
    mockDb.select.mockReturnValueOnce(selectChain({ role: 'viewer' }))
    mockDb.select.mockReturnValueOnce(selectChain([]))
    mockDb.select.mockReturnValueOnce(selectChain(OWNER_USER))

    const app = await buildApp({ userId: 'usr_viewer', role: 'user' })
    const res = await app.request('/api/agents/agt_1/members')
    expect(res.status).toBe(200)
  })

  it('unrelated user: 404 from requireAgentRead', async () => {
    mockDb.select.mockReturnValueOnce(selectChain(AGENT))
    mockDb.select.mockReturnValueOnce(selectChain(undefined)) // no membership

    const app = await buildApp({ userId: 'usr_other', role: 'user' })
    const res = await app.request('/api/agents/agt_1/members')
    expect(res.status).toBe(404)
  })

  it('NULL-owner agent + admin: 200, no synthetic owner row', async () => {
    mockDb.select.mockReturnValueOnce(selectChain(NULL_OWNER_AGENT))
    mockDb.select.mockReturnValueOnce(selectChain([]))

    const app = await buildApp({ userId: 'usr_admin', role: 'admin' })
    const res = await app.request('/api/agents/agt_sys/members')
    expect(res.status).toBe(200)
    const body = (await res.json()) as { data: unknown[] }
    expect(body.data).toEqual([])
  })

  it('agent does not exist: 404', async () => {
    mockDb.select.mockReturnValueOnce(selectChain(undefined))
    const app = await buildApp({ userId: 'usr_admin', role: 'admin' })
    const res = await app.request('/api/agents/agt_missing/members')
    expect(res.status).toBe(404)
  })
})

// ---------------------------------------------------------------------------
// POST /api/agents/:id/members
// ---------------------------------------------------------------------------

describe('POST /api/agents/:id/members', () => {
  async function postBody(
    app: Hono,
    body: unknown,
    path = '/api/agents/agt_1/members',
  ): Promise<Response> {
    return app.request(path, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    })
  }

  it('owner adds new member: 201, audit logged', async () => {
    // 1. loadAgentWithPerm — owner shortcut
    mockDb.select.mockReturnValueOnce(selectChain(AGENT))
    // 2. target user lookup
    mockDb.select.mockReturnValueOnce(selectChain(TARGET_USER))
    // 3. insert
    mockDb.insert.mockReturnValueOnce(insertChain())
    // 4. read back inserted row
    mockDb.select.mockReturnValueOnce(
      selectChain({ userId: TARGET_USER.id, role: 'editor', createdAt: NOW }),
    )

    const app = await buildApp({ userId: 'usr_owner', role: 'user' })
    const res = await postBody(app, { userId: 'usr_target', role: 'editor' })
    expect(res.status).toBe(201)
    const body = (await res.json()) as { data: { userId: string; role: string; isOwner: boolean } }
    expect(body.data.userId).toBe('usr_target')
    expect(body.data.role).toBe('editor')
    expect(body.data.isOwner).toBe(false)

    expect(mockLogAudit).toHaveBeenCalledTimes(1)
    expect(mockLogAudit.mock.calls[0]?.[1]).toMatchObject({
      action: 'agent.member.add',
      resource: 'agent',
      resourceId: 'agt_1',
      details: { targetUserId: 'usr_target', role: 'editor' },
    })
  })

  it('UNIQUE constraint: 409', async () => {
    mockDb.select.mockReturnValueOnce(selectChain(AGENT))
    mockDb.select.mockReturnValueOnce(selectChain(TARGET_USER))
    mockDb.insert.mockReturnValueOnce(
      insertChain({
        throwError: Object.assign(new Error('unique'), { code: 'SQLITE_CONSTRAINT_PRIMARYKEY' }),
      }),
    )

    const app = await buildApp({ userId: 'usr_owner', role: 'user' })
    const res = await postBody(app, { userId: 'usr_target', role: 'viewer' })
    expect(res.status).toBe(409)
    const body = (await res.json()) as { error: string }
    expect(body.error).toBe('User is already a member')
    expect(mockLogAudit).not.toHaveBeenCalled()
  })

  it('owner adding themselves (userId === currentUserId): 400', async () => {
    mockDb.select.mockReturnValueOnce(selectChain(AGENT))
    // owner adds himself: agent.userId === currentUserId === 'usr_owner', so
    // `userId === agent.userId` branch fires first; we still cover the path.
    const app = await buildApp({ userId: 'usr_owner', role: 'user' })
    const res = await postBody(app, { userId: 'usr_owner', role: 'editor' })
    expect(res.status).toBe(400)
    const body = (await res.json()) as { error: string }
    expect(body.error).toBe('Owner is implicitly a member')
  })

  it('admin adding themselves to a non-owned agent: 400 "Cannot add yourself"', async () => {
    // admin is not the agent's userId but is the caller.
    mockDb.select.mockReturnValueOnce(selectChain(AGENT))
    const app = await buildApp({ userId: 'usr_admin', role: 'admin' })
    const res = await postBody(app, { userId: 'usr_admin', role: 'editor' })
    expect(res.status).toBe(400)
    const body = (await res.json()) as { error: string }
    expect(body.error).toBe('Cannot add yourself')
  })

  it('adding agent.userId explicitly: 400 "Owner is implicitly a member"', async () => {
    mockDb.select.mockReturnValueOnce(selectChain(AGENT))
    const app = await buildApp({ userId: 'usr_admin', role: 'admin' })
    const res = await postBody(app, { userId: 'usr_owner', role: 'editor' })
    expect(res.status).toBe(400)
    const body = (await res.json()) as { error: string }
    expect(body.error).toBe('Owner is implicitly a member')
  })

  it('target user not found: 404', async () => {
    mockDb.select.mockReturnValueOnce(selectChain(AGENT))
    mockDb.select.mockReturnValueOnce(selectChain(undefined))

    const app = await buildApp({ userId: 'usr_owner', role: 'user' })
    const res = await postBody(app, { userId: 'usr_missing', role: 'editor' })
    expect(res.status).toBe(404)
  })

  it('inactive target user: 404', async () => {
    mockDb.select.mockReturnValueOnce(selectChain(AGENT))
    mockDb.select.mockReturnValueOnce(selectChain(INACTIVE_USER))

    const app = await buildApp({ userId: 'usr_owner', role: 'user' })
    const res = await postBody(app, { userId: 'usr_inactive', role: 'editor' })
    expect(res.status).toBe(404)
  })

  it('NULL-owner agent + admin: 400 "Cannot add members to system agent"', async () => {
    mockDb.select.mockReturnValueOnce(selectChain(NULL_OWNER_AGENT))
    const app = await buildApp({ userId: 'usr_admin', role: 'admin' })
    const res = await postBody(
      app,
      { userId: 'usr_target', role: 'editor' },
      '/api/agents/agt_sys/members',
    )
    expect(res.status).toBe(400)
    const body = (await res.json()) as { error: string }
    expect(body.error).toBe('Cannot add members to system agent')
  })

  it('editor (non-owner) POST: 403', async () => {
    mockDb.select.mockReturnValueOnce(selectChain(AGENT))
    mockDb.select.mockReturnValueOnce(selectChain({ role: 'editor' }))

    const app = await buildApp({ userId: 'usr_editor', role: 'user' })
    const res = await postBody(app, { userId: 'usr_target', role: 'viewer' })
    expect(res.status).toBe(403)
  })

  it('viewer POST: 403', async () => {
    mockDb.select.mockReturnValueOnce(selectChain(AGENT))
    mockDb.select.mockReturnValueOnce(selectChain({ role: 'viewer' }))

    const app = await buildApp({ userId: 'usr_viewer', role: 'user' })
    const res = await postBody(app, { userId: 'usr_target', role: 'editor' })
    expect(res.status).toBe(403)
  })

  it('unrelated user POST: 404', async () => {
    mockDb.select.mockReturnValueOnce(selectChain(AGENT))
    mockDb.select.mockReturnValueOnce(selectChain(undefined))

    const app = await buildApp({ userId: 'usr_other', role: 'user' })
    const res = await postBody(app, { userId: 'usr_target', role: 'editor' })
    expect(res.status).toBe(404)
  })

  it('invalid role string: 400', async () => {
    mockDb.select.mockReturnValueOnce(selectChain(AGENT))
    const app = await buildApp({ userId: 'usr_owner', role: 'user' })
    const res = await postBody(app, { userId: 'usr_target', role: 'super-admin' })
    expect(res.status).toBe(400)
  })
})

// ---------------------------------------------------------------------------
// PATCH /api/agents/:id/members/:userId
// ---------------------------------------------------------------------------

describe('PATCH /api/agents/:id/members/:userId', () => {
  async function patchBody(app: Hono, body: unknown, userId = 'usr_target'): Promise<Response> {
    return app.request(`/api/agents/agt_1/members/${userId}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    })
  }

  it('owner PATCH existing member: 200, audit logged', async () => {
    const existing: MemberDbRow = {
      agentId: AGENT.id,
      userId: TARGET_USER.id,
      role: 'viewer',
      createdAt: NOW,
    }
    // 1. loadAgentWithPerm
    mockDb.select.mockReturnValueOnce(selectChain(AGENT))
    // 2. select existing membership
    mockDb.select.mockReturnValueOnce(selectChain(existing))
    // 3. update
    mockDb.update.mockReturnValueOnce(updateChain())
    // 4. select target user
    mockDb.select.mockReturnValueOnce(selectChain(TARGET_USER))
    // 5. select updated row
    mockDb.select.mockReturnValueOnce(selectChain({ role: 'editor', createdAt: NOW }))

    const app = await buildApp({ userId: 'usr_owner', role: 'user' })
    const res = await patchBody(app, { role: 'editor' })
    expect(res.status).toBe(200)
    const body = (await res.json()) as { data: { role: string } }
    expect(body.data.role).toBe('editor')
    expect(mockLogAudit).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        action: 'agent.member.update',
        resourceId: 'agt_1',
        details: { targetUserId: 'usr_target', role: 'editor' },
      }),
    )
  })

  it('non-existent member: 404', async () => {
    mockDb.select.mockReturnValueOnce(selectChain(AGENT))
    mockDb.select.mockReturnValueOnce(selectChain(undefined))

    const app = await buildApp({ userId: 'usr_owner', role: 'user' })
    const res = await patchBody(app, { role: 'editor' }, 'usr_missing')
    expect(res.status).toBe(404)
  })

  it("PATCH owner's userId: 400", async () => {
    mockDb.select.mockReturnValueOnce(selectChain(AGENT))

    const app = await buildApp({ userId: 'usr_owner', role: 'user' })
    const res = await patchBody(app, { role: 'editor' }, 'usr_owner')
    expect(res.status).toBe(400)
    const body = (await res.json()) as { error: string }
    expect(body.error).toBe("Cannot modify owner's role")
  })

  it('editor PATCH: 403', async () => {
    mockDb.select.mockReturnValueOnce(selectChain(AGENT))
    mockDb.select.mockReturnValueOnce(selectChain({ role: 'editor' }))

    const app = await buildApp({ userId: 'usr_editor', role: 'user' })
    const res = await patchBody(app, { role: 'viewer' })
    expect(res.status).toBe(403)
  })

  it('viewer PATCH: 403', async () => {
    mockDb.select.mockReturnValueOnce(selectChain(AGENT))
    mockDb.select.mockReturnValueOnce(selectChain({ role: 'viewer' }))

    const app = await buildApp({ userId: 'usr_viewer', role: 'user' })
    const res = await patchBody(app, { role: 'editor' })
    expect(res.status).toBe(403)
  })

  it('invalid body (missing role): 400', async () => {
    mockDb.select.mockReturnValueOnce(selectChain(AGENT))
    mockDb.select.mockReturnValueOnce(
      selectChain({
        agentId: AGENT.id,
        userId: TARGET_USER.id,
        role: 'viewer',
        createdAt: NOW,
      }),
    )

    const app = await buildApp({ userId: 'usr_owner', role: 'user' })
    const res = await patchBody(app, {})
    expect(res.status).toBe(400)
  })
})

// ---------------------------------------------------------------------------
// DELETE /api/agents/:id/members/:userId
// ---------------------------------------------------------------------------

describe('DELETE /api/agents/:id/members/:userId', () => {
  async function del(app: Hono, userId = 'usr_target'): Promise<Response> {
    return app.request(`/api/agents/agt_1/members/${userId}`, { method: 'DELETE' })
  }

  it('owner DELETE existing member: 200, audit logged', async () => {
    mockDb.select.mockReturnValueOnce(selectChain(AGENT))
    mockDb.select.mockReturnValueOnce(
      selectChain({
        agentId: AGENT.id,
        userId: TARGET_USER.id,
        role: 'viewer',
        createdAt: NOW,
      }),
    )
    mockDb.delete.mockReturnValueOnce(deleteChain())

    const app = await buildApp({ userId: 'usr_owner', role: 'user' })
    const res = await del(app)
    expect(res.status).toBe(200)
    const body = (await res.json()) as { data: { removed: boolean; userId: string } }
    expect(body.data).toEqual({ removed: true, userId: 'usr_target' })
    expect(mockLogAudit).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        action: 'agent.member.remove',
        resourceId: 'agt_1',
        details: { targetUserId: 'usr_target' },
      }),
    )
  })

  it("DELETE owner's userId: 400", async () => {
    mockDb.select.mockReturnValueOnce(selectChain(AGENT))

    const app = await buildApp({ userId: 'usr_owner', role: 'user' })
    const res = await del(app, 'usr_owner')
    expect(res.status).toBe(400)
    const body = (await res.json()) as { error: string }
    expect(body.error).toBe('Cannot remove the owner')
  })

  it('non-existent member: 404', async () => {
    mockDb.select.mockReturnValueOnce(selectChain(AGENT))
    mockDb.select.mockReturnValueOnce(selectChain(undefined))

    const app = await buildApp({ userId: 'usr_owner', role: 'user' })
    const res = await del(app, 'usr_missing')
    expect(res.status).toBe(404)
  })

  it('editor DELETE: 403', async () => {
    mockDb.select.mockReturnValueOnce(selectChain(AGENT))
    mockDb.select.mockReturnValueOnce(selectChain({ role: 'editor' }))

    const app = await buildApp({ userId: 'usr_editor', role: 'user' })
    const res = await del(app)
    expect(res.status).toBe(403)
  })
})
