import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import Database from 'better-sqlite3'
import { drizzle } from 'drizzle-orm/better-sqlite3'
import { migrate } from 'drizzle-orm/better-sqlite3/migrator'
import { afterEach, describe, expect, it } from 'vitest'
import { repairSkippedMigrations } from '../migration-gap-repair.js'

interface JournalEntry {
  idx: number
  version: string
  when: number
  tag: string
  breakpoints: boolean
}

function writeJournal(folder: string, entries: JournalEntry[]): void {
  writeFileSync(join(folder, 'meta', '_journal.json'), JSON.stringify({ version: '7', entries }))
}

describe('repairSkippedMigrations', () => {
  const databases: Database.Database[] = []
  const tempDirectories: string[] = []

  afterEach(() => {
    for (const database of databases) database.close()
    for (const directory of tempDirectories) rmSync(directory, { recursive: true, force: true })
    databases.length = 0
    tempDirectories.length = 0
  })

  it('applies an allowlisted migration inserted before an already-applied newer migration', async () => {
    const folder = mkdtempSync(join(tmpdir(), 'migration-gap-repair-'))
    tempDirectories.push(folder)
    mkdirSync(join(folder, 'meta'))

    const initialMigration: JournalEntry = {
      idx: 0,
      version: '6',
      when: 1000,
      tag: '0000_create_items',
      breakpoints: true,
    }
    const skippedMigration: JournalEntry = {
      idx: 1,
      version: '6',
      when: 2000,
      tag: '0078_magenta_rhodey',
      breakpoints: true,
    }
    const newerMigration: JournalEntry = {
      idx: 2,
      version: '6',
      when: 3000,
      tag: '0002_create_events',
      breakpoints: true,
    }

    writeFileSync(join(folder, `${initialMigration.tag}.sql`), 'CREATE TABLE items (id TEXT);')
    writeFileSync(join(folder, `${skippedMigration.tag}.sql`), 'ALTER TABLE items ADD label TEXT;')
    writeFileSync(join(folder, `${newerMigration.tag}.sql`), 'CREATE TABLE events (id TEXT);')

    writeJournal(folder, [initialMigration, newerMigration])

    const sqlite = new Database(':memory:')
    databases.push(sqlite)
    migrate(drizzle(sqlite), { migrationsFolder: folder })

    writeJournal(folder, [initialMigration, skippedMigration, newerMigration])
    expect(sqlite.prepare("SELECT name FROM pragma_table_info('items')").all()).toEqual([
      { name: 'id' },
    ])

    repairSkippedMigrations(sqlite, folder)

    expect(sqlite.prepare("SELECT name FROM pragma_table_info('items')").all()).toEqual([
      { name: 'id' },
      { name: 'label' },
    ])
    expect(sqlite.prepare('SELECT COUNT(*) AS count FROM __drizzle_migrations').get()).toEqual({
      count: 3,
    })
  })

  it('repairs the skipped usage-scope migration after native-chat migration 0089', async () => {
    const folder = mkdtempSync(join(tmpdir(), 'migration-gap-repair-'))
    tempDirectories.push(folder)
    mkdirSync(join(folder, 'meta'))

    const initialMigration: JournalEntry = {
      idx: 0,
      version: '6',
      when: 1000,
      tag: '0000_create_mcp_servers',
      breakpoints: true,
    }
    const skippedUsageScopeMigration: JournalEntry = {
      idx: 1,
      version: '6',
      when: 2000,
      tag: '0088_aberrant_invaders',
      breakpoints: true,
    }
    const appliedNativeChatMigration: JournalEntry = {
      idx: 2,
      version: '6',
      when: 3000,
      tag: '0089_certain_vivisector',
      breakpoints: true,
    }

    writeFileSync(
      join(folder, `${initialMigration.tag}.sql`),
      [
        'CREATE TABLE mcp_servers (id TEXT PRIMARY KEY, admin_only INTEGER NOT NULL DEFAULT 0);',
        '--> statement-breakpoint',
        "INSERT INTO mcp_servers (id, admin_only) VALUES ('mcp_admin', 1);",
      ].join('\n'),
    )
    writeFileSync(
      join(folder, `${skippedUsageScopeMigration.tag}.sql`),
      [
        "ALTER TABLE mcp_servers ADD usage_scope TEXT NOT NULL DEFAULT 'private';",
        '--> statement-breakpoint',
        "UPDATE mcp_servers SET usage_scope = 'admin-only' WHERE admin_only = 1;",
        '--> statement-breakpoint',
        'ALTER TABLE mcp_servers DROP COLUMN admin_only;',
      ].join('\n'),
    )
    writeFileSync(
      join(folder, `${appliedNativeChatMigration.tag}.sql`),
      'CREATE TABLE native_chat_events (id TEXT PRIMARY KEY);',
    )

    writeJournal(folder, [initialMigration, appliedNativeChatMigration])

    const sqlite = new Database(':memory:')
    databases.push(sqlite)
    migrate(drizzle(sqlite), { migrationsFolder: folder })

    writeJournal(folder, [initialMigration, skippedUsageScopeMigration, appliedNativeChatMigration])

    expect(sqlite.prepare("SELECT name FROM pragma_table_info('mcp_servers')").all()).toEqual([
      { name: 'id' },
      { name: 'admin_only' },
    ])

    expect(repairSkippedMigrations(sqlite, folder)).toBe(1)
    expect(sqlite.prepare("SELECT name FROM pragma_table_info('mcp_servers')").all()).toEqual([
      { name: 'id' },
      { name: 'usage_scope' },
    ])
    expect(sqlite.prepare('SELECT usage_scope FROM mcp_servers').get()).toEqual({
      usage_scope: 'admin-only',
    })
  })

  it('does not apply an unlisted historical migration gap', async () => {
    const folder = mkdtempSync(join(tmpdir(), 'migration-gap-repair-'))
    tempDirectories.push(folder)
    mkdirSync(join(folder, 'meta'))

    const initialMigration: JournalEntry = {
      idx: 0,
      version: '6',
      when: 1000,
      tag: '0000_create_items',
      breakpoints: true,
    }
    const unsafeGap: JournalEntry = {
      idx: 1,
      version: '6',
      when: 2000,
      tag: '0001_unreviewed_historical_gap',
      breakpoints: true,
    }
    const newerMigration: JournalEntry = {
      idx: 2,
      version: '6',
      when: 3000,
      tag: '0002_create_events',
      breakpoints: true,
    }

    writeFileSync(join(folder, `${initialMigration.tag}.sql`), 'CREATE TABLE items (id TEXT);')
    writeFileSync(join(folder, `${unsafeGap.tag}.sql`), 'ALTER TABLE items ADD unsafe TEXT;')
    writeFileSync(join(folder, `${newerMigration.tag}.sql`), 'CREATE TABLE events (id TEXT);')

    writeJournal(folder, [initialMigration, newerMigration])
    const sqlite = new Database(':memory:')
    databases.push(sqlite)
    migrate(drizzle(sqlite), { migrationsFolder: folder })

    writeJournal(folder, [initialMigration, unsafeGap, newerMigration])

    expect(repairSkippedMigrations(sqlite, folder)).toBe(0)
    expect(sqlite.prepare("SELECT name FROM pragma_table_info('items')").all()).toEqual([
      { name: 'id' },
    ])
    expect(sqlite.prepare('SELECT COUNT(*) AS count FROM __drizzle_migrations').get()).toEqual({
      count: 2,
    })
  })
})
