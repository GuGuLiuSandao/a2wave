import { existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import BetterSqlite3 from 'better-sqlite3'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { backupDatabaseBeforeMigrate } from '../migrate.js'

const TMP_ROOT = '/tmp/a2wave-migrate-backup-test'

function freshTmpRoot(): string {
  if (existsSync(TMP_ROOT)) rmSync(TMP_ROOT, { recursive: true, force: true })
  mkdirSync(TMP_ROOT, { recursive: true })
  return TMP_ROOT
}

describe('backupDatabaseBeforeMigrate', () => {
  const originalDbUrl = process.env.DATABASE_URL
  const originalSkip = process.env.A2WAVE_DB_BACKUP_SKIP
  const originalRetention = process.env.A2WAVE_DB_BACKUP_RETENTION

  beforeEach(() => {
    freshTmpRoot()
  })
  afterEach(() => {
    process.env.DATABASE_URL = originalDbUrl
    if (originalSkip === undefined) delete process.env.A2WAVE_DB_BACKUP_SKIP
    else process.env.A2WAVE_DB_BACKUP_SKIP = originalSkip
    if (originalRetention === undefined) delete process.env.A2WAVE_DB_BACKUP_RETENTION
    else process.env.A2WAVE_DB_BACKUP_RETENTION = originalRetention
    if (existsSync(TMP_ROOT)) rmSync(TMP_ROOT, { recursive: true, force: true })
  })

  it('skips backup when A2WAVE_DB_BACKUP_SKIP=true', async () => {
    process.env.A2WAVE_DB_BACKUP_SKIP = 'true'
    const result = backupDatabaseBeforeMigrate(TMP_ROOT)
    expect(result.skipped).toBe(true)
    expect(result.reason).toBe('env_skip')
  })

  it('skips silently when DB file does not exist', async () => {
    delete process.env.A2WAVE_DB_BACKUP_SKIP
    process.env.DATABASE_URL = './data/does-not-exist.db'
    const result = backupDatabaseBeforeMigrate(TMP_ROOT)
    expect(result.skipped).toBe(true)
    expect(result.reason).toBe('no_db')
  })

  it('creates a timestamped backup when DB exists', async () => {
    delete process.env.A2WAVE_DB_BACKUP_SKIP
    const dbDir = join(TMP_ROOT, 'data')
    mkdirSync(dbDir, { recursive: true })
    const dbPath = join(dbDir, 'a2wave.db')
    writeFileSync(dbPath, 'pretend-this-is-sqlite')
    process.env.DATABASE_URL = './data/a2wave.db'

    const result = backupDatabaseBeforeMigrate(TMP_ROOT)
    expect(result.skipped).toBe(false)
    expect(result.target).toBeDefined()
    expect(existsSync(result.target!)).toBe(true)
    const files = readdirSync(join(dbDir, 'backups'))
    expect(files.some((f) => f.startsWith('a2wave-') && f.endsWith('.db'))).toBe(true)
  })

  it('checkpoints WAL before copy so WAL-only commits are included in backup', async () => {
    delete process.env.A2WAVE_DB_BACKUP_SKIP
    const dbDir = join(TMP_ROOT, 'data')
    mkdirSync(dbDir, { recursive: true })
    const dbPath = join(dbDir, 'a2wave.db')

    // 1) 用 WAL 模式建库 + 插入一行，但不显式 checkpoint。
    //    SQLite 此时主 .db 可能只有 schema，行数据落在 -wal 文件里。
    const src = new BetterSqlite3(dbPath)
    src.pragma('journal_mode = WAL')
    src.exec('CREATE TABLE kv (k TEXT PRIMARY KEY, v TEXT)')
    src.prepare('INSERT INTO kv (k, v) VALUES (?, ?)').run('answer', '42')
    src.close()

    process.env.DATABASE_URL = './data/a2wave.db'
    const result = backupDatabaseBeforeMigrate(TMP_ROOT)
    expect(result.skipped).toBe(false)
    expect(result.target).toBeDefined()

    // 2) 备份文件应是一个含有 kv 行数据的完整库。
    const restored = new BetterSqlite3(result.target!, { readonly: true })
    const row = restored.prepare('SELECT v FROM kv WHERE k = ?').get('answer') as
      | { v: string }
      | undefined
    restored.close()
    expect(row?.v).toBe('42')
  })

  it('prunes old backups beyond retention', async () => {
    delete process.env.A2WAVE_DB_BACKUP_SKIP
    process.env.A2WAVE_DB_BACKUP_RETENTION = '2'
    const dbDir = join(TMP_ROOT, 'data')
    mkdirSync(dbDir, { recursive: true })
    const dbPath = join(dbDir, 'a2wave.db')
    writeFileSync(dbPath, 'snapshot')
    process.env.DATABASE_URL = './data/a2wave.db'

    // Pre-create 3 old backups with backdated mtimes by using utimesSync via writeFile.
    const backupDir = join(dbDir, 'backups')
    mkdirSync(backupDir, { recursive: true })
    const fakeOld = [
      'a2wave-20200101-000000.db',
      'a2wave-20200102-000000.db',
      'a2wave-20200103-000000.db',
    ]
    for (const name of fakeOld) writeFileSync(join(backupDir, name), 'old')

    const result = backupDatabaseBeforeMigrate(TMP_ROOT)
    expect(result.skipped).toBe(false)
    // After this call: 1 (new) + 3 (old) = 4 backups, retention=2 → 2 pruned.
    expect(result.pruned?.length ?? 0).toBe(2)
    const remaining = readdirSync(backupDir).filter((f) => f.endsWith('.db'))
    expect(remaining).toHaveLength(2)
  })
})
