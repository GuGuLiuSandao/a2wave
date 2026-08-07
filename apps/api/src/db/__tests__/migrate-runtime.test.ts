import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// Order tracker so tests can assert backup happens BEFORE migrate.
const callOrder: string[] = []

const migrateMock = vi.fn((_db: unknown, _opts: { migrationsFolder: string }) => {
  callOrder.push('migrate')
})
vi.mock('drizzle-orm/better-sqlite3/migrator', () => ({
  migrate: (db: unknown, opts: { migrationsFolder: string }) => migrateMock(db, opts),
}))

const backupMock = vi.fn(() => {
  callOrder.push('backup')
  return { skipped: false, target: '/tmp/backup.db' }
})
// Runtime imports the backup helper from the side-effect-free db-backup.ts (NOT
// migrate.ts, whose top-level chdir/CLI block must never load in the server).
vi.mock('../db-backup.js', () => ({
  backupDatabaseBeforeMigrate: () => backupMock(),
}))

// repairSkippedMigrations applies missing migrations + writes journal rows, so the
// backup must precede it (P6). Track its order too.
const repairMock = vi.fn((_db: unknown, _folder: string) => {
  callOrder.push('repair')
  return 0
})
vi.mock('../migration-gap-repair.js', () => ({
  repairSkippedMigrations: (db: unknown, folder: string) => repairMock(db, folder),
}))

// In-memory mock of better-sqlite3 prepared statements used by fixupTimestamps.
type Row = { hash: string; created_at: number }
const allRows: Row[] = []
const updateCalls: Array<{ when: number; hash: string }> = []

let throwOnAll = false
// Number of applied migrations reported by the SELECT count(*) query that
// hasPendingMigrations runs. Controls whether the pre-migration backup fires.
let appliedCount = 0
const prepareMock = vi.fn().mockImplementation((sql: string) => {
  if (sql.includes('count(*)')) {
    return {
      get: () => {
        if (throwOnAll) throw new Error('no such table: __drizzle_migrations')
        return { n: appliedCount }
      },
    }
  }
  if (sql.startsWith('SELECT')) {
    return {
      all: () => {
        if (throwOnAll) throw new Error('no such table: __drizzle_migrations')
        return [...allRows]
      },
    }
  }
  if (sql.startsWith('UPDATE')) {
    return {
      run: (when: number, hash: string) => {
        updateCalls.push({ when, hash })
      },
    }
  }
  return {}
})

// vitest 4 的 vi.mock 不再接受 `{ virtual: true }` 第三参；
// 单 factory 形式即可声明虚拟模块。
vi.mock('./client.js', () => ({}))

vi.mock('../client.js', () => ({
  db: { __mockDb: true },
  sqliteDatabase: { prepare: (sql: string) => prepareMock(sql) },
  // This file covers the SQLite path; the PostgreSQL one has its own suite.
  isPostgres: false,
}))

vi.mock('../../lib/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}))

import { runMigrations } from '../migrate-runtime.js'

let tmp: string
let cwdBackup: string

beforeEach(() => {
  migrateMock.mockClear()
  backupMock.mockClear()
  repairMock.mockClear()
  prepareMock.mockClear()
  allRows.length = 0
  updateCalls.length = 0
  callOrder.length = 0
  throwOnAll = false
  appliedCount = 0
  tmp = mkdtempSync(path.join(os.tmpdir(), 'migrate-runtime-'))
  cwdBackup = process.cwd()
})

afterEach(() => {
  process.chdir(cwdBackup)
  rmSync(tmp, { recursive: true, force: true })
})

function setupMigrationsFolder() {
  // Match the local candidate: `drizzle` under cwd
  process.chdir(tmp)
  const folder = path.join(tmp, 'drizzle')
  mkdirSync(path.join(folder, 'meta'), { recursive: true })
  return folder
}

function writeJournal(folder: string, entries: Array<{ tag: string; when: number }>) {
  writeFileSync(path.join(folder, 'meta', '_journal.json'), JSON.stringify({ entries }))
  for (const entry of entries) {
    writeFileSync(path.join(folder, `${entry.tag}.sql`), `CREATE TABLE ${entry.tag} (x INT);`)
  }
}

describe('runMigrations', () => {
  it('logs a warning and returns early when no migrations folder is found', async () => {
    process.chdir(tmp) // no `drizzle` subdir → both candidates miss
    await runMigrations()
    expect(migrateMock).not.toHaveBeenCalled()
  })

  it('runs drizzle migrate when the local folder exists, even without _journal.json', async () => {
    setupMigrationsFolder()
    await runMigrations()
    expect(migrateMock).toHaveBeenCalledTimes(1)
    expect(migrateMock).toHaveBeenCalledWith(
      { __mockDb: true },
      { migrationsFolder: expect.stringContaining(`${path.sep}drizzle`) },
    )
  })

  it('patches stale timestamps when DB row differs from journal entry', async () => {
    const folder = setupMigrationsFolder()
    writeJournal(folder, [{ tag: '0001_init', when: 2000 }])

    // Pre-compute the expected sha256 of the SQL file we just wrote
    const sql = 'CREATE TABLE 0001_init (x INT);'
    const crypto = require('node:crypto') as typeof import('node:crypto')
    const hash = crypto.createHash('sha256').update(sql).digest('hex')

    allRows.push({ hash, created_at: 1000 })

    await runMigrations()
    expect(updateCalls).toEqual([{ when: 2000, hash }])
    expect(migrateMock).toHaveBeenCalled()
  })

  it('leaves DB rows alone when timestamps already match', async () => {
    const folder = setupMigrationsFolder()
    writeJournal(folder, [{ tag: '0001_init', when: 2000 }])
    const sql = 'CREATE TABLE 0001_init (x INT);'
    const crypto = require('node:crypto') as typeof import('node:crypto')
    const hash = crypto.createHash('sha256').update(sql).digest('hex')
    allRows.push({ hash, created_at: 2000 })

    await runMigrations()
    expect(updateCalls).toEqual([])
  })

  it('treats "no such table" as expected and proceeds to migrate', async () => {
    const folder = setupMigrationsFolder()
    writeJournal(folder, [{ tag: '0001_init', when: 1 }])
    throwOnAll = true

    await runMigrations()
    expect(migrateMock).toHaveBeenCalled()
  })

  it('logs and continues when fixup throws an unexpected error', async () => {
    const folder = setupMigrationsFolder()
    writeJournal(folder, [{ tag: '0001_init', when: 1 }])
    // Make the SELECT throw a NON-"no such table" error so we hit the warn branch
    prepareMock.mockImplementationOnce(() => ({
      all: () => {
        throw new Error('disk i/o error')
      },
    }))

    await runMigrations()
    expect(migrateMock).toHaveBeenCalled()
  })

  describe('pre-migration backup', () => {
    it('backs up BEFORE migrating when the journal has unapplied migrations', async () => {
      const folder = setupMigrationsFolder()
      // Two journal entries, zero applied → pending → must back up.
      writeJournal(folder, [
        { tag: '0001_init', when: 1 },
        { tag: '0002_add', when: 2 },
      ])
      appliedCount = 0

      await runMigrations()

      expect(backupMock).toHaveBeenCalledTimes(1)
      expect(migrateMock).toHaveBeenCalledTimes(1)
      // Backup must precede BOTH the journal-writing repair (P6) and the
      // destructive migrate, so a failure at either has a restore point.
      expect(callOrder).toEqual(['backup', 'repair', 'migrate'])
    })

    it('backs up BEFORE repairSkippedMigrations runs (P6 — repair writes schema/journal)', async () => {
      const folder = setupMigrationsFolder()
      // Journal has an unapplied migration → pending → backup expected. The repair
      // step would apply it and make applied === journal length; if the pending
      // check ran AFTER repair it would see nothing pending and skip the backup.
      writeJournal(folder, [{ tag: '0001_init', when: 1 }])
      appliedCount = 0

      await runMigrations()

      expect(backupMock).toHaveBeenCalledTimes(1)
      expect(repairMock).toHaveBeenCalledTimes(1)
      // The backup entry must come before the repair entry in call order.
      expect(callOrder.indexOf('backup')).toBeLessThan(callOrder.indexOf('repair'))
    })

    it('does NOT back up on a plain restart with no pending migrations', async () => {
      const folder = setupMigrationsFolder()
      writeJournal(folder, [{ tag: '0001_init', when: 1 }])
      appliedCount = 1 // journal length === applied → nothing pending

      await runMigrations()

      expect(backupMock).not.toHaveBeenCalled()
      expect(migrateMock).toHaveBeenCalledTimes(1)
    })

    it('backs up defensively when the applied-count query throws (cannot prove current)', async () => {
      const folder = setupMigrationsFolder()
      writeJournal(folder, [{ tag: '0001_init', when: 1 }])
      // count(*) throws → hasPendingMigrations fails open → back up.
      throwOnAll = true

      await runMigrations()

      expect(backupMock).toHaveBeenCalledTimes(1)
      expect(migrateMock).toHaveBeenCalled()
    })

    it('still migrates when the backup itself throws (best-effort, non-fatal)', async () => {
      const folder = setupMigrationsFolder()
      writeJournal(folder, [{ tag: '0001_init', when: 1 }])
      appliedCount = 0
      backupMock.mockImplementationOnce(() => {
        throw new Error('disk full')
      })

      await runMigrations()

      // A backup failure must not abort startup.
      expect(migrateMock).toHaveBeenCalledTimes(1)
    })
  })
})
