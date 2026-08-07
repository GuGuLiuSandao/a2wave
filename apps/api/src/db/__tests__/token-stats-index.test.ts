import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import Database from 'better-sqlite3'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

type QueryPlanRow = { detail: string }

describe('token statistics indexes', () => {
  let sqlite: Database.Database

  beforeEach(() => {
    sqlite = new Database(':memory:')
    sqlite.exec(`
      CREATE TABLE runs (
        id TEXT PRIMARY KEY,
        user_id TEXT
      );
      CREATE INDEX runs_user_id_idx ON runs (user_id);
      CREATE TABLE run_steps (
        id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL,
        output TEXT,
        created_at INTEGER NOT NULL
      );
      CREATE INDEX run_steps_run_id_idx ON run_steps (run_id);
    `)

    const migrationPath = fileURLToPath(
      new URL('../../../drizzle/0087_solid_carmella_unuscione.sql', import.meta.url),
    )
    const migration = readFileSync(migrationPath, 'utf8').replaceAll('--> statement-breakpoint', '')
    sqlite.exec(migration)
  })

  afterEach(() => sqlite.close())

  it('uses created_at indexes for global and owner-filtered daily aggregates', async () => {
    const globalPlan = sqlite
      .prepare(
        `EXPLAIN QUERY PLAN
         SELECT SUM(json_extract(run_steps.output, '$.usage.inputTokens'))
         FROM run_steps
         INNER JOIN runs ON run_steps.run_id = runs.id
         WHERE run_steps.created_at >= ?`,
      )
      .all(0) as QueryPlanRow[]

    expect(globalPlan.some((row) => row.detail.includes('run_steps_created_at_idx'))).toBe(true)

    const ownerPlan = sqlite
      .prepare(
        `EXPLAIN QUERY PLAN
         SELECT SUM(json_extract(run_steps.output, '$.usage.inputTokens'))
         FROM run_steps
         INNER JOIN runs ON run_steps.run_id = runs.id
         WHERE runs.user_id = ? AND run_steps.created_at >= ?`,
      )
      .all('usr_1', 0) as QueryPlanRow[]

    expect(ownerPlan.some((row) => row.detail.includes('runs_user_id_idx'))).toBe(true)
    expect(ownerPlan.some((row) => row.detail.includes('run_steps_run_id_created_at_idx'))).toBe(
      true,
    )
  })
})
