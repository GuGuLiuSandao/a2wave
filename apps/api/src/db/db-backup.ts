import { copyFileSync, existsSync, mkdirSync, readdirSync, statSync, unlinkSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import BetterSqlite3 from 'better-sqlite3'
import { isPostgresUrl } from './dialect.js'

/**
 * Pre-migration SQLite backup — **side-effect-free** module.
 *
 * This lives apart from `migrate.ts` on purpose: `migrate.ts` performs top-level
 * `process.chdir()` + NODE_ENV/AUTH_SECRET fallbacks and an `import.meta.url ===
 * argv[1]` CLI block. `apps/api` is bundled by tsup into a single `dist/index.js`,
 * so importing `migrate.ts` from the server startup path (`migrate-runtime.ts`)
 * inlined those side effects into the server and — worse — made the CLI guard
 * true at `node dist/index.js` runtime, chdir'ing to the wrong dir and exiting.
 * Both the runtime migration and the CLI import the backup helper from HERE, and
 * this file must never gain a module-level statement with a side effect.
 */

const __dirname = path.dirname(fileURLToPath(import.meta.url))
/** apps/api (this file is at apps/api/src/db/) — a pure expression, no chdir. */
const apiRoot = path.resolve(__dirname, '..', '..')

function readBackupRetention(): number {
  return Number.parseInt(process.env.A2WAVE_DB_BACKUP_RETENTION || '20', 10) || 20
}

function tsStamp(): string {
  const d = new Date()
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`
}

/**
 * client.ts opens WAL mode; a bare copyFileSync(.db) would miss committed
 * transactions still sitting in `-wal`. Checkpoint (TRUNCATE) folds WAL back into
 * the main file first, so the copy is a complete snapshot. If the file is not a
 * valid SQLite DB (test stub / corruption) we only warn and let the caller do a
 * raw byte copy — at least a copy of the original survives.
 */
function checkpointBeforeBackup(dbPath: string): { ok: boolean; reason?: string } {
  try {
    const db = new BetterSqlite3(dbPath, { fileMustExist: true })
    try {
      db.pragma('wal_checkpoint(TRUNCATE)')
      return { ok: true }
    } finally {
      db.close()
    }
  } catch (err) {
    return { ok: false, reason: err instanceof Error ? err.message : String(err) }
  }
}

/**
 * Back up the current SQLite file before a migration.
 *
 * - Backup dir: `<dbDir>/backups/`
 * - Name: `a2wave-<YYYYMMDD-HHmmss>.db`
 * - Retention: newest BACKUP_RETENTION (default 20) by mtime; older pruned
 * - DB missing (first migration) → skip, not an error
 *
 * Reads `process.env` directly (not env.ts) to avoid triggering zod validation
 * and an early client.ts DB open. Skippable via `A2WAVE_DB_BACKUP_SKIP=true`
 * (CI / tests only).
 */
export function backupDatabaseBeforeMigrate(rootDir: string = apiRoot): {
  skipped: boolean
  reason?: string
  target?: string
  pruned?: string[]
} {
  if (process.env.A2WAVE_DB_BACKUP_SKIP === 'true') {
    console.log('[migrate] backup skipped (A2WAVE_DB_BACKUP_SKIP=true)')
    return { skipped: true, reason: 'env_skip' }
  }
  const dbUrl = process.env.DATABASE_URL || './data/a2wave.db'
  // A postgres:// URL is not a path. Resolving one would produce a nonsense
  // directory, and — worse — copying nothing while reporting success would imply
  // a rollback point that does not exist. PostgreSQL backups are the operator's
  // pg_dump; say so instead of pretending.
  if (isPostgresUrl(dbUrl)) {
    console.log('[migrate] PostgreSQL backend — skipping file backup (use pg_dump)')
    return { skipped: true, reason: 'postgres' }
  }
  const dbPath = path.resolve(rootDir, dbUrl)
  if (!existsSync(dbPath)) {
    console.log(`[migrate] no existing DB at ${dbPath}; skipping backup`)
    return { skipped: true, reason: 'no_db' }
  }
  const backupDir = path.join(path.dirname(dbPath), 'backups')
  if (!existsSync(backupDir)) mkdirSync(backupDir, { recursive: true })
  const target = path.join(backupDir, `a2wave-${tsStamp()}.db`)
  const checkpoint = checkpointBeforeBackup(dbPath)
  if (!checkpoint.ok) {
    console.warn(
      `[migrate] wal_checkpoint skipped (${checkpoint.reason}); backup will be raw byte copy and may miss WAL-only commits`,
    )
  }
  copyFileSync(dbPath, target)
  console.log(`[migrate] backed up DB to ${target}`)

  const files = readdirSync(backupDir)
    .filter((f) => f.startsWith('a2wave-') && f.endsWith('.db'))
    .map((f) => {
      const full = path.join(backupDir, f)
      return { full, mtime: statSync(full).mtimeMs }
    })
    .sort((a, b) => b.mtime - a.mtime)
  const stale = files.slice(readBackupRetention())
  const pruned: string[] = []
  for (const f of stale) {
    try {
      unlinkSync(f.full)
      pruned.push(f.full)
      console.log(`[migrate] pruned old backup ${f.full}`)
    } catch (err) {
      console.warn(
        `[migrate] failed to prune ${f.full}: ${err instanceof Error ? err.message : String(err)}`,
      )
    }
  }
  return { skipped: false, target, pruned }
}
