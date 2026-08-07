import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { readMigrationFiles } from 'drizzle-orm/migrator'
import type { SqliteDatabase } from './client.js'

interface AppliedMigration {
  hash: string
  createdAt: number
}

interface MigrationJournal {
  entries: Array<{ tag: string }>
}

const REPAIRABLE_MIGRATION_TAGS = new Set([
  '0078_magenta_rhodey',
  '0079_harsh_amphibian',
  '0080_silky_ben_urich',
  '0081_add_provider_kind',
  '0082_backfill_provider_kind',
  '0083_constrain_provider_kind',
  '0088_aberrant_invaders',
])

/**
 * Drizzle only applies migrations newer than the greatest recorded timestamp. If a migration is
 * later inserted below that timestamp, repair only the reviewed provider-kind migration gap before
 * handing control back to Drizzle. Arbitrary historical migrations are not safe to replay.
 */
export function repairSkippedMigrations(
  database: SqliteDatabase,
  migrationsFolder: string,
): number {
  const applied = database
    .prepare('SELECT hash, created_at AS createdAt FROM __drizzle_migrations')
    .all() as AppliedMigration[]
  if (applied.length === 0) return 0

  const latestTimestamp = Math.max(...applied.map((migration) => Number(migration.createdAt)))
  const appliedHashes = new Set(applied.map((migration) => migration.hash))
  const appliedTimestamps = new Set(
    applied.map((migration) => Number(migration.createdAt)).filter(Number.isFinite),
  )
  const migrations = readMigrationFiles({ migrationsFolder })
  const journal = JSON.parse(
    readFileSync(join(migrationsFolder, 'meta', '_journal.json'), 'utf8'),
  ) as MigrationJournal
  if (journal.entries.length !== migrations.length) {
    throw new Error('Migration journal and migration file counts do not match')
  }
  const skipped = migrations.filter((migration, index) => {
    const tag = journal.entries[index]?.tag
    return (
      tag !== undefined &&
      REPAIRABLE_MIGRATION_TAGS.has(tag) &&
      migration.folderMillis <= latestTimestamp &&
      !appliedHashes.has(migration.hash) &&
      !appliedTimestamps.has(migration.folderMillis)
    )
  })
  if (skipped.length === 0) return 0

  const insertMigration = database.prepare(
    'INSERT INTO __drizzle_migrations (hash, created_at) VALUES (?, ?)',
  )

  database.exec('BEGIN')
  try {
    for (const migration of skipped) {
      for (const statement of migration.sql) database.exec(statement)
      insertMigration.run(migration.hash, migration.folderMillis)
    }
    database.exec('COMMIT')
  } catch (error) {
    database.exec('ROLLBACK')
    throw error
  }

  return skipped.length
}
