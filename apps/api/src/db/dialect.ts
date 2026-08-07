/**
 * Which database backend `DATABASE_URL` points at.
 *
 * SQLite stays the default so a fresh `pnpm run dev` / single-container deploy
 * still boots with zero external dependencies (Iron Rule 7). PostgreSQL is opted
 * into purely by handing DATABASE_URL a connection string — there is no separate
 * "driver" env var to keep in sync, which is the mistake that makes a dual-backend
 * setup drift (a URL saying one thing and a flag saying another).
 *
 * Minimum supported server is **PostgreSQL 9.6**, so nothing here (or in the pg
 * schema/migrations) may rely on 10+ syntax such as `GENERATED AS IDENTITY`.
 */
export type DbDialect = 'sqlite' | 'postgres'

/**
 * Matches only a real URL scheme, anchored at the start.
 *
 * Deliberately not a substring test: `./data/postgres-backup.db` is a SQLite
 * file whose *name* contains "postgres", and treating it as a connection string
 * would send the process at a nonexistent server instead of opening the file.
 */
const POSTGRES_SCHEME = /^postgres(ql)?:\/\//i

/** True when the connection string addresses a PostgreSQL server. */
export function isPostgresUrl(databaseUrl: string): boolean {
  return POSTGRES_SCHEME.test(databaseUrl.trim())
}

/**
 * Pick the dialect for a connection string.
 *
 * An unset or empty value resolves to SQLite rather than throwing: env.ts already
 * defaults DATABASE_URL to `./data/a2wave.db`, and callers that read
 * `process.env` directly (the migration CLI, the backup helper) must agree with
 * that default instead of failing on a missing var.
 */
export function resolveDialect(databaseUrl: string | undefined): DbDialect {
  if (!databaseUrl) return 'sqlite'
  return isPostgresUrl(databaseUrl) ? 'postgres' : 'sqlite'
}
