import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
/**
 * Regression test for migration 0100 (OAuth access mode → email allowlist).
 *
 * Runs the **real** migration chain against a real SQLite file with `foreign_keys = ON`, the
 * way `db/client.ts` connects. Two bugs shipped in the first cut of this migration and both are
 * invisible to any test that only inspects the final schema:
 *
 *   1. drizzle's generated table rebuild (`DROP TABLE agents` + `RENAME`) runs inside the
 *      migrator's transaction, where `PRAGMA foreign_keys=OFF` is a no-op. On a database with
 *      real rows it either aborted the upgrade on a NO ACTION child (`runs.initiator_agent_id`)
 *      or — worse — reported success while CASCADE silently emptied `agent_members`,
 *      `evaluation_sets` and friends.
 *   2. `feishu_scope` was this column's DEFAULT since 0071, so translating every such row to
 *      `specified_users` marked the entire existing estate as deliberately restricted, not the
 *      subset that actually published the oauth channel.
 */
import Database from 'better-sqlite3'
import { drizzle } from 'drizzle-orm/better-sqlite3'
import { migrate } from 'drizzle-orm/better-sqlite3/migrator'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

const MIGRATIONS = existsSync('drizzle')
  ? 'drizzle'
  : existsSync('apps/api/drizzle')
    ? 'apps/api/drizzle'
    : (() => {
        throw new Error('drizzle folder not found')
      })()

let root: string
let sqlite: Database.Database

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'mig-0100-'))
  sqlite = new Database(join(root, 'test.db'))
  // Mirrors db/client.ts — the pragma that makes the generated rebuild destructive.
  sqlite.pragma('foreign_keys = ON')

  // Migrate to 0099 first, seed genuine pre-0100 rows, then apply 0100 for real. Asserting on
  // the migration's own SQL (rather than a copy of its CASE) is the point: a copy would keep
  // passing if the shipped file drifted.
  const journal = JSON.parse(readFileSync(join(MIGRATIONS, 'meta/_journal.json'), 'utf8'))
  const staged = join(root, 'migrations')
  mkdirSync(join(staged, 'meta'), { recursive: true })
  for (const f of readdirSync(MIGRATIONS)) {
    if (f.endsWith('.sql')) cpSync(join(MIGRATIONS, f), join(staged, f))
  }
  cpSync(join(MIGRATIONS, 'meta'), join(staged, 'meta'), { recursive: true })

  const upTo99 = {
    ...journal,
    entries: journal.entries.filter((e: { idx: number }) => e.idx < 100),
  }
  writeFileSync(join(staged, 'meta/_journal.json'), JSON.stringify(upTo99))
  migrate(drizzle(sqlite), { migrationsFolder: staged })

  const now = Date.now()
  const agent = (id: string, channels: string, mode?: string) =>
    sqlite
      .prepare(
        `INSERT INTO agents (id,name,skills,skill_group_ids,mcp_server_ids,kb_document_ids,publish_channels${
          mode ? ',oauth_access_mode' : ''
        },created_at,updated_at) VALUES (?,?,'[]','[]','[]','[]',?${mode ? ',?' : ''},?,?)`,
      )
      .run(...[id, id, channels, ...(mode ? [mode] : []), now, now])

  // Pre-0100 rows. `feishu_scope` is what 0071's column DEFAULT gave every Agent, so seed it
  // both ways: with and without the oauth channel actually published.
  agent('agt_scoped_oauth', '["api","oauth"]', 'feishu_scope')
  agent('agt_scoped_no_oauth', '["api"]', 'feishu_scope')
  agent('agt_open', '["api","oauth"]', 'all_idaas_users')
  agent('agt_listed', '["api","oauth"]', 'specified_users')
  sqlite
    .prepare('INSERT INTO users (id,username,role,created_at,updated_at) VALUES (?,?,?,?,?)')
    .run('usr_1', 'u', 'user', now, now)
  sqlite
    .prepare(
      'INSERT INTO agent_members (agent_id,user_id,role,created_at,updated_at) VALUES (?,?,?,?,?)',
    )
    .run('agt_open', 'usr_1', 'viewer', now, now)
  sqlite
    .prepare(
      'INSERT INTO runs (id,intent,status,initiator_agent_id,created_at,updated_at) VALUES (?,?,?,?,?,?)',
    )
    .run('run_1', 'i', 'completed', 'agt_open', now, now)

  // Now apply 0100 itself, over a database that has real data behind foreign keys.
  writeFileSync(join(staged, 'meta/_journal.json'), JSON.stringify(journal))
  migrate(drizzle(sqlite), { migrationsFolder: staged })
})

afterAll(() => {
  sqlite?.close()
  rmSync(root, { recursive: true, force: true })
})

describe('migration 0100', () => {
  it('adds the allowlist column, nullable and defaulting to NULL', () => {
    const col = sqlite
      .prepare('PRAGMA table_info(agents)')
      .all()
      .find((c) => (c as { name: string }).name === 'oauth_allowed_emails') as
      | { notnull: number; dflt_value: unknown }
      | undefined
    expect(col).toBeDefined()
    expect(col?.notnull).toBe(0)
    expect(col?.dflt_value).toBeNull()
    expect(
      sqlite.prepare("SELECT oauth_allowed_emails FROM agents WHERE id='agt_open'").get(),
    ).toEqual({ oauth_allowed_emails: null })
  })

  // The upgrade must not take child rows with it. Both of these were destroyed or blocked by
  // the generated table rebuild.
  it('leaves foreign-key children intact', () => {
    expect(sqlite.prepare('SELECT count(*) c FROM agent_members').get()).toEqual({ c: 1 })
    expect(sqlite.prepare('SELECT count(*) c FROM runs').get()).toEqual({ c: 1 })
  })

  it('leaves no foreign-key violations behind', () => {
    expect(sqlite.prepare('PRAGMA foreign_key_check').all()).toEqual([])
  })

  /**
   * The value translation, as performed by the shipped migration. `feishu_scope` only means
   * "deliberately restricted" for an Agent that actually publishes the oauth channel — it was
   * also the column DEFAULT, so treating every such row as restricted would strand the whole
   * existing estate on a deny-all list and make the new default unreachable.
   */
  it.each([
    // Restricted *and* actually serving OAuth → fail-closed.
    { id: 'agt_scoped_oauth', expected: 'specified_users' },
    // Never opted into the channel; the value was just the old default → new default.
    { id: 'agt_scoped_no_oauth', expected: 'all_idaas_users' },
    // Explicit choices are never rewritten.
    { id: 'agt_open', expected: 'all_idaas_users' },
    { id: 'agt_listed', expected: 'specified_users' },
  ])('translates $id to $expected', ({ id, expected }) => {
    const row = sqlite
      .prepare('SELECT oauth_access_mode m, oauth_allowed_emails a FROM agents WHERE id=?')
      .get(id) as { m: string; a: string | null }
    expect(row.m).toBe(expected)
    // Nothing can invent a roster, so every migrated Agent starts deny-all.
    expect(row.a).toBeNull()
  })

  it('leaves no row on the retired mode', () => {
    expect(
      sqlite.prepare("SELECT count(*) c FROM agents WHERE oauth_access_mode='feishu_scope'").get(),
    ).toEqual({ c: 0 })
  })
})
