/**
 * Both dialect branches of `withTransaction`.
 *
 * The SQLite half runs against a **real** in-memory better-sqlite3 + drizzle
 * stack rather than the shared Drizzle mock. That is the whole point: the bug
 * this helper fixes (`Transaction function cannot return a promise`) lives in
 * the driver, so a mocked chain reports success on exactly the code that fails
 * in production.
 */
import BetterSqlite3 from 'better-sqlite3'
import { eq } from 'drizzle-orm'
import { drizzle } from 'drizzle-orm/better-sqlite3'
import { sqliteTable, text } from 'drizzle-orm/sqlite-core'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { type TransactionDeps, runExclusive, withTransaction } from '../transaction.js'

const widgets = sqliteTable('widgets', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
})

type Db = TransactionDeps['db']

function createSqliteDeps() {
  const sqlite = new BetterSqlite3(':memory:')
  sqlite.exec('CREATE TABLE widgets (id TEXT PRIMARY KEY, name TEXT NOT NULL)')
  const orm = drizzle(sqlite, { schema: { widgets } })
  const deps: TransactionDeps = {
    db: orm as unknown as Db,
    isPostgres: false,
    sqlite,
  }
  const countRows = () =>
    (sqlite.prepare('SELECT count(*) AS c FROM widgets').get() as { c: number }).c
  return { sqlite, orm, deps, countRows }
}

/** Typed shim so a test table can be inserted through the narrowed `db` type. */
function insertWidget(tx: unknown, id: string, name: string) {
  return (tx as ReturnType<typeof drizzle<{ widgets: typeof widgets }>>)
    .insert(widgets)
    .values({ id, name })
}

describe('withTransaction — SQLite (real better-sqlite3)', () => {
  let ctx: ReturnType<typeof createSqliteDeps>

  beforeEach(() => {
    ctx = createSqliteDeps()
  })

  it('regression: an async callback would throw on the raw driver', async () => {
    // Pins the exact failure the helper exists to fix. If better-sqlite3 ever
    // learns async callbacks this test tells us the workaround can be dropped.
    // Note it throws *synchronously* — not as a rejection — so a call site that
    // only `await`s the result still crashes before any statement runs.
    expect(() =>
      ctx.orm.transaction(async (tx) => {
        await insertWidget(tx, 'w0', 'direct')
      }),
    ).toThrow(/cannot return a promise/i)
    expect(ctx.countRows()).toBe(0)
  })

  it('commits an async callback and returns its value', async () => {
    const result = await withTransaction(async (tx) => {
      await insertWidget(tx, 'w1', 'alpha')
      await insertWidget(tx, 'w2', 'beta')
      return { inserted: 2 }
    }, ctx.deps)

    expect(result).toEqual({ inserted: 2 })
    expect(ctx.countRows()).toBe(2)
    expect(ctx.sqlite.inTransaction).toBe(false)
  })

  it('rolls back every write when the callback throws, and re-throws the original error', async () => {
    class Sentinel extends Error {}

    await expect(
      withTransaction(async (tx) => {
        await insertWidget(tx, 'w1', 'alpha')
        throw new Sentinel('boom')
      }, ctx.deps),
    ).rejects.toBeInstanceOf(Sentinel)

    expect(ctx.countRows()).toBe(0)
    expect(ctx.sqlite.inTransaction).toBe(false)
  })

  it('rolls back writes issued fire-and-forget inside the callback', async () => {
    // logAudit/logBackgroundAudit never await their insert. drizzle still runs
    // the statement synchronously at `.catch()` time, so it must land inside
    // the BEGIN window and roll back with everything else.
    await expect(
      withTransaction(async (tx) => {
        await insertWidget(tx, 'w1', 'alpha')
        insertWidget(tx, 'w2', 'audit').catch(() => {})
        throw new Error('boom')
      }, ctx.deps),
    ).rejects.toThrow('boom')

    expect(ctx.countRows()).toBe(0)
  })

  it('passes through a falsy return value unchanged', async () => {
    await expect(withTransaction(async () => false, ctx.deps)).resolves.toBe(false)
    await expect(withTransaction(async () => null, ctx.deps)).resolves.toBeNull()
    await expect(withTransaction(async () => undefined, ctx.deps)).resolves.toBeUndefined()
  })

  it('joins an already-open transaction instead of issuing a nested BEGIN', async () => {
    ctx.sqlite.exec('BEGIN')
    try {
      const value = await withTransaction(async (tx) => {
        await insertWidget(tx, 'w1', 'alpha')
        return 'joined'
      }, ctx.deps)

      expect(value).toBe('joined')
      // The inner call must not have committed — the outer frame still owns it.
      expect(ctx.sqlite.inTransaction).toBe(true)
    } finally {
      ctx.sqlite.exec('ROLLBACK')
    }
    expect(ctx.countRows()).toBe(0)
  })

  it('joins a transaction opened by an enclosing withTransaction call', async () => {
    const value = await withTransaction(async (outer) => {
      await insertWidget(outer, 'w1', 'alpha')
      return await withTransaction(async (inner) => {
        await insertWidget(inner, 'w2', 'beta')
        return 'nested'
      }, ctx.deps)
    }, ctx.deps)

    expect(value).toBe('nested')
    expect(ctx.countRows()).toBe(2)
  })

  it('rolls back the outer transaction when a nested callback throws', async () => {
    await expect(
      withTransaction(async (outer) => {
        await insertWidget(outer, 'w1', 'alpha')
        await withTransaction(async (inner) => {
          await insertWidget(inner, 'w2', 'beta')
          throw new Error('inner failed')
        }, ctx.deps)
      }, ctx.deps),
    ).rejects.toThrow('inner failed')

    expect(ctx.countRows()).toBe(0)
    expect(ctx.sqlite.inTransaction).toBe(false)
  })

  it('serialises concurrent transactions instead of failing on a nested BEGIN', async () => {
    // Both callbacks await between their statements. Without the keyed lock the
    // second BEGIN would land inside the first window and throw.
    const order: string[] = []
    const body = (id: string) => async (tx: unknown) => {
      order.push(`${id}:start`)
      await insertWidget(tx, `${id}-1`, id)
      await Promise.resolve()
      await insertWidget(tx, `${id}-2`, id)
      order.push(`${id}:end`)
    }

    await Promise.all([withTransaction(body('a'), ctx.deps), withTransaction(body('b'), ctx.deps)])

    expect(ctx.countRows()).toBe(4)
    // No interleaving: each transaction finished before the next started.
    expect(order).toEqual(['a:start', 'a:end', 'b:start', 'b:end'])
  })

  it('leaves earlier transactions committed when a later one rolls back', async () => {
    await withTransaction(async (tx) => {
      await insertWidget(tx, 'w1', 'kept')
    }, ctx.deps)

    await expect(
      withTransaction(async (tx) => {
        await insertWidget(tx, 'w2', 'discarded')
        throw new Error('boom')
      }, ctx.deps),
    ).rejects.toThrow('boom')

    const rows = ctx.orm.select().from(widgets).where(eq(widgets.id, 'w1')).all()
    expect(rows).toHaveLength(1)
    expect(ctx.countRows()).toBe(1)
  })

  it('does not roll back an unrelated write that arrived while a transaction was open', async () => {
    // The ordering that matters, and that the concurrency test above does NOT
    // cover: the unrelated write arrives *after* BEGIN, not queued before it.
    //
    // Every `await` yields the event loop — including `await db.insert(...)`,
    // since drizzle's QueryPromise resolves through the microtask queue even
    // though better-sqlite3 itself is synchronous. So a request doing a plain
    // `db.insert` (67 such call sites, `logAudit` among them) can run while a
    // transaction is open. On a shared connection its write joins that
    // transaction and dies with it — after that request already returned 200.
    // Losing an audit entry that way breaches Iron Rule 5.
    let insideTransaction: (() => void) | undefined
    const reachedTransaction = new Promise<void>((resolve) => {
      insideTransaction = resolve
    })

    const outer = withTransaction(async (tx) => {
      await insertWidget(tx, 'owned', 'belongs-to-transaction')
      // Signal that BEGIN is open, then yield — exactly as any real callback
      // does at every `await`. The unrelated write below runs in this window.
      insideTransaction?.()
      await Promise.resolve()
      await Promise.resolve()
      throw new Error('outer fails for its own reasons')
    }, ctx.deps)

    await reachedTransaction
    // An unrelated caller that does NOT go through withTransaction — the shape
    // `logAudit` has. It must wait for the transaction rather than join it.
    const unrelated = runExclusive(
      async () => insertWidget(ctx.deps.db, 'unrelated', 'audit-entry'),
      ctx.deps,
    )

    await expect(outer).rejects.toThrow('outer fails for its own reasons')
    await unrelated

    // The transaction's own row is correctly gone.
    expect(ctx.orm.select().from(widgets).where(eq(widgets.id, 'owned')).all()).toHaveLength(0)
    // The unrelated write must survive: its request already reported success.
    expect(ctx.orm.select().from(widgets).where(eq(widgets.id, 'unrelated')).all()).toHaveLength(1)
  })

  it('runs the callback unwrapped when no raw SQLite handle is available', async () => {
    // Only reachable under a partial test mock of db/client.js; production
    // always has a handle. Must not throw — see the comment at the call site.
    const value = await withTransaction(
      async (tx) => {
        await insertWidget(tx, 'w1', 'alpha')
        return 'ran'
      },
      { db: ctx.deps.db, isPostgres: false, sqlite: null },
    )

    expect(value).toBe('ran')
    expect(ctx.countRows()).toBe(1)
  })
})

describe('withTransaction — PostgreSQL', () => {
  function createPgDeps() {
    const tx = { marker: 'pg-tx' }
    const transaction = vi.fn(async (cb: (tx: unknown) => Promise<unknown>) => await cb(tx))
    const deps: TransactionDeps = {
      db: { transaction } as unknown as Db,
      isPostgres: true,
      sqlite: null,
    }
    return { deps, transaction, tx }
  }

  it('delegates to drizzle and passes the real transaction handle through', async () => {
    const { deps, transaction, tx } = createPgDeps()
    let received: unknown

    const result = await withTransaction(async (handle) => {
      received = handle
      return 'ok'
    }, deps)

    expect(result).toBe('ok')
    expect(received).toBe(tx)
    expect(transaction).toHaveBeenCalledTimes(1)
  })

  it('propagates the callback error so drizzle rolls back', async () => {
    const { deps } = createPgDeps()
    class Sentinel extends Error {}

    await expect(
      withTransaction(async () => {
        throw new Sentinel('pg boom')
      }, deps),
    ).rejects.toBeInstanceOf(Sentinel)
  })

  it('never touches the SQLite handle', async () => {
    const sqlite = { inTransaction: false, exec: vi.fn() }
    const { deps } = createPgDeps()

    await withTransaction(async () => 'ok', {
      ...deps,
      sqlite: sqlite as unknown as TransactionDeps['sqlite'],
    })

    expect(sqlite.exec).not.toHaveBeenCalled()
  })
})
