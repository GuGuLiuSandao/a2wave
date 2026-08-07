/**
 * Background sync scheduler for KB documents.
 * Checks once per minute and decides whether to sync each document based on its
 * autoSync + syncIntervalMin configuration.
 */
import { and, eq, inArray } from 'drizzle-orm'
import { db } from '../db/client.js'
import { kbDocuments } from '../db/schema.js'
import { REMOTE_KB_SOURCES, hasRemoteKbCredentials } from './kb-remote-fetch.js'
import { hasActiveKbSyncLease } from './kb-sync-lease.js'
import { syncRemoteKbDocument } from './kb-sync-service.js'
import { logger } from './logger.js'

const CHECK_INTERVAL_MS = 60 * 1000 // check every 1 minute
let isSyncing = false

function isDueForSync(doc: { lastSyncAt: Date | null; syncIntervalMin: number }): boolean {
  if (!doc.lastSyncAt) return true
  const elapsed = Date.now() - doc.lastSyncAt.getTime()
  return elapsed >= doc.syncIntervalMin * 60 * 1000
}

async function syncDueRemoteDocs(): Promise<void> {
  if (isSyncing) return
  isSyncing = true
  try {
    await doSync()
  } finally {
    isSyncing = false
  }
}

async function doSync(): Promise<void> {
  const remoteDocs = await (
    await db
      .select()
      .from(kbDocuments)
      .where(
        and(
          inArray(kbDocuments.sourceType, [...REMOTE_KB_SOURCES]),
          eq(kbDocuments.autoSync, true),
        ),
      )
  )
    .filter((d) => !hasActiveKbSyncLease(d) && hasRemoteKbCredentials(d))
    .filter((d) => isDueForSync(d))

  if (remoteDocs.length === 0) return

  logger.info({ count: remoteDocs.length }, 'Starting KB document sync cycle')

  for (const doc of remoteDocs) {
    try {
      const result = await syncRemoteKbDocument(doc)
      if (result.status === 'completed' && result.contentChanged) {
        logger.info({ docId: doc.id, name: doc.name }, 'KB document content updated')
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      logger.warn({ docId: doc.id, error: message }, 'KB document sync failed')
    }
  }

  logger.info('KB document sync cycle complete')
}

let syncTimer: ReturnType<typeof setInterval> | null = null

export function startKbSyncScheduler(): void {
  if (syncTimer) return
  logger.info('Starting KB document sync scheduler (per-document interval)')
  syncTimer = setInterval(() => {
    syncDueRemoteDocs().catch((err) => logger.error(err, 'KB sync scheduler error'))
  }, CHECK_INTERVAL_MS)
  syncTimer.unref()
}
