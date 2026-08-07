import { readFileSync, readdirSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const MIGRATIONS_DIR = path.resolve(__dirname, '..', '..', '..', 'drizzle-pg')

function readMigrations(): Array<{ file: string; sql: string }> {
  return readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith('.sql'))
    .sort()
    .map((file) => ({ file, sql: readFileSync(path.join(MIGRATIONS_DIR, file), 'utf-8') }))
}

/**
 * The supported floor is **PostgreSQL 9.6**, which is old enough that several
 * now-idiomatic constructs are unavailable. drizzle-kit targets whatever the
 * installed version prefers, so a future schema change can silently emit DDL
 * that only runs on 10+/13+ — and the failure appears at an operator's upgrade,
 * not in review.
 *
 * The generated SQL was verified once by hand against a real postgres:9.6.24
 * container (25 tables, 67 indexes, all 3 partial unique indexes). These
 * assertions keep it that way.
 */
describe('generated PostgreSQL migrations stay compatible with 9.6', () => {
  const migrations = readMigrations()

  it('has at least one migration to check', async () => {
    expect(migrations.length).toBeGreaterThan(0)
  })

  it.each([
    // PG 10+: identity columns. 9.6 needs serial/bigserial.
    ['GENERATED ... AS IDENTITY', /GENERATED\s+(ALWAYS|BY\s+DEFAULT)\s+AS\s+IDENTITY/i],
    // PG 13+ as a builtin; on 9.6 it requires the pgcrypto extension.
    ['gen_random_uuid()', /gen_random_uuid\s*\(/i],
    // PG 15+: unique index null handling.
    ['NULLS NOT DISTINCT', /NULLS\s+NOT\s+DISTINCT/i],
    // PG 12+: generated stored columns.
    ['GENERATED ... STORED', /GENERATED\s+.*\s+STORED/i],
    // PG 11+ in CREATE PROCEDURE form.
    ['CREATE PROCEDURE', /CREATE\s+(OR\s+REPLACE\s+)?PROCEDURE/i],
    // PG 12+: SQL/JSON path operators.
    ['jsonb path operators', /@\?|@@|jsonb_path_/i],
  ])('does not use %s', (_label, pattern) => {
    for (const { file, sql } of migrations) {
      expect(sql, `${file} contains syntax unsupported on PostgreSQL 9.6`).not.toMatch(pattern)
    }
  })

  it('maps timestamps to timestamptz rather than a zone-naive timestamp', async () => {
    // A naive `timestamp` would reinterpret each stored instant against the
    // session TimeZone, silently shifting every value.
    for (const { file, sql } of migrations) {
      const naive = sql.match(/"\w+"\s+timestamp(?!\s+with time zone)/gi) ?? []
      expect(naive, `${file} declares zone-naive timestamp columns: ${naive.join(', ')}`).toEqual(
        [],
      )
    }
  })

  it('keeps the partial unique indexes that enforce run idempotency', async () => {
    const all = migrations.map((m) => m.sql).join('\n')
    for (const name of [
      'runs_idempotency_key_unique',
      'runs_oauth_active_session_unique',
      'runs_native_chat_event_unique',
    ]) {
      expect(all, `missing partial unique index ${name}`).toContain(name)
    }
  })
})
