import { existsSync, mkdirSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import BetterSqlite3 from 'better-sqlite3'
import { drizzle } from 'drizzle-orm/better-sqlite3'
import { drizzle as drizzlePg } from 'drizzle-orm/node-postgres'
import pg from 'pg'
import { env } from '../env.js'
import { resolveDialect } from './dialect.js'
import * as pgSchema from './schema.pg.js'
import * as schema from './schema.sqlite.js'
import { describeDbStartupError } from './startup-errors.js'

/** Instance type for better-sqlite3; explicit alias so DTS emit (tsup) does not hit TS4023. */
export type SqliteDatabase = InstanceType<typeof BetterSqlite3>

/**
 * Which backend this process is talking to; derived once from DATABASE_URL.
 *
 * ⚠️ PostgreSQL is EXPERIMENTAL — SQLite is the supported default. The
 * PostgreSQL path passes the full test suite and an end-to-end smoke test, but
 * has no production soak time, and there is no SQLite -> PostgreSQL data
 * migration path. See docs/agent/postgresql.md.
 */
export const dialect = resolveDialect(env.DATABASE_URL)
export const isPostgres = dialect === 'postgres'

function openDatabase(): SqliteDatabase {
  const dbPath = resolve(env.DATABASE_URL)
  try {
    // Ensure data directory exists
    const dbDir = dirname(dbPath)
    if (!existsSync(dbDir)) {
      mkdirSync(dbDir, { recursive: true })
    }

    const instance = new BetterSqlite3(dbPath)
    // Enable WAL mode for better concurrent read performance
    instance.pragma('journal_mode = WAL')
    instance.pragma('foreign_keys = ON')
    // Retry on write lock contention instead of immediately throwing SQLITE_BUSY
    instance.pragma('busy_timeout = 5000')
    return instance
  } catch (err) {
    // These failures happen at import time; without translation they surface
    // as a raw stack buried in an ESM import chain.
    const friendly = describeDbStartupError(err, dbPath)
    if (friendly) {
      console.error(`✗ Failed to open the database: ${friendly}`)
      process.exit(1)
    }
    throw err
  }
}

/**
 * node-postgres returns `int8` (OID 20), `numeric` (1700) and the aggregate
 * types built on them as **strings** by default — the driver refuses to risk
 * precision, since both can exceed IEEE-754. SQLite hands back JS numbers, so
 * without this every dual-backend numeric silently changes type on PostgreSQL:
 *
 *   - `EXTRACT(EPOCH FROM ts)` is `numeric` on PG 14+, so the time-series bucket
 *     key came back as `"1783401600"` while `bucketSequence()` looks it up with a
 *     number — every lookup missed and the whole chart rendered as zeros.
 *   - `SUM(inputTokens)` and the `SUM((… ->> 'x')::numeric)` token aggregates
 *     became strings, so the frontend's `input + output` concatenated instead of
 *     adding.
 *
 * Both are declared `sql<number>` in our queries, so TypeScript actively
 * *believed* the wrong thing here. Parsing at the driver fixes every site at
 * once, including ones not yet written.
 *
 * Precision: a2wave's int8 columns are token counts and epoch millis, both far
 * under 2^53. `Number` is therefore lossless in practice — but a value beyond
 * that would corrupt silently, so the guard below keeps the string instead.
 */
function registerPostgresTypeParsers(): void {
  const asNumber = (value: string): number | string => {
    const n = Number(value)
    // Round-trip check: if the value cannot survive as a double, hand back the
    // original string rather than a silently wrong number.
    return Number.isSafeInteger(n) || String(n) === value ? n : value
  }
  // 20 = int8/bigint, 1700 = numeric. 1114/1184 (timestamps) are deliberately
  // left alone — drizzle's own mappers own those.
  pg.types.setTypeParser(20, asNumber)
  pg.types.setTypeParser(1700, asNumber)
}

/**
 * Build the PostgreSQL pool.
 *
 * Constructing a `Pool` performs **no I/O** — connections are opened lazily on
 * first query. That matters because `db` below is consumed at module scope by
 * dozens of files, so this path has to stay synchronous exactly like the SQLite
 * one; an eager connect would force every importer to become async.
 *
 * The consequence worth knowing: a bad DATABASE_URL is *not* caught here. It
 * surfaces on the first query instead, which is why `pool.on('error')` is wired
 * to translate it rather than let a raw driver stack escape.
 */
function openPostgresPool(): pg.Pool {
  registerPostgresTypeParsers()
  const pool = new pg.Pool({
    connectionString: env.DATABASE_URL,
    // Bounded so a2wave cannot exhaust a shared server's max_connections on its
    // own. Overridable for deployments that tuned the server side.
    max: env.DATABASE_POOL_MAX,
  })

  // An idle client erroring (server restart, network drop, admin terminate)
  // emits on the pool. Without a listener Node treats it as an unhandled 'error'
  // event and crashes the process — a database blip must not take down the API.
  pool.on('error', (err) => {
    const friendly = describeDbStartupError(err, env.DATABASE_URL)
    console.error(`✗ PostgreSQL connection error: ${friendly ?? err.message}`)
  })

  return pool
}

const sqlite = isPostgres ? null : openDatabase()
const pool = isPostgres ? openPostgresPool() : null

// Printed at import time, before anything else can scroll past: choosing this
// backend is a deliberate opt-in and the operator should see the caveat on every
// boot, not only if they happen to read the docs. console rather than the logger
// because this module is imported long before logging is configured.
if (isPostgres) {
  console.warn(
    '⚠ PostgreSQL support is EXPERIMENTAL and not yet recommended for production. ' +
      'SQLite remains the supported default. There is no SQLite → PostgreSQL data ' +
      'migration path. See docs/agent/postgresql.md.',
  )
}

/**
 * The Drizzle handle every consumer imports.
 *
 * Typed as the SQLite database so the ~76 existing call sites keep compiling
 * while the codebase is converted to the dialect-neutral async API. The runtime
 * object is the PostgreSQL one when DATABASE_URL says so.
 */
export const db = (pool
  ? drizzlePg(pool, { schema: pgSchema })
  : drizzle(sqlite as SqliteDatabase, { schema })) as unknown as ReturnType<
  typeof drizzle<typeof schema>
>
export type Database = typeof db

/**
 * Raw better-sqlite3 handle (e.g. PRAGMA / idempotent patches after Drizzle migrate).
 *
 * Null under PostgreSQL. The SQLite-only maintenance paths that use it
 * (file backup, journal repair, timestamp fixups) are gated on `isPostgres`
 * rather than handed a stub, so a mistaken call fails loudly instead of
 * silently no-oping against the wrong backend.
 */
export const sqliteDatabase: SqliteDatabase = sqlite as SqliteDatabase

/** The pg pool, or null on SQLite. Used by migrations and the health check. */
export const postgresPool: pg.Pool | null = pool

export async function closeDatabaseConnection() {
  if (pool) {
    await pool.end()
    return
  }
  sqlite?.close()
}
