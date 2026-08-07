import { describe, expect, it } from 'vitest'
import { transformSqliteSchemaToPg } from '../schema-transform.js'

/**
 * The PostgreSQL schema is *generated* from the SQLite one rather than
 * hand-maintained. A parallel hand-written file would silently drift on every
 * future column change — and a drifted schema is only discovered in production,
 * on the backend that has fewer eyes on it. These tests pin the translation
 * rules so the generator itself is the thing under review.
 */
describe('transformSqliteSchemaToPg', () => {
  it('rewrites the drizzle sqlite-core import to pg-core', async () => {
    const out = transformSqliteSchemaToPg(
      `import { index, integer, primaryKey, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core'`,
    )
    expect(out).toContain(`from 'drizzle-orm/pg-core'`)
    expect(out).not.toContain('sqlite-core')
  })

  it('renames sqliteTable to pgTable at both the import and the call sites', async () => {
    const out = transformSqliteSchemaToPg(
      `import { sqliteTable, text } from 'drizzle-orm/sqlite-core'\n` +
        `export const users = sqliteTable('users', { id: text('id').primaryKey() })`,
    )
    expect(out).toContain('pgTable')
    expect(out).not.toContain('sqliteTable')
  })

  it('maps a timestamp-mode integer to a timestamptz column', async () => {
    const out = transformSqliteSchemaToPg(`createdAt: integer('created_at', { mode: 'timestamp' })`)
    // mode: 'date' is load-bearing. drizzle's pg timestamp defaults to
    // mode:'string', which returns strings to the app (SQLite returned Date) and
    // — worse — serialises a bound Date as an epoch string, so PostgreSQL
    // rejects every timestamp comparison with "date/time field value out of
    // range".
    expect(out).toContain(`timestamp('created_at', { withTimezone: true, mode: 'date' })`)
  })

  it('maps timestamp_ms the same way — precision is a storage detail of sqlite', async () => {
    const out = transformSqliteSchemaToPg(
      `pinnedAt: integer('pinned_at', { mode: 'timestamp_ms' })`,
    )
    expect(out).toContain(`timestamp('pinned_at', { withTimezone: true, mode: 'date' })`)
  })

  it('maps a boolean-mode integer to a native boolean column', async () => {
    const out = transformSqliteSchemaToPg(`isActive: integer('is_active', { mode: 'boolean' })`)
    expect(out).toContain(`boolean('is_active')`)
    expect(out).not.toContain('mode:')
  })

  it('maps a json-mode text column to jsonb', async () => {
    const out = transformSqliteSchemaToPg(`details: text('details', { mode: 'json' })`)
    expect(out).toContain(`jsonb('details')`)
    expect(out).not.toContain('mode:')
  })

  it('leaves a small plain integer column as an integer', async () => {
    const out = transformSqliteSchemaToPg(`tokenVersion: integer('token_version')`)
    expect(out).toContain(`integer('token_version')`)
  })

  it.each([
    // Epoch milliseconds: ~1.79e12 today, far past PostgreSQL's 2147483647.
    ['created_at', `createdAt: integer('created_at').notNull()`],
    ['updated_at', `updatedAt: integer('updated_at').notNull()`],
    // A 2GB+ artifact or knowledge-base file overflows a 32-bit count of bytes.
    ['file_size', `fileSize: integer('file_size')`],
    ['size', `size: integer('size')`],
    // Cumulative token counters grow without bound over an agent's lifetime.
    ['input_tokens', `inputTokens: integer('input_tokens')`],
    ['cache_read_tokens', `cacheReadTokens: integer('cache_read_tokens')`],
    // A long-running step's duration in ms exceeds 32 bits after ~24.8 days.
    ['duration_ms', `durationMs: integer('duration_ms')`],
  ])('widens %s to bigint, since 32-bit integer would overflow', (name, source) => {
    // SQLite's INTEGER is 64-bit, so these never overflowed there. PostgreSQL's
    // `integer` caps at 2147483647 and rejects the write outright — found by
    // saving an A2A task, whose createdAt is Date.now().
    const out = transformSqliteSchemaToPg(source)
    expect(out).toContain(`bigint('${name}', { mode: 'number' })`)
    expect(out).not.toMatch(new RegExp(`\\binteger\\('${name}'`))
  })

  it('keeps plain-integer epoch columns numeric rather than promoting them to timestamps', async () => {
    // a2a_tasks stores created_at as a raw epoch integer, not a timestamp-mode
    // column, and the app reads it back as a number. Promoting it to timestamptz
    // would hand callers a Date instead. It still widens to bigint (see below),
    // since epoch milliseconds do not fit a 32-bit integer.
    const out = transformSqliteSchemaToPg(`createdAt: integer('created_at').notNull()`)
    expect(out).toContain('.notNull()')
    expect(out).not.toContain('timestamp(')
  })

  it('keeps text enum columns as text so the check-free sqlite behaviour is preserved', async () => {
    const out = transformSqliteSchemaToPg(`role: text('role', { enum: ['admin', 'user'] })`)
    expect(out).toContain(`text('role', { enum: ['admin', 'user'] })`)
  })

  it("rewrites a sql`'{}'` json default to a jsonb-typed empty object", async () => {
    const out = transformSqliteSchemaToPg(
      "onboarding: text('onboarding', { mode: 'json' })\n.default(sql`'{}'`)",
    )
    expect(out).toContain('.default({})')
    expect(out).not.toContain("sql`'{}'`")
  })

  it('adds the pg column builders it introduces to the import list', async () => {
    const out = transformSqliteSchemaToPg(
      `import { integer, sqliteTable, text } from 'drizzle-orm/sqlite-core'\n` +
        `export const t = sqliteTable('t', {\n` +
        `  a: integer('a', { mode: 'timestamp' }),\n` +
        `  b: integer('b', { mode: 'boolean' }),\n` +
        `  c: text('c', { mode: 'json' }),\n` +
        '})',
    )
    const importLine = out.split('\n').find((l) => l.startsWith('import')) ?? ''
    expect(importLine).toContain('timestamp')
    expect(importLine).toContain('boolean')
    expect(importLine).toContain('jsonb')
    expect(importLine).toContain('pgTable')
  })

  it('carries a banner marking the file as generated', async () => {
    const out = transformSqliteSchemaToPg(`import { text } from 'drizzle-orm/sqlite-core'`)
    expect(out).toMatch(/generated/i)
  })

  it('leaves SQLiteColumn type references pointing at the pg equivalent', async () => {
    const out = transformSqliteSchemaToPg(
      `import type { SQLiteColumn } from 'drizzle-orm/sqlite-core'`,
    )
    expect(out).toContain('PgColumn')
    expect(out).not.toContain('SQLiteColumn')
  })
})
