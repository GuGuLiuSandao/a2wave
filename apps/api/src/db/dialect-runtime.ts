import * as client from './client.js'

/**
 * Is this process talking to PostgreSQL?
 *
 * Reads the flag through the module namespace inside a try/catch rather than
 * importing `isPostgres` directly. Dozens of route and lib tests mock
 * `db/client.js` with only the two or three exports they exercise, and vitest
 * *throws* when an undeclared export is read — so a plain named import would
 * break every one of those suites on load, and even optional chaining is not
 * enough.
 *
 * Falling back to `false` is the right default twice over: SQLite is the product
 * default, and a mocked client in a test is always standing in for the SQLite
 * behaviour those tests were written against.
 */
export function isPostgresRuntime(): boolean {
  try {
    return (client as { isPostgres?: boolean }).isPostgres === true
  } catch {
    return false
  }
}
