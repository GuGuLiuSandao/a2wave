/**
 * Backend-neutral classification of database errors.
 *
 * The driver-specific shapes have no overlap: SQLite reports
 * `SQLITE_CONSTRAINT_*` codes, PostgreSQL reports five-character SQLSTATEs.
 * Matching only one of them means a duplicate insert stops being recognised as
 * benign on the other backend and surfaces as a 500 instead.
 */

/** SQLSTATE 23505 — unique_violation. */
const PG_UNIQUE_VIOLATION = '23505'

const SQLITE_UNIQUE_CODES = new Set([
  'SQLITE_CONSTRAINT_PRIMARYKEY',
  'SQLITE_CONSTRAINT_UNIQUE',
  // Older better-sqlite3 builds report the unspecialised code.
  'SQLITE_CONSTRAINT',
])

/**
 * True when the error means "a row with this key already exists".
 *
 * Deliberately narrow: a NOT NULL or foreign-key violation is a genuine bug, so
 * matching the whole `SQLITE_CONSTRAINT_*` / `23xxx` family would swallow real
 * failures as idempotent re-inserts.
 */
export function isUniqueViolation(err: unknown): boolean {
  // Walk the cause chain: drizzle wraps every driver failure in a
  // DrizzleQueryError whose own `code` is undefined, leaving the real SQLSTATE
  // on `.cause`. Checking only the top level classified every PostgreSQL
  // duplicate as an unknown error — which surfaced only when this was run
  // against a live server, never against the emitted SQL.
  const seen = new Set<unknown>()
  let current: unknown = err

  while (current && typeof current === 'object' && !seen.has(current)) {
    seen.add(current) // a self-referential cause must not loop forever
    const { code, message, cause } = current as {
      code?: unknown
      message?: unknown
      cause?: unknown
    }

    if (typeof code === 'string') {
      if (code === PG_UNIQUE_VIOLATION) return true
      if (SQLITE_UNIQUE_CODES.has(code)) return true
    }
    // Fallback for errors re-thrown without their code but with the text intact.
    if (typeof message === 'string' && /UNIQUE constraint failed/i.test(message)) return true

    current = cause
  }

  return false
}
