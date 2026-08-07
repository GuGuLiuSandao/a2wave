/**
 * Shared Drizzle ORM mock chain builders.
 *
 * These replicate the fluent API of drizzle-orm (select/insert/update/delete)
 * with vi.fn() mocks, so you can control return values and assert calls.
 *
 * **Async shape.** The PostgreSQL driver has no synchronous API, so production
 * code now awaits every query rather than terminating the chain with
 * `.get()` / `.all()` / `.run()`. The mocks mirror that: each node is a real
 * Promise (built with `Object.assign(Promise.resolve(...), { ...methods })`), so
 * it can be awaited *or* chained further — `db.select().from(x)` and
 * `db.select().from(x).where(y).limit(1)` both work, and both resolve to an
 * array of rows.
 *
 * The legacy `.get()` / `.all()` / `.run()` terminators are kept as aliases so
 * the many tests that still call them keep passing while the suite is migrated.
 *
 * Usage:
 *   import { db } from '../../db/client.js'
 *   vi.mock('../../db/client.js', () => ({ db: createMockDrizzleDb() }))
 *
 *   const mockDb = db as unknown as MockDrizzleDb
 *   mockDb.select.mockReturnValue(makeSelectChain(myRow))
 */
import { type Mock, vi } from 'vitest'

/** Normalise a configured result into the row array a query resolves to. */
function toRows(result: unknown): unknown[] {
  if (Array.isArray(result)) return result
  return result == null ? [] : [result]
}

/** The single row a `.limit(1)`-style lookup yields, or undefined. */
function toRow(result: unknown): unknown {
  return Array.isArray(result) ? result[0] : result
}

/**
 * A thenable that is also a query builder.
 *
 * Awaiting it resolves to `rows`; calling any builder method returns another
 * node of the same shape, so a chain of arbitrary length terminates correctly.
 */
function queryNode(rows: unknown[], single: unknown): Record<string, unknown> {
  const node = Object.assign(Promise.resolve(rows), {
    where: vi.fn(() => queryNode(rows, single)),
    orderBy: vi.fn(() => queryNode(rows, single)),
    groupBy: vi.fn(() => queryNode(rows, single)),
    having: vi.fn(() => queryNode(rows, single)),
    innerJoin: vi.fn(() => queryNode(rows, single)),
    leftJoin: vi.fn(() => queryNode(rows, single)),
    offset: vi.fn(() => queryNode(rows, single)),
    for: vi.fn(() => queryNode(rows, single)),
    // `.limit(1)` is how a single-row lookup is spelled now; callers
    // destructure `[row]`, so resolving to the one-row array is what matters.
    limit: vi.fn(() => queryNode(rows, single)),
    // Legacy sync terminators, retained so un-migrated tests keep working.
    get: vi.fn(() => single),
    all: vi.fn(() => rows),
    run: vi.fn(() => ({ changes: rows.length })),
  })
  return node as unknown as Record<string, unknown>
}

/** Build a mock chain for `db.select().from()...` (awaitable at any depth). */
export function makeSelectChain(result: unknown): Record<string, unknown> {
  const rows = toRows(result)
  const single = toRow(result)
  return {
    from: vi.fn(() => queryNode(rows, single)),
  }
}

/** Build a mock chain for `db.insert().values()` / `.returning()`. */
export function makeInsertChain(returnValue?: unknown): Record<string, unknown> {
  const rows = toRows(returnValue ?? {})
  const single = toRow(returnValue ?? {})
  return {
    values: vi.fn(() =>
      Object.assign(Promise.resolve(rows), {
        returning: vi.fn(() => queryNode(rows, single)),
        onConflictDoNothing: vi.fn(() => queryNode(rows, single)),
        onConflictDoUpdate: vi.fn(() => queryNode(rows, single)),
        get: vi.fn(() => single),
        run: vi.fn(() => ({ changes: rows.length })),
      }),
    ),
  }
}

/** Build a mock chain for `db.update().set().where()`. */
export function makeUpdateChain(): Record<string, unknown> {
  return {
    set: vi.fn(() => queryNode([], undefined)),
  }
}

/** Build a mock chain for `db.update().set().where().returning()`. */
export function makeUpdateReturningChain(returnValue?: unknown): Record<string, unknown> {
  const rows = toRows(returnValue ?? {})
  const single = toRow(returnValue ?? {})
  return {
    set: vi.fn(() => queryNode(rows, single)),
  }
}

/** Build a mock chain for `db.delete().where()` / `.returning()`. */
export function makeDeleteChain(): Record<string, unknown> {
  return {
    where: vi.fn(() => queryNode([], undefined)),
  }
}

export interface MockDrizzleDb {
  select: Mock
  insert: Mock
  update: Mock
  delete: Mock
  transaction: Mock
}

/** Create a full mock db object suitable for vi.mock('../../db/client.js') */
export function createMockDrizzleDb(): MockDrizzleDb {
  return {
    select: vi.fn(),
    insert: vi.fn(),
    update: vi.fn(),
    delete: vi.fn(),
    // Transactions are awaited now; run the callback against the same mock so a
    // test that configures `db.select` also covers work done inside a tx.
    transaction: vi.fn(async (fn: (tx: unknown) => unknown) => await fn(createMockDrizzleDb())),
  }
}
