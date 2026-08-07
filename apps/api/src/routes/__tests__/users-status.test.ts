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
    tokenVersion: 'token_version',
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
    USER_STATUS_UPDATED: 'audit.constant.user.status.updated',
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
function setReturning(setSpy: Mock, rows: unknown[]) {
  setSpy.mockReturnValue({ where: () => ({ returning: async () => rows }) })
}

describe('PATCH /users/:id/status', () => {
  let app: Hono
  let setSpy: Mock
  const CURRENT_USER = 'usr_admin'

  beforeEach(async () => {
    vi.clearAllMocks()
    setSpy = vi.fn(() => ({ where: () => ({ returning: async () => [{ id: 'usr_x' }] }) }))
    ;(db.update as Mock).mockReturnValue({ set: setSpy })

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
    return app.request(`/api/users/${id}/status`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
  }

  it('rejects disabling yourself', async () => {
    const res = await patch(CURRENT_USER, { isActive: false })
    expect(res.status).toBe(400)
    expect(((await res.json()) as { error: string }).error).toBe('CANNOT_DISABLE_SELF')
  })

  it('rejects a non-boolean isActive', async () => {
    const res = await patch('usr_other', { isActive: 'nope' })
    expect(res.status).toBe(400)
  })

  it('returns 404 when the target user is missing', async () => {
    ;(db.select as Mock).mockReturnValueOnce(makeWhereGet(undefined))
    const res = await patch('usr_ghost', { isActive: false })
    expect(res.status).toBe(404)
  })

  it('disables an active user, revokes tokens and writes audit', async () => {
    ;(db.select as Mock).mockReturnValueOnce(
      makeWhereGet({ id: 'usr_x', username: 'alice', role: 'user', isActive: true }),
    )
    const res = await patch('usr_x', { isActive: false })

    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ data: { id: 'usr_x', isActive: false } })
    // Disabling must revoke outstanding tokens
    expect(setSpy.mock.calls[0][0]).toHaveProperty('tokenVersion')
    expect((logAudit as Mock).mock.calls[0][1]).toMatchObject({
      action: 'audit.constant.user.status.updated',
      details: { username: 'alice', isActive: false },
    })
  })

  it('re-enables a disabled user without bumping tokenVersion', async () => {
    ;(db.select as Mock).mockReturnValueOnce(
      makeWhereGet({ id: 'usr_x', username: 'alice', role: 'user', isActive: false }),
    )
    const res = await patch('usr_x', { isActive: true })

    expect(res.status).toBe(200)
    expect(setSpy.mock.calls[0][0]).not.toHaveProperty('tokenVersion')
    expect((logAudit as Mock).mock.calls[0][1]).toMatchObject({
      details: { username: 'alice', isActive: true },
    })
  })

  it('rejects disabling the last active admin', async () => {
    ;(db.select as Mock).mockReturnValueOnce(
      makeWhereGet({ id: 'usr_lone', username: 'admin', role: 'admin', isActive: true }),
    )
    // The guarded UPDATE matches no row: no other active admin remains.
    setReturning(setSpy, [])

    const res = await patch('usr_lone', { isActive: false })
    expect(res.status).toBe(400)
    expect(((await res.json()) as { error: string }).error).toBe('LAST_ADMIN_CANNOT_DISABLE')
    // The write is now attempted, but is a no-op guarded by its own predicate —
    // so the assertion moves from "never issued" to "changed nothing".
    expect(db.update).toHaveBeenCalled()
  })

  it('allows disabling an admin when other active admins exist', async () => {
    ;(db.select as Mock).mockReturnValueOnce(
      makeWhereGet({ id: 'usr_a', username: 'alice', role: 'admin', isActive: true }),
    )
    setReturning(setSpy, [{ id: 'usr_a' }])

    const res = await patch('usr_a', { isActive: false })
    expect(res.status).toBe(200)
  })

  it('is a no-op when the status is unchanged', async () => {
    ;(db.select as Mock).mockReturnValueOnce(
      makeWhereGet({ id: 'usr_x', username: 'alice', role: 'user', isActive: true }),
    )
    const res = await patch('usr_x', { isActive: true })

    expect(res.status).toBe(200)
    expect(db.update).not.toHaveBeenCalled()
    expect(logAudit).not.toHaveBeenCalled()
  })
})
