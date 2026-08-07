import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * The PostgreSQL migration path.
 *
 * Everything the SQLite path does around `migrate()` — file-copy backup, WAL
 * checkpoint, `__drizzle_migrations` timestamp fixups, the skipped-migration
 * repair — is SQLite-specific machinery built for a single-file database with
 * ~97 migrations of accumulated history. On PostgreSQL each of those either
 * cannot work (there is no file to copy) or must not run (a fresh database
 * starts at migration 0, so there is no gap to repair). These tests pin that
 * they are skipped rather than attempted and silently swallowed.
 */
const callOrder: string[] = []

const pgMigrateMock = vi.fn(async () => {
  callOrder.push('pg-migrate')
})
vi.mock('drizzle-orm/node-postgres/migrator', () => ({
  migrate: (...args: unknown[]) => pgMigrateMock(...(args as [])),
}))

const sqliteMigrateMock = vi.fn(() => {
  callOrder.push('sqlite-migrate')
})
vi.mock('drizzle-orm/better-sqlite3/migrator', () => ({
  migrate: () => sqliteMigrateMock(),
}))

const backupMock = vi.fn(() => {
  callOrder.push('backup')
  return { skipped: false, target: '/tmp/backup.db' }
})
vi.mock('../db-backup.js', () => ({
  backupDatabaseBeforeMigrate: () => backupMock(),
}))

const repairMock = vi.fn(() => {
  callOrder.push('repair')
  return 0
})
vi.mock('../migration-gap-repair.js', () => ({
  repairSkippedMigrations: () => repairMock(),
}))

// The PostgreSQL client exposes no raw sqlite handle; touching it would throw.
vi.mock('../client.js', () => ({
  db: { __mockDb: true },
  sqliteDatabase: null,
  isPostgres: true,
  postgresPool: { __mockPool: true },
}))

vi.mock('../../lib/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}))

import { runMigrations } from '../migrate-runtime.js'

let tmp: string
let cwdBackup: string

beforeEach(() => {
  callOrder.length = 0
  pgMigrateMock.mockClear()
  sqliteMigrateMock.mockClear()
  backupMock.mockClear()
  repairMock.mockClear()

  tmp = mkdtempSync(path.join(os.tmpdir(), 'migrate-pg-'))
  // runMigrations resolves the folder relative to cwd.
  mkdirSync(path.join(tmp, 'drizzle-pg', 'meta'), { recursive: true })
  writeFileSync(
    path.join(tmp, 'drizzle-pg', 'meta', '_journal.json'),
    JSON.stringify({ entries: [{ tag: '0000_init', when: 1 }] }),
  )
  writeFileSync(path.join(tmp, 'drizzle-pg', '0000_init.sql'), 'CREATE TABLE x (id text);')
  cwdBackup = process.cwd()
  process.chdir(tmp)
})

afterEach(() => {
  process.chdir(cwdBackup)
  rmSync(tmp, { recursive: true, force: true })
})

describe('runMigrations on PostgreSQL', () => {
  it('runs the node-postgres migrator, not the better-sqlite3 one', async () => {
    await runMigrations()

    expect(pgMigrateMock).toHaveBeenCalledTimes(1)
    expect(sqliteMigrateMock).not.toHaveBeenCalled()
  })

  it('migrates from the postgres lineage, never the sqlite drizzle/ folder', async () => {
    // Replaying the ~97-migration SQLite history against PostgreSQL would fail
    // on the first dialect-specific statement.
    await runMigrations()

    const [, opts] = pgMigrateMock.mock.calls[0] as unknown as [
      unknown,
      { migrationsFolder: string },
    ]
    expect(opts.migrationsFolder).toContain('drizzle-pg')
    expect(path.basename(opts.migrationsFolder)).not.toBe('drizzle')
  })

  it('skips the file-copy backup, which has no meaning for a server database', async () => {
    await runMigrations()

    expect(backupMock).not.toHaveBeenCalled()
  })

  it('skips the skipped-migration repair, which is SQLite journal history', async () => {
    await runMigrations()

    expect(repairMock).not.toHaveBeenCalled()
  })

  it('awaits the migrator before returning', async () => {
    // The pg migrator is async; returning without awaiting would let the server
    // start serving requests against a half-migrated schema.
    let settled = false
    pgMigrateMock.mockImplementationOnce(
      () =>
        new Promise<void>((done) =>
          setTimeout(() => {
            settled = true
            done()
          }, 10),
        ),
    )

    await runMigrations()

    expect(settled).toBe(true)
  })
})
