import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const here = path.dirname(fileURLToPath(import.meta.url))
const migrateSource = readFileSync(path.resolve(here, '../migrate.ts'), 'utf8')

/**
 * `pnpm db:migrate` resolves the dialect from `process.env.DATABASE_URL`, but
 * nothing on the path from migrate.ts -> dialect.ts loads the monorepo `.env`:
 * that side effect lives in env.ts, which is only pulled in later by client.ts.
 *
 * The result was silent and destructive-looking: with `DATABASE_URL=postgres://...`
 * only in `.env`, the CLI read `undefined`, took the SQLite branch, resolved the
 * connection string as a relative *file path*, and then crashed inside
 * repairSkippedMigrations with "Cannot read properties of null (reading 'prepare')"
 * — because client.ts (which by then *had* loaded .env) exports a null
 * `sqliteDatabase` under PostgreSQL.
 */
describe('db:migrate CLI dialect resolution', () => {
  it('loads .env before resolving the dialect', () => {
    const loadIndex = migrateSource.indexOf('loadDotenvFiles(')
    const resolveIndex = migrateSource.indexOf('resolveDialect(process.env.DATABASE_URL)')

    expect(loadIndex, 'migrate.ts must load .env in the CLI block').toBeGreaterThan(-1)
    expect(resolveIndex, 'migrate.ts must resolve the dialect from DATABASE_URL').toBeGreaterThan(
      -1,
    )
    expect(
      loadIndex,
      '.env must be loaded before the dialect check, or a postgres:// URL in .env is read as undefined and the CLI takes the SQLite branch',
    ).toBeLessThan(resolveIndex)
  })
})
