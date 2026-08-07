import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { backupDatabaseBeforeMigrate } from './db-backup.js'

// Re-export so existing importers (and tests) that referenced migrate.ts keep working;
// the implementation now lives in the side-effect-free db-backup.ts.
export { backupDatabaseBeforeMigrate } from './db-backup.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const apiRoot = path.resolve(__dirname, '..', '..')

// Only run as the standalone migration CLI when this module is the process
// entrypoint. In the bundled server (dist/index.js), migrate-runtime.ts pulls in
// backupDatabaseBeforeMigrate; tsup inlines this file, so ANY module-level side
// effect (chdir, env fallback, the migrate block) would otherwise fire at server
// startup — and with import.meta.url === argv[1] both pointing at dist/index.js,
// the CLI block would run and process.exit the server. Everything side-effecting
// is therefore gated behind this guard.
const isCli = import.meta.url === `file://${process.argv[1]}`
if (isCli) {
  // 迁移是部署/开发的运维动作，不依赖 AUTH_SECRET。env.ts 默认 NODE_ENV='production'
  // 会强校验 AUTH_SECRET，导致 `pnpm db:migrate` 在本地 .env 用占位 secret 时报错。
  // 这里在加载 env.ts 之前兜底为 development（生产场景下 NODE_ENV 已显式设置，不受影响）。
  if (!process.env.NODE_ENV) process.env.NODE_ENV = 'development'
  // AUTH_SECRET is now mandatory outside NODE_ENV=test (server refuses to start
  // without it), but a migration never signs/verifies tokens — inject a placeholder
  // so `pnpm db:migrate` still works before .env exists (fresh setup, CI).
  if (!process.env.AUTH_SECRET) process.env.AUTH_SECRET = 'ops-script-placeholder-secret-unused'

  // 确保无论从 monorepo 哪里执行，都使用 apps/api 的 cwd（数据库路径、migrations 都基于此）
  process.chdir(apiRoot)

  // Load .env *before* reading DATABASE_URL below. env.ts owns this side effect
  // for the server, but nothing on the path to the dialect check imports it —
  // so a `postgres://` URL that lives only in .env used to read as undefined,
  // silently take the SQLite branch, resolve the connection string as a relative
  // file path, and crash in repairSkippedMigrations on a null sqliteDatabase.
  const { loadDotenvFiles } = await import('../load-dotenv.js')
  loadDotenvFiles()

  const { resolveDialect } = await import('./dialect.js')

  // Read process.env directly rather than env.ts: this branch runs before the
  // client module is loaded, and must agree with env.ts's default.
  if (resolveDialect(process.env.DATABASE_URL) === 'postgres') {
    // No file backup, no journal repair — see runPostgresMigrations() in
    // migrate-runtime.ts for why neither applies to a server database.
    const { migrate: migratePg } = await import('drizzle-orm/node-postgres/migrator')
    const { db, closeDatabaseConnection } = await import('./client.js')
    const migrationsFolder = path.join(apiRoot, 'drizzle-pg')
    console.log('Running PostgreSQL migrations...')
    try {
      // `db` is statically typed as the SQLite handle (see db/client.ts); under a
      // postgres:// URL the runtime object is the node-postgres one, which is what
      // this branch has already established.
      await migratePg(db as unknown as Parameters<typeof migratePg>[0], { migrationsFolder })
    } catch (err) {
      console.error(
        '✗ PostgreSQL migration failed. Check that the role in DATABASE_URL can CREATE in this database, and that no partially-applied migration was left behind — never retry against a database in an unknown state.',
      )
      console.error(err instanceof Error ? err.message : err)
      process.exit(1)
    }
    console.log('Migrations complete!')
    // The pool keeps the event loop alive; a CLI must exit when it is done.
    await closeDatabaseConnection()
  } else {
    backupDatabaseBeforeMigrate()

    const { migrate } = await import('drizzle-orm/better-sqlite3/migrator')
    const { db, sqliteDatabase } = await import('./client.js')
    const { repairSkippedMigrations } = await import('./migration-gap-repair.js')

    const migrationsFolder = path.join(apiRoot, 'drizzle')
    console.log('Running migrations...')
    try {
      try {
        const repairedCount = repairSkippedMigrations(sqliteDatabase, migrationsFolder)
        if (repairedCount > 0) {
          console.warn(`[migrate] applied ${repairedCount} reviewed skipped migration(s)`)
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        if (!/no such table:\s*__drizzle_migrations/i.test(message)) throw err
      }
      migrate(db, { migrationsFolder })
    } catch (err) {
      // Mirror migrate-runtime.ts: a bare SqliteError gives no hint that the fix
      // is the DB file, not the code.
      const dbPath = path.resolve(process.env.DATABASE_URL ?? './data/a2wave.db')
      console.error(
        `✗ Database migration failed against ${dbPath}. The DB file is likely stale or was modified outside the migration flow. In dev, delete the file to start fresh; in production, restore the pre-migration backup — never retry against a broken DB.`,
      )
      console.error(err instanceof Error ? err.message : err)
      process.exit(1)
    }
    console.log('Migrations complete!')
  }
}
