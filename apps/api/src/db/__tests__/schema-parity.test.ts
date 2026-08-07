import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { PG_SCHEMA_PATH, renderPgSchema } from '../schema-transform.js'
import * as pgSchema from '../schema.pg.js'
import * as sqliteSchema from '../schema.sqlite.js'

/**
 * The guard that makes generation trustworthy.
 *
 * Generating `schema.pg.ts` only prevents drift if the checked-in file is
 * actually regenerated. Without this test, a `schema.sqlite.ts` edit that forgets
 * `pnpm db:generate:pg` leaves a stale PostgreSQL schema that typechecks fine
 * and fails only at runtime, on the backend fewer developers run locally.
 */
describe('schema.pg.ts is in sync with schema.sqlite.ts', () => {
  it('matches a fresh generation from the current sqlite schema', async () => {
    const checkedIn = readFileSync(PG_SCHEMA_PATH, 'utf-8')
    expect(
      checkedIn,
      'schema.pg.ts is stale — run `pnpm db:generate:pg` after editing schema.sqlite.ts',
    ).toBe(renderPgSchema())
  })
})

/**
 * Exported-name parity is a separate question from textual parity: a table added
 * to schema.ts but dropped by a translation bug would still regenerate
 * byte-identically, so the textual test above cannot catch it.
 */
describe('both dialects export the same set of tables', () => {
  const tableNames = (mod: Record<string, unknown>) =>
    Object.keys(mod)
      .filter((k) => {
        const v = mod[k] as Record<symbol, unknown> | null
        return typeof v === 'object' && v !== null
      })
      .sort()

  it('exports identical top-level names', async () => {
    expect(tableNames(pgSchema)).toEqual(tableNames(sqliteSchema))
  })

  it('re-exports every table through the dispatcher', async () => {
    // schema.ts hand-lists each table, so a new table added to schema.sqlite.ts
    // regenerates into schema.pg.ts (keeping the two tests above green) while
    // silently never reaching consumers — they would import `undefined` and fail
    // at the first query. Nothing else checks this list.
    const dispatcher = await import('../schema.js')
    expect(tableNames(dispatcher)).toEqual(tableNames(sqliteSchema))
  })

  it('covers every table the application relies on', async () => {
    // A spot-check of the tables whose absence would be caught late and hurt:
    // auth, execution, and the permission model.
    for (const name of ['users', 'agents', 'runs', 'runSteps', 'agentMembers', 'settings']) {
      expect(pgSchema, `pg schema is missing ${name}`).toHaveProperty(name)
    }
  })
})
