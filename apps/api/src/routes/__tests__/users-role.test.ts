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

vi.mock('../../db/schema.js', () => ({
  users: {
    id: 'id',
    username: 'username',
    role: 'role',
    isActive: 'is_active',
    email: 'email',
    idaasSub: 'idaas_sub',
    displayName: 'display_name',
    createdAt: 'created_at',
    updatedAt: 'updated_at',
  },
}))

vi.mock('../../lib/audit.js', () => ({
  logAudit: vi.fn(),
}))

vi.mock('../../lib/audit-actions.js', () => ({
  AUDIT_ACTIONS: {
    USER_ROLE_UPDATED: 'audit.constant.user.role.updated',
  },
}))

vi.mock('../../lib/auth.js', () => ({
  hashPassword: vi.fn(async () => 'hashed'),
  validatePassword: vi.fn(() => ({ valid: true })),
}))

vi.mock('../../lib/id.js', () => ({
  createId: () => 'usr_test',
}))

import { db } from '../../db/client.js'
import { logAudit } from '../../lib/audit.js'

import { asyncQuery } from '../../test/async-query.js'

function makeWhereGet(value: unknown) {
  return { from: () => ({ where: () => asyncQuery({ get: () => value }) }) }
}

/**
 * The last-admin invariant now rides inside the UPDATE's WHERE clause instead of a
 * preceding SELECT COUNT, so the database settles concurrent demotions. `.returning()`
 * resolving to `[]` is therefore how "the guard blocked this write" is reported.
 */
function makeUpdateChain(rows: unknown[] = [{ id: 'usr_x' }]) {
  return { set: () => ({ where: () => ({ returning: async () => rows }) }) }
}

describe('PATCH /users/:id/role', () => {
  let app: Hono
  const CURRENT_USER = 'usr_admin'

  beforeEach(async () => {
    vi.clearAllMocks()
    ;(db.update as Mock).mockReturnValue(makeUpdateChain())

    const mod = await import('../users.js')
    app = new Hono()
    app.use('*', async (c, next) => {
      c.set('userId' as never, CURRENT_USER as never)
      c.set('userRole' as never, 'admin' as never)
      await next()
    })
    app.route('/api/users', mod.default)
  })

  function patch(id: string, body: unknown) {
    return app.request(`/api/users/${id}/role`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
  }

  it('rejects changing own role', async () => {
    const res = await patch(CURRENT_USER, { role: 'user' })
    expect(res.status).toBe(400)
    expect(((await res.json()) as { error: string }).error).toBe('CANNOT_CHANGE_OWN_ROLE')
  })

  it('rejects invalid role enum value', async () => {
    const res = await patch('usr_other', { role: 'superadmin' })
    expect(res.status).toBe(400)
  })

  it('returns 404 when target user missing', async () => {
    ;(db.select as Mock).mockReturnValueOnce(makeWhereGet(undefined))
    const res = await patch('usr_ghost', { role: 'admin' })
    expect(res.status).toBe(404)
  })

  it('promotes user → admin and writes audit', async () => {
    ;(db.select as Mock).mockReturnValueOnce(
      makeWhereGet({ id: 'usr_x', username: 'alice', role: 'user' }),
    )
    const res = await patch('usr_x', { role: 'admin' })
    expect(res.status).toBe(200)
    expect((logAudit as Mock).mock.calls[0][1]).toMatchObject({
      action: 'audit.constant.user.role.updated',
      details: { username: 'alice', from: 'user', to: 'admin' },
    })
  })

  it('rejects demoting the last admin', async () => {
    ;(db.select as Mock).mockReturnValueOnce(
      makeWhereGet({ id: 'usr_lone', username: 'admin', role: 'admin', isActive: true }),
    )
    // The guarded UPDATE matches no row: this is the only active admin.
    ;(db.update as Mock).mockReturnValue(makeUpdateChain([]))

    const res = await patch('usr_lone', { role: 'user' })
    expect(res.status).toBe(400)
    expect(((await res.json()) as { error: string }).error).toBe('LAST_ADMIN_CANNOT_DEMOTE')
  })

  it('allows demoting an already-disabled admin even when one active admin remains', async () => {
    // A disabled admin contributes nothing to the usable-admin pool, so demoting it
    // cannot cost the system its last administrator — the guard must not fire.
    ;(db.select as Mock).mockReturnValueOnce(
      makeWhereGet({ id: 'usr_off', username: 'leaver', role: 'admin', isActive: false }),
    )

    const res = await patch('usr_off', { role: 'user' })
    expect(res.status).toBe(200)
  })

  it('allows demoting an admin when others exist', async () => {
    ;(db.select as Mock).mockReturnValueOnce(
      makeWhereGet({ id: 'usr_a', username: 'alice', role: 'admin', isActive: true }),
    )
    ;(db.update as Mock).mockReturnValue(makeUpdateChain([{ id: 'usr_a' }]))

    const res = await patch('usr_a', { role: 'user' })
    expect(res.status).toBe(200)
  })

  it('is a no-op when role is unchanged', async () => {
    ;(db.select as Mock).mockReturnValueOnce(
      makeWhereGet({ id: 'usr_x', username: 'alice', role: 'user' }),
    )
    const res = await patch('usr_x', { role: 'user' })
    expect(res.status).toBe(200)
    // No audit on no-op
    expect(logAudit).not.toHaveBeenCalled()
  })
})

describe('GET /users (list returns email + idaasSub)', () => {
  let app: Hono

  beforeEach(async () => {
    vi.clearAllMocks()

    const sampleUsers = [
      {
        id: 'usr_sso',
        username: 'johndoe',
        displayName: null,
        email: 'johndoe@example.com',
        idaasSub: 'sub-x',
        role: 'user',
        isActive: true,
        createdAt: new Date(),
        updatedAt: new Date(),
      },
      {
        id: 'usr_admin',
        username: 'admin',
        displayName: 'Administrator',
        email: null,
        idaasSub: null,
        role: 'admin',
        isActive: true,
        createdAt: new Date(),
        updatedAt: new Date(),
      },
    ]
    ;(db.select as Mock).mockImplementation((cols?: Record<string, unknown>) => {
      // count(*)
      if (cols && Object.keys(cols).length === 1 && 'count' in cols) {
        return { from: () => asyncQuery({ get: () => ({ count: sampleUsers.length }) }) }
      }
      // user list
      return {
        from: () => ({
          orderBy: () => ({
            limit: () => ({
              offset: () =>
                asyncQuery({
                  all: () => sampleUsers,
                }),
            }),
          }),
        }),
      }
    })

    const mod = await import('../users.js')
    app = new Hono()
    app.use('*', async (c, next) => {
      c.set('userId' as never, 'usr_admin' as never)
      c.set('userRole' as never, 'admin' as never)
      await next()
    })
    app.route('/api/users', mod.default)
  })

  it('includes email and idaasSub in the response', async () => {
    const res = await app.request('/api/users')
    expect(res.status).toBe(200)
    const body = (await res.json()) as {
      data: Array<{ email: string | null; idaasSub: string | null }>
    }
    const sso = body.data.find((u) => u.email === 'johndoe@example.com')
    expect(sso).toBeDefined()
    expect(sso?.idaasSub).toBe('sub-x')
  })
})
