import { describe, expect, it } from 'vitest'
import { isUniqueViolation } from '../db-errors.js'

/**
 * The "row already exists" signal differs entirely between backends: SQLite
 * raises `SQLITE_CONSTRAINT_PRIMARYKEY` / `SQLITE_CONSTRAINT_UNIQUE`, while
 * PostgreSQL raises SQLSTATE `23505` with an unrelated message. Code that
 * matched only the SQLite shape would stop treating a duplicate as benign and
 * start surfacing it as a 500.
 */
describe('isUniqueViolation', () => {
  it('recognises the SQLite primary-key violation', async () => {
    expect(isUniqueViolation({ code: 'SQLITE_CONSTRAINT_PRIMARYKEY' })).toBe(true)
  })

  it('recognises the SQLite unique-index violation', async () => {
    expect(isUniqueViolation({ code: 'SQLITE_CONSTRAINT_UNIQUE' })).toBe(true)
  })

  it('recognises the SQLite violation by message when no code is attached', async () => {
    // Wrapped/re-thrown errors sometimes lose the code but keep the text.
    expect(isUniqueViolation({ message: 'UNIQUE constraint failed: users.username' })).toBe(true)
  })

  it('recognises the PostgreSQL unique violation by SQLSTATE', async () => {
    expect(
      isUniqueViolation({
        code: '23505',
        message: 'duplicate key value violates unique constraint "agent_members_pkey"',
      }),
    ).toBe(true)
  })

  it('unwraps the DrizzleQueryError that hides the SQLSTATE on .cause', async () => {
    // Drizzle wraps every driver failure in a DrizzleQueryError whose own
    // `code` is undefined; the real 23505 sits on `.cause`. Matching only the
    // top level silently classified every PostgreSQL duplicate as an unknown
    // error — verified against a live server, not assumed.
    expect(
      isUniqueViolation({
        message: 'Failed query: insert into "users" ...',
        cause: { code: '23505', constraint: 'users_pkey' },
      }),
    ).toBe(true)
  })

  it('unwraps a nested cause chain without recursing forever on a cycle', async () => {
    const cyclic: { code?: string; cause?: unknown } = {}
    cyclic.cause = cyclic
    expect(isUniqueViolation(cyclic)).toBe(false)
  })

  it('does not treat an unrelated nested SQLSTATE as a duplicate', async () => {
    expect(isUniqueViolation({ cause: { code: '23503' } })).toBe(false)
  })

  it('does not treat an unrelated SQLite constraint as a duplicate', async () => {
    // A NOT NULL or FK violation is a real bug, not an idempotent re-insert.
    expect(isUniqueViolation({ code: 'SQLITE_CONSTRAINT_NOTNULL' })).toBe(false)
    expect(isUniqueViolation({ code: 'SQLITE_CONSTRAINT_FOREIGNKEY' })).toBe(false)
  })

  it('does not treat an unrelated PostgreSQL SQLSTATE as a duplicate', async () => {
    expect(isUniqueViolation({ code: '23503' })).toBe(false) // foreign_key_violation
    expect(isUniqueViolation({ code: '23502' })).toBe(false) // not_null_violation
  })

  it('returns false for non-error inputs', async () => {
    expect(isUniqueViolation(null)).toBe(false)
    expect(isUniqueViolation(undefined)).toBe(false)
    expect(isUniqueViolation('boom')).toBe(false)
    expect(isUniqueViolation({})).toBe(false)
  })
})
