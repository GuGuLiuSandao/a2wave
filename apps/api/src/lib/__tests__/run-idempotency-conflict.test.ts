import { describe, expect, it, vi } from 'vitest'

vi.mock('../../db/client.js', () => ({ db: {} }))
vi.mock('../../db/schema.js', () => ({ runs: {} }))

import { isRunIdempotencyConflict } from '../run-idempotency.js'

/**
 * This predicate decides whether a duplicate request is answered with the
 * original run (correct) or a 500 (wrong). Both backends raise a unique
 * violation on `runs_idempotency_key_unique`, but they word it differently, and
 * drizzle wraps the PostgreSQL one so the index name is not on the top-level
 * message at all — only on `.cause`.
 */
describe('isRunIdempotencyConflict', () => {
  it('matches the SQLite conflict, which names the index', async () => {
    expect(
      isRunIdempotencyConflict(
        new Error('UNIQUE constraint failed: index runs_idempotency_key_unique'),
      ),
    ).toBe(true)
  })

  it('matches the SQLite conflict phrased as a column list', async () => {
    expect(
      isRunIdempotencyConflict(
        new Error(
          'UNIQUE constraint failed: runs.initiator_agent_id, runs.trigger_source, runs.trigger_session_id',
        ),
      ),
    ).toBe(true)
  })

  it('matches the PostgreSQL conflict wrapped in a DrizzleQueryError', async () => {
    // The real shape: drizzle's message is "Failed query: insert into ...", and
    // the constraint name lives on the driver error underneath. Matching only
    // the top level would turn every duplicate A2A/gateway call into a 500.
    expect(
      isRunIdempotencyConflict(
        Object.assign(new Error('Failed query: insert into "runs" ...'), {
          cause: {
            code: '23505',
            constraint: 'runs_idempotency_key_unique',
            message: 'duplicate key value violates unique constraint "runs_idempotency_key_unique"',
          },
        }),
      ),
    ).toBe(true)
  })

  it('does not match a unique violation on a different constraint', async () => {
    // A duplicate username is a real error; answering it with someone's run
    // would be far worse than a 500.
    expect(
      isRunIdempotencyConflict(
        Object.assign(new Error('Failed query: insert into "users" ...'), {
          cause: {
            code: '23505',
            constraint: 'users_username_unique',
            message: 'duplicate key value violates unique constraint "users_username_unique"',
          },
        }),
      ),
    ).toBe(false)
  })

  it('does not match an unrelated failure', async () => {
    expect(isRunIdempotencyConflict(new Error('connection terminated'))).toBe(false)
    expect(isRunIdempotencyConflict(null)).toBe(false)
    expect(isRunIdempotencyConflict(undefined)).toBe(false)
  })
})
