/**
 * Dialect-aware transaction helper.
 *
 * ## Why this exists
 *
 * The codebase is written in the node-postgres style — `await tx.select()...`
 * inside an `async` callback. PostgreSQL supports that natively. better-sqlite3
 * does **not**: its driver is fully synchronous and `Database#transaction()`
 * rejects an async callback unconditionally with
 * `TypeError: Transaction function cannot return a promise`. Since SQLite is
 * still the default backend, every `db.transaction(async ...)` site is a
 * guaranteed runtime 500 on a default deployment.
 *
 * `withTransaction()` therefore branches on the dialect: PostgreSQL keeps
 * drizzle's real nested transaction, SQLite drives `BEGIN` / `COMMIT` /
 * `ROLLBACK` on the raw handle around an awaited callback.
 *
 * ## Atomicity argument (SQLite path)
 *
 * The SQLite branch hands the callback the **same** `db` handle rather than a
 * drizzle transaction object. That is sound, and here is exactly why:
 *
 *  1. **One connection.** better-sqlite3 exposes a single connection per
 *     `Database` instance, and a2wave opens exactly one for the process. A
 *     `BEGIN` issued on it therefore opens a transaction that *every*
 *     subsequent statement on `db` joins — there is no pool that could route a
 *     statement to a second connection outside the transaction. (This is the
 *     opposite of the PostgreSQL path, where using the outer `db` instead of
 *     `tx` silently escapes the transaction onto another pooled client.)
 *
 *  2. **Statements execute synchronously, at await time.** drizzle's
 *     `QueryPromise#then()` calls `execute()` *synchronously* when the builder
 *     is awaited, and better-sqlite3 runs the statement to completion before
 *     returning. So a statement issued between `BEGIN` and `COMMIT` has already
 *     hit the database by the time control returns to the event loop. Nothing
 *     is queued for later, so nothing can land after the `COMMIT`.
 *
 *  3. **No other transaction can interleave.** Node is single-threaded, so
 *     another task can only run while this callback is suspended at an `await`.
 *     Two defences cover that window: SQLite itself rejects a nested `BEGIN`
 *     ("cannot start a transaction within a transaction"), and — more usefully
 *     than failing — `withKeyedLock` serialises every SQLite transaction on one
 *     key, so a concurrent caller waits for this one to commit instead of
 *     erroring.
 *
 *  4. **Unrelated writes do not join the transaction.** This point used to claim
 *     the opposite — that a write from another code path landing mid-window
 *     "simply joins this transaction and commits with it — atomic, never lost" —
 *     and treated the remaining exposure as scope rather than correctness, on the
 *     premise that only non-DB I/O (`fetch`, `spawn`, a timer) could yield the
 *     event loop mid-callback.
 *
 *     That premise was wrong, and the bug it hid was real. **Every** `await`
 *     yields, `await db.insert(...)` included: drizzle's `QueryPromise` settles
 *     through the microtask queue even though better-sqlite3 runs the statement
 *     synchronously. So a callback awaiting nothing but its own queries still
 *     returns control to the loop between statements, and an unrelated request
 *     writing there was absorbed into this transaction — then erased by a
 *     ROLLBACK, after that request had already returned 200 to its caller.
 *     `logAudit` writes exactly that way, making it an Iron Rule 5 breach
 *     ("never drop an audit entry") rather than a scope caveat.
 *
 *     Non-transactional writes therefore go through `runExclusive`, which takes
 *     the same key and so *waits* for an open transaction instead of joining it.
 *     Ownership is tracked per async context (`AsyncLocalStorage`) rather than by
 *     the connection-wide `sqlite.inTransaction` flag, which cannot tell "my
 *     transaction" from "a stranger's".
 *
 *  5. **Rollback is exact.** A throw issues `ROLLBACK` and re-throws the
 *     original error, so callers keep the error they expect (several sites
 *     branch on a specific error type, e.g. `WorktreeOccupiedError`).
 *
 * Nesting is guarded rather than silently flattened: if a transaction is
 * somehow already open on the handle, this reuses it (a savepoint-free join)
 * instead of issuing a second `BEGIN` that SQLite would reject. The inner call
 * then neither commits nor rolls back — the outermost frame owns the boundary,
 * which is the same semantics drizzle gives a nested `db.transaction()`.
 */
import { AsyncLocalStorage } from 'node:async_hooks'
import { withKeyedLock } from '../lib/keyed-mutex.js'
import type { SqliteDatabase } from './client.js'
import * as client from './client.js'
import { isPostgresRuntime } from './dialect-runtime.js'

/**
 * Tracks whether *this* async context owns the open SQLite transaction.
 *
 * The connection-level `sqlite.inTransaction` flag cannot answer that question:
 * it is true for everyone once any caller issues BEGIN, which is precisely how
 * unrelated writes used to be absorbed into a stranger's transaction and lost on
 * rollback. `AsyncLocalStorage` propagates across `await`s along one logical
 * call chain and nowhere else, which is exactly the ownership scope needed.
 */
const transactionDepth = new AsyncLocalStorage<number>()

/**
 * The handle passed to a transaction callback.
 *
 * On PostgreSQL it is drizzle's real transaction object; on SQLite it is the
 * shared `db` itself (see the atomicity argument above). Both satisfy the same
 * structural query API, so call sites need no dialect awareness.
 */
export type TransactionHandle = typeof client.db

/**
 * Single key for every SQLite transaction.
 *
 * Not per-table or per-row: SQLite's write lock is database-wide and it has no
 * nested transaction support here, so any two transactions conflict regardless
 * of what they touch. One key is the accurate model.
 */
const SQLITE_TRANSACTION_KEY = 'db:sqlite:transaction'

/**
 * Injection seam — production always uses the real module-level handles.
 *
 * `sqlite` is a getter, not a value, so the PostgreSQL branch never reads it.
 * That matters under vitest: a `vi.mock` of `db/client.js` throws on *access*
 * to an export it did not define, so eagerly reading `sqliteDatabase` would
 * break every suite whose mock only supplies `db` — even though those tests
 * never reach the SQLite path.
 */
export interface TransactionDeps {
  db: typeof client.db
  isPostgres: boolean
  sqlite: SqliteDatabase | null
}

/**
 * Read the live client bindings, per call rather than once at import.
 *
 * Deliberately lazy for the same reason the `sqlite` getter is: binding these
 * at module scope would snapshot whichever values existed when this file was
 * first imported, and a partial mock supplying only `db` made this module throw
 * at *import* time, taking down suites that never touch transactions.
 *
 * The dialect comes from the shared `isPostgresRuntime()` rather than a local
 * read of `client.isPostgres`, so this helper and the dialect-sensitive SQL
 * builders in `lib/json-sql.ts` can never disagree about which backend they are
 * targeting within one process.
 */
function resolveDeps(): TransactionDeps {
  return {
    db: client.db,
    isPostgres: isPostgresRuntime(),
    get sqlite() {
      // Same reason isPostgresRuntime() guards its read: vitest throws on
      // access to an export a partial mock did not declare.
      try {
        return client.sqliteDatabase ?? null
      } catch {
        return null
      }
    },
  }
}

/**
 * Run `fn` inside a database transaction on whichever backend is configured.
 *
 * Returns the callback's value unchanged, and re-throws its error unchanged
 * after rolling back.
 */
export async function withTransaction<T>(
  fn: (tx: TransactionHandle) => Promise<T>,
  deps: TransactionDeps = resolveDeps(),
): Promise<T> {
  if (deps.isPostgres) {
    // node-postgres supports async callbacks natively; drizzle issues
    // BEGIN/COMMIT/ROLLBACK on one pinned client from the pool.
    return await deps.db.transaction(async (tx) => await fn(tx as unknown as TransactionHandle))
  }

  const sqlite = deps.sqlite
  if (!sqlite) {
    // No raw handle to drive BEGIN/COMMIT with. In production this cannot
    // happen (client.ts always opens one on the SQLite path), but a unit test
    // that mocks `db/client.js` with just `db` lands here. Run the callback
    // unwrapped rather than throwing: the mock has no real transaction
    // semantics to preserve, and failing would break suites that only care
    // about the statements their mock records.
    return await fn(deps.db)
  }

  // Already inside a transaction *opened by this async context*: join it. A
  // second BEGIN would throw, and the outermost frame already owns
  // commit/rollback.
  //
  // This check MUST stay ahead of the lock: `withKeyedLock` is a plain FIFO
  // promise chain with no owner tracking, so it is NOT re-entrant. A nested
  // `withTransaction` that queued behind the lock would wait on the outer call
  // that is itself waiting on the nested one — a guaranteed deadlock, which the
  // suite reproduces as four 20s timeouts if this branch is removed.
  //
  // It reads `depth`, an async-context-local counter, and NOT
  // `sqlite.inTransaction`. That distinction is the fix for the rollback bug
  // described on `runExclusive` below: `inTransaction` is a property of the
  // shared *connection*, so an unrelated caller arriving mid-transaction also
  // saw it set and silently joined a transaction it did not open.
  if (transactionDepth.getStore()) {
    return await fn(deps.db)
  }

  // A transaction is open on the connection but no `withTransaction` frame in
  // this async context owns it, so it was driven directly on the raw handle
  // (migrations and a few operator scripts do exactly that, always synchronously).
  // Issuing a second BEGIN would throw, and taking the lock would deadlock if
  // that owner is waiting on us, so join it — the raw owner keeps the boundary.
  //
  // This is NOT the path unrelated writes used to take: they go through
  // `runExclusive`, which waits for the transaction rather than joining it.
  if (sqlite.inTransaction) {
    return await fn(deps.db)
  }

  return await withKeyedLock(SQLITE_TRANSACTION_KEY, async () => {
    sqlite.exec('BEGIN')
    let result: T
    try {
      result = await transactionDepth.run(1, () => fn(deps.db))
    } catch (error) {
      // Guarded: a statement that itself aborted the transaction (e.g. a driver
      // -level rollback) leaves nothing to roll back, and a throwing ROLLBACK
      // here would mask the caller's original error.
      if (sqlite.inTransaction) sqlite.exec('ROLLBACK')
      throw error
    }
    sqlite.exec('COMMIT')
    return result
  })
}

/**
 * Run a single non-transactional SQLite write without landing inside someone
 * else's transaction.
 *
 * ## The bug this closes
 *
 * The atomicity argument at the top of this file claimed a callback could only
 * be interrupted by non-DB I/O, so banning `fetch`/`spawn`/timers inside a
 * callback was enough. That premise is false: **every** `await` yields the
 * event loop, `await db.insert(...)` included — drizzle's `QueryPromise`
 * resolves through the microtask queue even though better-sqlite3 executes the
 * statement synchronously. A callback awaiting nothing but its own queries
 * still hands control back to the loop between statements.
 *
 * On one shared connection that is a data-loss bug, not a scope caveat. An
 * unrelated request doing a plain `db.insert` during that window joins the open
 * transaction, and a later ROLLBACK erases a write whose own request already
 * returned success. `logAudit` writes exactly that way, so a dropped audit entry
 * breaches Iron Rule 5.
 *
 * Serialising on `SQLITE_TRANSACTION_KEY` — the same key `withTransaction` uses
 * — makes the write wait for any in-flight transaction to settle instead of
 * being swallowed by it.
 *
 * PostgreSQL needs none of this: each caller gets its own pooled client, so an
 * unrelated write is never inside another client's transaction. There the
 * callback runs directly.
 */
export async function runExclusive<T>(
  fn: () => Promise<T>,
  deps: TransactionDeps = resolveDeps(),
): Promise<T> {
  if (deps.isPostgres || !deps.sqlite) return await fn()
  // Already inside our own transaction: this write is meant to be part of it.
  if (transactionDepth.getStore()) return await fn()
  return await withKeyedLock(SQLITE_TRANSACTION_KEY, fn)
}
