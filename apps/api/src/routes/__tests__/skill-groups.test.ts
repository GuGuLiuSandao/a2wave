import { Hono } from 'hono'
import { type Mock, beforeEach, describe, expect, it, vi } from 'vitest'

const skillGroupTestState = vi.hoisted(() => ({
  isAdmin: true,
  userId: 'usr_admin',
  transactionSelectRows: [] as unknown[],
  transactionSelectWhereCalls: [] as unknown[],
  transactionUpdateCallCount: 0,
  transactionUpdatedGroup: { id: 'skg_test1', name: 'Updated' } as
    | { id: string; name: string }
    | undefined,
}))

vi.mock('../../db/client.js', () => ({
  db: {
    select: vi.fn(),
    insert: vi.fn(),
    update: vi.fn(),
    delete: vi.fn(),
    transaction: vi.fn((cb: (tx: unknown) => unknown) => {
      const tx = {
        select: vi.fn(),
        update: vi.fn(),
        delete: vi.fn(),
        insert: vi.fn(),
      }
      ;(tx.select as Mock).mockReturnValue(
        asyncQuery({
          from: vi.fn().mockReturnValue(
            asyncQuery({
              where: vi.fn((condition: unknown) => {
                skillGroupTestState.transactionSelectWhereCalls.push(condition)
                return asyncQuery({
                  all: vi.fn().mockReturnValue(skillGroupTestState.transactionSelectRows),
                })
              }),
              all: vi.fn().mockReturnValue([]),
            }),
          ),
        }),
      )
      ;(tx.delete as Mock).mockReturnValue(
        asyncQuery({ where: vi.fn().mockReturnValue(asyncQuery({ run: vi.fn() })) }),
      )
      ;(tx.update as Mock).mockImplementation(() => {
        skillGroupTestState.transactionUpdateCallCount++
        return asyncQuery({
          set: vi.fn().mockReturnValue(
            asyncQuery({
              where: vi.fn().mockReturnValue(
                asyncQuery({
                  run: vi.fn(),
                  returning: vi.fn().mockReturnValue(
                    asyncQuery({
                      get: vi.fn(() => skillGroupTestState.transactionUpdatedGroup),
                    }),
                  ),
                }),
              ),
            }),
          ),
        })
      })
      ;(tx.insert as Mock).mockReturnValue(
        asyncQuery({
          values: vi.fn().mockReturnValue(
            asyncQuery({
              returning: vi.fn().mockReturnValue(
                asyncQuery({
                  get: vi.fn().mockReturnValue({ id: 'skg_test1', name: 'C' }),
                }),
              ),
            }),
          ),
        }),
      )
      return cb(tx)
    }),
  },
  // `db/transaction.js` reads these at module load to pick a backend. Reporting
  // PostgreSQL routes withTransaction() through the mocked `db.transaction`
  // above, so the callback receives the `tx` stub these tests assert on. The
  // SQLite branch would instead pass the shared `db` and drive BEGIN/COMMIT on a
  // real better-sqlite3 handle, which this suite does not stand up.
  dialect: 'postgres',
  isPostgres: true,
  sqliteDatabase: null,
}))

vi.mock('../../lib/id.js', () => ({
  createId: vi.fn(() => 'skg_test1'),
}))

vi.mock('../../lib/owner-filter.js', async () => {
  const { eq } = await vi.importActual<typeof import('drizzle-orm')>('drizzle-orm')
  return {
    getOwnerFilter: vi.fn((_c: unknown, column: Parameters<typeof eq>[0]) =>
      skillGroupTestState.isAdmin ? undefined : eq(column, skillGroupTestState.userId),
    ),
    getCurrentUserId: vi.fn(() => skillGroupTestState.userId),
  }
})

vi.mock('../../lib/audit.js', () => ({
  logAudit: vi.fn(),
}))

function makeDbChain(result: unknown) {
  // An array result models a multi-row query, so it must NOT also expose `get`:
  // `asyncQuery` consults `get` first and would wrap the whole array as one row.
  const leaf = Array.isArray(result)
    ? { all: vi.fn().mockReturnValue(result) }
    : {
        get: vi.fn().mockReturnValue(result),
        all: vi.fn().mockReturnValue(result ? [result] : []),
      }
  return asyncQuery({
    from: vi.fn().mockReturnValue(
      asyncQuery({
        where: vi.fn().mockReturnValue(asyncQuery(leaf)),
        all: vi.fn().mockReturnValue(Array.isArray(result) ? result : result ? [result] : []),
      }),
    ),
  })
}

function makePaginatedSelectChain(rows: unknown[]) {
  return asyncQuery({
    from: vi.fn().mockReturnValue(
      asyncQuery({
        where: vi.fn().mockReturnValue(
          asyncQuery({
            orderBy: vi.fn().mockReturnValue(
              asyncQuery({
                limit: vi.fn().mockReturnValue(
                  asyncQuery({
                    offset: vi.fn().mockReturnValue(asyncQuery({ all: vi.fn(() => rows) })),
                  }),
                ),
              }),
            ),
          }),
        ),
      }),
    ),
  })
}

function makeCountChain(n: number) {
  return asyncQuery({
    from: vi.fn().mockReturnValue(
      asyncQuery({
        where: vi.fn().mockReturnValue(asyncQuery({ get: vi.fn().mockReturnValue({ count: n }) })),
      }),
    ),
  })
}

import { db } from '../../db/client.js'
import { asyncQuery } from '../../test/async-query.js'

describe('Skill Groups routes', () => {
  let app: Hono

  beforeEach(async () => {
    vi.clearAllMocks()
    skillGroupTestState.isAdmin = true
    skillGroupTestState.userId = 'usr_admin'
    skillGroupTestState.transactionSelectRows = []
    skillGroupTestState.transactionSelectWhereCalls = []
    skillGroupTestState.transactionUpdateCallCount = 0
    skillGroupTestState.transactionUpdatedGroup = { id: 'skg_test1', name: 'Updated' }
    const mod = await import('../skill-groups.js')
    app = new Hono()
    app.route('/api/skill-groups', mod.default)
  })

  describe('GET /', () => {
    it('returns paginated groups with owner-level binding safety', async () => {
      const rows = [
        { id: 'skg_safe', name: 'Safe', userId: 'usr_owner' },
        { id: 'skg_unsafe', name: 'Unsafe', userId: 'usr_owner' },
      ]
      ;(db.select as Mock)
        .mockReturnValueOnce(makeCountChain(rows.length))
        .mockReturnValueOnce(makePaginatedSelectChain(rows))
        .mockReturnValueOnce(
          makeDbChain([
            {
              groupId: 'skg_safe',
              userId: 'usr_owner',
              visibility: 'private',
            },
            {
              groupId: 'skg_unsafe',
              userId: 'usr_other',
              visibility: 'private',
            },
          ]),
        )

      const res = await app.request('/api/skill-groups')
      expect(res.status).toBe(200)
      const body = (await res.json()) as {
        data: Array<{ id: string; ownerCanBindAllSkills: boolean }>
        pagination: { total: number }
      }
      expect(body.data).toEqual([
        { ...rows[0], ownerCanBindAllSkills: true },
        { ...rows[1], ownerCanBindAllSkills: false },
      ])
      expect(body.pagination.total).toBe(2)
    })
  })

  describe('GET /:id', () => {
    it('returns 404 when not found', async () => {
      ;(db.select as Mock).mockReturnValue(makeDbChain(undefined))
      const res = await app.request('/api/skill-groups/skg_none')
      expect(res.status).toBe(404)
    })

    it('returns the group when found', async () => {
      ;(db.select as Mock).mockReturnValue(makeDbChain({ id: 'skg_1', name: 'G' }))
      const res = await app.request('/api/skill-groups/skg_1')
      expect(res.status).toBe(200)
      const body = (await res.json()) as { data: { id: string } }
      expect(body.data.id).toBe('skg_1')
    })
  })

  describe('GET /:id/skills', () => {
    it('returns member skill IDs', async () => {
      ;(db.select as Mock)
        // group lookup
        .mockReturnValueOnce(makeDbChain({ id: 'skg_1', name: 'G' }))
        // skills where group_id = skg_1
        .mockReturnValueOnce(
          asyncQuery({
            from: vi.fn().mockReturnValue(
              asyncQuery({
                where: vi.fn().mockReturnValue(
                  asyncQuery({
                    all: vi.fn().mockReturnValue([{ id: 'skl_a' }, { id: 'skl_b' }]),
                  }),
                ),
              }),
            ),
          }),
        )
      const res = await app.request('/api/skill-groups/skg_1/skills')
      expect(res.status).toBe(200)
      const body = (await res.json()) as { data: string[] }
      expect(body.data).toEqual(['skl_a', 'skl_b'])
    })
  })

  describe('POST /', () => {
    it('rejects empty name', async () => {
      const res = await app.request('/api/skill-groups', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: '' }),
      })
      expect(res.status).toBe(400)
    })

    it('creates a group (only visible skillIds get assigned)', async () => {
      // filterVisibleSkillIds runs `select({id}).from(skills).where(...).all()`
      ;(db.select as Mock).mockReturnValue(
        asyncQuery({
          from: vi.fn().mockReturnValue(
            asyncQuery({
              where: vi.fn().mockReturnValue(
                asyncQuery({
                  all: vi.fn().mockReturnValue([{ id: 'skl_a' }]),
                }),
              ),
            }),
          ),
        }),
      )
      // `withTransaction`'s SQLite branch hands the callback the shared `db`
      // handle, not a separate `tx` object, so the writes land on these mocks.
      ;(db.insert as Mock).mockReturnValue(
        asyncQuery({
          values: vi.fn().mockReturnValue(
            asyncQuery({
              returning: vi
                .fn()
                .mockReturnValue(
                  asyncQuery({ get: vi.fn().mockReturnValue({ id: 'skg_test1', name: 'C' }) }),
                ),
            }),
          ),
        }),
      )
      ;(db.update as Mock).mockReturnValue(
        asyncQuery({
          set: vi
            .fn()
            .mockReturnValue(asyncQuery({ where: vi.fn().mockReturnValue(asyncQuery({})) })),
        }),
      )

      const res = await app.request('/api/skill-groups', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'C', skillIds: ['skl_a', 'skl_missing'] }),
      })
      expect(res.status).toBe(201)
    })
  })

  describe('PATCH /:id', () => {
    it('returns 404 when missing', async () => {
      ;(db.select as Mock).mockReturnValue(makeDbChain(undefined))
      const res = await app.request('/api/skill-groups/skg_none', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'X' }),
      })
      expect(res.status).toBe(404)
    })

    it('updates fields', async () => {
      ;(db.select as Mock).mockReturnValue(makeDbChain({ id: 'skg_1', name: 'Old' }))
      ;(db.update as Mock).mockReturnValue(
        asyncQuery({
          set: vi.fn().mockReturnValue(
            asyncQuery({
              where: vi.fn().mockReturnValue(
                asyncQuery({
                  returning: vi
                    .fn()
                    .mockReturnValue(
                      asyncQuery({ get: vi.fn().mockReturnValue({ id: 'skg_1', name: 'New' }) }),
                    ),
                }),
              ),
            }),
          ),
        }),
      )
      const res = await app.request('/api/skill-groups/skg_1', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'New' }),
      })
      expect(res.status).toBe(200)
      expect(db.transaction).toHaveBeenCalledWith(expect.any(Function))
    })

    it('returns 404 when the group disappears before the transactional update', async () => {
      skillGroupTestState.transactionUpdatedGroup = undefined
      ;(db.select as Mock).mockReturnValue(makeDbChain({ id: 'skg_1', name: 'Old' }))

      const res = await app.request('/api/skill-groups/skg_1', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'New' }),
      })

      expect(res.status).toBe(404)
      expect(skillGroupTestState.transactionUpdateCallCount).toBe(1)
      expect(db.transaction).toHaveBeenCalledWith(expect.any(Function))
    })

    it('only reconciles members owned by a regular user', async () => {
      skillGroupTestState.isAdmin = false
      skillGroupTestState.userId = 'usr_regular'
      skillGroupTestState.transactionSelectRows = [{ id: 'skl_owned' }]
      ;(db.select as Mock)
        .mockReturnValueOnce(makeDbChain({ id: 'skg_1', name: 'Old', userId: 'usr_regular' }))
        .mockReturnValueOnce(makeDbChain([{ id: 'skl_owned' }]))

      const res = await app.request('/api/skill-groups/skg_1', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ skillIds: ['skl_owned'] }),
      })

      expect(res.status).toBe(200)
      expect(skillGroupTestState.transactionSelectRows).toEqual([{ id: 'skl_owned' }])
      expect(skillGroupTestState.transactionSelectWhereCalls).toHaveLength(1)
      expect(skillGroupTestState.transactionSelectWhereCalls[0]).toBeDefined()
    })
  })

  describe('DELETE /:id', () => {
    it('returns 404 when missing', async () => {
      ;(db.select as Mock).mockReturnValue(makeDbChain(undefined))
      const res = await app.request('/api/skill-groups/skg_none', { method: 'DELETE' })
      expect(res.status).toBe(404)
    })

    it('deletes existing group', async () => {
      ;(db.select as Mock).mockReturnValue(makeDbChain({ id: 'skg_1', name: 'G' }))
      const res = await app.request('/api/skill-groups/skg_1', { method: 'DELETE' })
      expect(res.status).toBe(200)
      const body = (await res.json()) as { data: { id: string } }
      expect(body.data.id).toBe('skg_1')
      expect(db.transaction).toHaveBeenCalledWith(expect.any(Function))
    })

    it('blocks a regular user from deleting a group with foreign members', async () => {
      skillGroupTestState.isAdmin = false
      skillGroupTestState.userId = 'usr_regular'
      skillGroupTestState.transactionSelectRows = [
        { id: 'skl_foreign', userId: 'usr_admin', visibility: 'all-users' },
      ]
      ;(db.select as Mock).mockReturnValueOnce(
        makeDbChain({ id: 'skg_1', name: 'G', userId: 'usr_regular' }),
      )

      const res = await app.request('/api/skill-groups/skg_1', { method: 'DELETE' })

      expect(res.status).toBe(409)
      expect(String(((await res.json()) as { error: string }).error)).toContain(
        'managed by an administrator',
      )
      expect(db.transaction).toHaveBeenCalledWith(expect.any(Function))
      expect(skillGroupTestState.transactionUpdateCallCount).toBe(0)
    })

    it('releases members only after the in-transaction check sees owner-only rows', async () => {
      skillGroupTestState.isAdmin = false
      skillGroupTestState.userId = 'usr_regular'
      skillGroupTestState.transactionSelectRows = [{ id: 'skl_owned', userId: 'usr_regular' }]
      ;(db.select as Mock).mockReturnValueOnce(
        makeDbChain({ id: 'skg_1', name: 'G', userId: 'usr_regular' }),
      )

      const res = await app.request('/api/skill-groups/skg_1', { method: 'DELETE' })

      expect(res.status).toBe(200)
      expect(skillGroupTestState.transactionSelectWhereCalls).toHaveLength(1)
      expect(skillGroupTestState.transactionUpdateCallCount).toBeGreaterThan(0)
    })
  })
})
