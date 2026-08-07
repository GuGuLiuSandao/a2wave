/**
 * `getSettingsVersions()` must read the **database**, through the executor it is
 * given — never the settings cache.
 *
 * Two separate bugs meet in this function, and the fix for the first briefly
 * caused the second:
 *
 *  1. It used to call `db.select().from(...).all()`. `.all()` is a better-sqlite3
 *     affordance that the node-postgres builder does not have, so on PostgreSQL
 *     this was a `TypeError`, not a slow path — it took down `GET /api/settings`,
 *     the optimistic-concurrency precondition inside `PATCH /api/settings`, and
 *     `GET /api/settings/:category` at once.
 *
 *  2. Making it read the synchronous cache fixed that but broke the 409: the
 *     cache is only refreshed AFTER the PATCH transaction commits, so two
 *     concurrent PATCHes holding the same stale `expectedVersions` both passed
 *     the check and the second silently clobbered the first. On multi-replica
 *     PostgreSQL a replica that never handles a write never refreshes at all, so
 *     its comparison snapshot is permanently stale.
 *
 * Hence the current contract, which this file pins: **async, reads the DB, and
 * accepts an executor so the conflict check can read through its own `tx`** —
 * the same snapshot its writes commit against. This function is deliberately not
 * one of the ~22 synchronous readers the cache exists to serve.
 *
 * The db mock is shaped like the **PostgreSQL** builder: a bare thenable with no
 * `.all()`/`.get()`/`.run()`. That is what gives the file teeth — a mock
 * offering `.all()` (as the sibling `settings.test.ts` one does, standing in for
 * SQLite) would let bug 1 pass unnoticed.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

/** Rows the PostgreSQL-shaped builder resolves with, and a call counter. */
const pgRows: { value: { category: string; key: string; value: string }[]; selectCalls: number } = {
  value: [],
  selectCalls: 0,
}

function pgBuilder() {
  return {
    // biome-ignore lint/suspicious/noThenProperty: being awaitable-and-nothing-else IS the drizzle/node-postgres builder shape this stands in for.
    then: (onFulfilled?: (v: unknown[]) => unknown) =>
      Promise.resolve(pgRows.value).then(onFulfilled),
  }
}

vi.mock('../../db/client.js', () => ({
  isPostgres: true,
  db: {
    select: () => {
      pgRows.selectCalls++
      return { from: () => pgBuilder() }
    },
  },
}))

import { invalidateSettingsCache, primeSettingsCache } from '../settings-cache.js'
import { getSettingsVersions, settingsVersionToken } from '../settings.js'

beforeEach(() => {
  invalidateSettingsCache()
  pgRows.value = []
  pgRows.selectCalls = 0
})

describe('getSettingsVersions on a PostgreSQL-shaped driver', () => {
  it('derives the version map from the database', async () => {
    pgRows.value = [
      { category: 'auth', key: 'defaultRole', value: 'admin' },
      { category: 'branding', key: 'subtitle', value: 'Agent workflow' },
    ]

    await expect(getSettingsVersions()).resolves.toEqual({
      'auth.defaultRole': settingsVersionToken('admin'),
      'branding.subtitle': settingsVersionToken('Agent workflow'),
    })
    expect(pgRows.selectCalls).toBe(1)
  })

  it('does NOT read the cache — a stale snapshot would defeat the 409 check', async () => {
    // Cache says one thing, database says another. The 409 precondition compares
    // what the client echoed against what is actually stored, so the DB must win;
    // reading the cache here is exactly the regression this pins.
    primeSettingsCache([{ category: 'auth', key: 'defaultRole', value: 'stale-from-cache' }])
    pgRows.value = [{ category: 'auth', key: 'defaultRole', value: 'fresh-from-db' }]

    await expect(getSettingsVersions()).resolves.toEqual({
      'auth.defaultRole': settingsVersionToken('fresh-from-db'),
    })
    expect(pgRows.selectCalls).toBe(1)
  })

  it('reads through the executor it is handed, so the check can use its own tx', async () => {
    let txSelects = 0
    const tx = {
      select: () => {
        txSelects++
        return { from: () => pgBuilder() }
      },
    } as unknown as Parameters<typeof getSettingsVersions>[0]
    pgRows.value = [{ category: 'auth', key: 'passwordLoginEnabled', value: 'false' }]

    await expect(getSettingsVersions(tx)).resolves.toEqual({
      'auth.passwordLoginEnabled': settingsVersionToken('false'),
    })
    // Through the transaction handle only — never the ambient connection, which
    // on PostgreSQL would be a different pooled client outside the transaction.
    expect(txSelects).toBe(1)
    expect(pgRows.selectCalls).toBe(0)
  })

  it('yields an empty map when nothing is stored', async () => {
    await expect(getSettingsVersions()).resolves.toEqual({})
  })

  it('gives distinct tokens to distinct values, which is what the 409 check compares', async () => {
    pgRows.value = [{ category: 'auth', key: 'defaultRole', value: 'user' }]
    const before = (await getSettingsVersions())['auth.defaultRole']

    pgRows.value = [{ category: 'auth', key: 'defaultRole', value: 'admin' }]
    const after = (await getSettingsVersions())['auth.defaultRole']

    expect(before).not.toBe(after)
  })
})
