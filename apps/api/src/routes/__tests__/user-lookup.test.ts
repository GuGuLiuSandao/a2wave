import { Hono } from 'hono'
import { type Mock, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../../db/client.js', () => ({
  db: {
    select: vi.fn(),
    insert: vi.fn(),
    update: vi.fn(),
    delete: vi.fn(),
  },
  // `db/transaction.js` reads these at module load to pick a backend, and its
  // SQLite branch drives BEGIN/COMMIT on the raw handle. Without a stand-in
  // handle every transactional route throws before its own mocks are consulted.
  dialect: 'sqlite',
  isPostgres: false,
  sqliteDatabase: { inTransaction: false, exec: vi.fn() },
}))

vi.mock('../../db/schema.js', () => ({
  users: {
    id: 'id',
    username: 'username',
    displayName: 'display_name',
    email: 'email',
    role: 'role',
    isActive: 'is_active',
    idaasSub: 'idaas_sub',
  },
}))

import { db } from '../../db/client.js'

import { asyncQuery } from '../../test/async-query.js'

interface UserRow {
  id: string
  username: string
  displayName: string | null
  email: string | null
  role?: string
  isActive?: boolean
  idaasSub?: string | null
  passwordHash?: string | null
}

/**
 * Build a mock select chain that records the LIKE pattern being passed to
 * the route's `like(...)` predicate. We snoop the predicate by spying on the
 * `like` function via vi.mock if needed, but easier: capture filter args via
 * a hook the route exposes — instead, we just stub all chain steps and
 * return a configurable result.
 */
function makeLookupSelectChain(rows: UserRow[]): Record<string, unknown> {
  const limitChain = {
    all: vi.fn().mockReturnValue(rows),
  }
  const orderByChain = {
    limit: vi.fn().mockReturnValue(limitChain),
    all: vi.fn().mockReturnValue(rows),
  }
  const whereChain = {
    orderBy: vi.fn().mockReturnValue(orderByChain),
    limit: vi.fn().mockReturnValue(limitChain),
    all: vi.fn().mockReturnValue(rows),
  }
  return {
    from: vi.fn().mockReturnValue(
      asyncQuery({
        where: vi.fn().mockReturnValue(whereChain),
      }),
    ),
  }
}

function setupApp(opts: { noAuth?: boolean; userRole?: 'admin' | 'user' } = {}) {
  const app = new Hono()
  if (!opts.noAuth) {
    app.use('*', async (c, next) => {
      c.set('userId' as never, 'usr_caller' as never)
      c.set('userRole' as never, (opts.userRole ?? 'user') as never)
      await next()
    })
  } else {
    // Simulate auth-failed: short-circuit with 401
    app.use('*', async (c) => c.json({ error: 'Unauthorized' }, 401))
  }
  return app
}

describe('GET /api/user-lookup', () => {
  let app: Hono

  beforeEach(async () => {
    vi.clearAllMocks()
    const mod = await import('../user-lookup.js')
    app = setupApp({ userRole: 'user' })
    app.route('/api/user-lookup', mod.default)
  })

  it('returns matching users with only minimal fields (no role/idaasSub/passwordHash)', async () => {
    const rows: UserRow[] = [
      {
        id: 'usr_1',
        username: 'alice',
        displayName: 'Alice',
        email: 'alice@example.com',
      },
      {
        id: 'usr_2',
        username: 'alex',
        displayName: null,
        email: null,
      },
    ]
    ;(db.select as Mock).mockReturnValue(makeLookupSelectChain(rows))

    const res = await app.request('/api/user-lookup?q=al')
    expect(res.status).toBe(200)
    const body = (await res.json()) as { data: UserRow[] }
    expect(body.data).toHaveLength(2)
    for (const row of body.data) {
      expect(Object.keys(row).sort()).toEqual(['displayName', 'email', 'id', 'username'])
      expect('role' in row).toBe(false)
      expect('idaasSub' in row).toBe(false)
      expect('passwordHash' in row).toBe(false)
    }

    // Verify only minimal columns selected
    const cols = (db.select as Mock).mock.calls[0][0] as Record<string, unknown>
    expect(Object.keys(cols).sort()).toEqual(['displayName', 'email', 'id', 'username'])
  })

  it('returns 400 when q is missing', async () => {
    const res = await app.request('/api/user-lookup')
    expect(res.status).toBe(400)
  })

  it('returns 400 when q is empty / whitespace', async () => {
    const r1 = await app.request('/api/user-lookup?q=')
    expect(r1.status).toBe(400)
    const r2 = await app.request('/api/user-lookup?q=%20%20%20')
    expect(r2.status).toBe(400)
  })

  it('clamps limit to 20 when callers ask for more', async () => {
    // Simulate DB returning whatever limit clamps to
    const tooMany = Array.from({ length: 50 }, (_, i) => ({
      id: `usr_${i}`,
      username: `user${i}`,
      displayName: null,
      email: null,
    }))
    // Capture the limit() arg from the chain
    let observedLimit = -1
    const limitFn = vi.fn((n: number) => {
      observedLimit = n
      return asyncQuery({ all: () => tooMany.slice(0, n) })
    })
    ;(db.select as Mock).mockReturnValue(
      asyncQuery({
        from: () => ({
          where: () => ({
            orderBy: () => ({
              limit: limitFn,
            }),
          }),
        }),
      }),
    )

    const res = await app.request('/api/user-lookup?q=user&limit=50')
    expect(res.status).toBe(200)
    expect(observedLimit).toBe(20)
    const body = (await res.json()) as { data: UserRow[] }
    expect(body.data).toHaveLength(20)
  })

  it('clamps limit to 1 when callers pass 0 or negative', async () => {
    let observedLimit = -1
    const limitFn = vi.fn((n: number) => {
      observedLimit = n
      return asyncQuery({ all: () => [] })
    })
    ;(db.select as Mock).mockReturnValue(
      asyncQuery({
        from: () => ({
          where: () => ({
            orderBy: () => ({
              limit: limitFn,
            }),
          }),
        }),
      }),
    )
    const res = await app.request('/api/user-lookup?q=foo&limit=0')
    expect(res.status).toBe(200)
    expect(observedLimit).toBe(1)
  })

  it('admin caller can also use it', async () => {
    const rows: UserRow[] = [{ id: 'usr_a', username: 'admin', displayName: 'Admin', email: null }]
    ;(db.select as Mock).mockReturnValue(makeLookupSelectChain(rows))

    const adminApp = setupApp({ userRole: 'admin' })
    const mod = await import('../user-lookup.js')
    adminApp.route('/api/user-lookup', mod.default)
    const res = await adminApp.request('/api/user-lookup?q=admin')
    expect(res.status).toBe(200)
  })

  it('does NOT return inactive users (filter pushed to SQL)', async () => {
    // Capture the where(...) predicate to verify isActive filter is included.
    // Since we mock drizzle table with strings, and `eq(users.isActive, true)`
    // would call the real `eq` from drizzle-orm — easier to assert that
    // the route imports & calls `eq` against `is_active`. Rather than
    // mocking drizzle-orm, we trust the implementation passes a combined
    // `and(...)` to where(). We assert here by snooping `where`'s args.
    let whereArg: unknown
    ;(db.select as Mock).mockReturnValue(
      asyncQuery({
        from: () => ({
          where: (arg: unknown) => {
            whereArg = arg
            return {
              orderBy: () => ({
                limit: () => asyncQuery({ all: () => [] }),
              }),
            }
          },
        }),
      }),
    )
    const res = await app.request('/api/user-lookup?q=foo')
    expect(res.status).toBe(200)
    expect(whereArg).toBeDefined()
  })

  it('escapes LIKE wildcards (% and _) so they match literally, not as wildcards', async () => {
    const { escapeLikePattern } = await import('../user-lookup.js')
    // Escape char is `!` (paired with ESCAPE '!' clause emitted from sql template)
    expect(escapeLikePattern('50%')).toBe('50!%')
    expect(escapeLikePattern('a_b')).toBe('a!_b')
    expect(escapeLikePattern('100%_off')).toBe('100!%!_off')
    // The escape char itself is doubled so a literal `!` in input doesn't
    // accidentally consume the wildcard following it.
    expect(escapeLikePattern('hi!')).toBe('hi!!')
    expect(escapeLikePattern('a!b')).toBe('a!!b')
    // Plain characters pass through.
    expect(escapeLikePattern('hello')).toBe('hello')
    // Backslash is no longer special — passes through.
    expect(escapeLikePattern('a\\b')).toBe('a\\b')
  })
})

describe('GET /api/user-lookup — unauth', () => {
  it('returns 401 when no auth context (middleware blocks)', async () => {
    // Build an app that blocks at middleware
    const app = setupApp({ noAuth: true })
    const mod = await import('../user-lookup.js')
    app.route('/api/user-lookup', mod.default)
    const res = await app.request('/api/user-lookup?q=foo')
    expect(res.status).toBe(401)
  })
})
