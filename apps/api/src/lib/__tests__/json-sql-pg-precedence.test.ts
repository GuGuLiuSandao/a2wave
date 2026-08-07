/**
 * PostgreSQL-branch operator-precedence regression for `jsonPathIsAbsent`.
 *
 * This lives in its own file because forcing the PostgreSQL branch means
 * mocking `db/client.js` to report `isPostgres: true`, and `vi.mock` is
 * file-scoped — the sibling `json-sql.test.ts` pins the SQLite behaviour
 * against a real in-memory database and must keep seeing the SQLite branch.
 *
 * Why a *composed* assertion rather than the helper alone: `jsonPathIsAbsent`
 * rendered in isolation looks correct either way, because the outer expression
 * has nothing to bind against. The bug only appears once drizzle's `and()`
 * wraps it — `and()` parenthesises the whole conjunction but not each operand,
 * and SQL binds AND tighter than OR. So an unparenthesised `A OR B` from the
 * helper degrades `and(eq(id, x), A OR B)` into `(id = x AND A) OR B`: the id
 * predicate disappears from the second disjunct, and the usage-recording
 * UPDATE in run-lifecycle.ts rewrites *every* run_steps row lacking a `usage`
 * key instead of the one it claimed. Silent cross-row corruption, so this is
 * asserted on the rendered SQL rather than left to an integration test.
 */
import { and, eq } from 'drizzle-orm'
import { PgDialect } from 'drizzle-orm/pg-core'
import { sqliteTable, text } from 'drizzle-orm/sqlite-core'
import { describe, expect, it, vi } from 'vitest'

// Force the PostgreSQL branch: isPostgresRuntime() reads `isPostgres` off the
// db/client.js module namespace (see db/dialect-runtime.ts).
vi.mock('../../db/client.js', () => ({ isPostgres: true }))

import { jsonPathIsAbsent } from '../json-sql.js'

// Mirrors the shape of run_steps that the real call site uses: an id to filter
// on, plus the JSON output column holding the usage record.
const runStepsLike = sqliteTable('run_steps', {
  id: text('id').primaryKey(),
  output: text('output', { mode: 'json' }).$type<Record<string, unknown>>(),
})

const dialect = new PgDialect()

/** Render a drizzle fragment to the SQL text PostgreSQL would actually receive. */
function renderPg(fragment: Parameters<PgDialect['sqlToQuery']>[0]): string {
  return dialect.sqlToQuery(fragment).sql
}

describe('jsonPathIsAbsent on PostgreSQL', () => {
  it('emits a self-contained, fully parenthesised disjunction', () => {
    const rendered = renderPg(jsonPathIsAbsent(runStepsLike.output, ['usage']))

    // The whole OR must sit inside one paren pair, so the fragment is safe to
    // drop into any surrounding boolean expression.
    expect(rendered).toBe('(("run_steps"."output") IS NULL OR NOT (("run_steps"."output") ? $1))')
  })

  it('keeps the sibling predicate binding to BOTH sides when composed with and()', () => {
    const where = and(
      eq(runStepsLike.id, 'rst_target'),
      jsonPathIsAbsent(runStepsLike.output, ['usage']),
    )
    // `and()` returns SQL | undefined; an undefined here would mean the helper
    // produced nothing, which is itself a failure.
    expect(where).toBeDefined()
    const rendered = renderPg(where as NonNullable<typeof where>)

    // The OR must be wrapped, otherwise `id = $1 AND ... OR NOT ...` parses as
    // `(id = $1 AND ...) OR NOT ...` and the UPDATE escapes its target row.
    expect(rendered).toBe(
      '("run_steps"."id" = $1 and (("run_steps"."output") IS NULL OR NOT (("run_steps"."output") ? $2)))',
    )

    // Structural restatement of the same requirement, independent of the exact
    // rendering above: the text between `and ` and the final `)` must itself be
    // a balanced, parenthesis-delimited unit.
    const conjunctionBody = rendered.slice(rendered.indexOf(' and ') + ' and '.length, -1)
    expect(conjunctionBody.startsWith('(')).toBe(true)
    expect(conjunctionBody.endsWith(')')).toBe(true)
    expect(isBalancedGroup(conjunctionBody)).toBe(true)
  })

  it('parenthesises a nested path the same way', () => {
    const where = and(
      eq(runStepsLike.id, 'rst_target'),
      jsonPathIsAbsent(runStepsLike.output, ['usage', 'inputTokens']),
    )
    expect(where).toBeDefined()
    const rendered = renderPg(where as NonNullable<typeof where>)

    const conjunctionBody = rendered.slice(rendered.indexOf(' and ') + ' and '.length, -1)
    expect(isBalancedGroup(conjunctionBody)).toBe(true)
    expect(conjunctionBody).toContain(' OR ')
  })
})

/**
 * True when the leading `(` closes only at the very last character — i.e. the
 * string is one parenthesised group rather than two siblings joined by an
 * operator. `(a OR b)` passes; `(a) IS NULL OR NOT (b)` does not.
 */
function isBalancedGroup(text: string): boolean {
  if (!text.startsWith('(')) return false
  let depth = 0
  for (let i = 0; i < text.length; i++) {
    if (text[i] === '(') depth++
    else if (text[i] === ')') {
      depth--
      if (depth === 0) return i === text.length - 1
    }
  }
  return false
}
