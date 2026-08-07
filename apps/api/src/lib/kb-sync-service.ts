import { and, eq } from 'drizzle-orm'
import { db } from '../db/client.js'
import { kbDocuments } from '../db/schema.js'
import { withTransaction } from '../db/transaction.js'
import { type RemoteKbDoc, fetchRemoteKbContent } from './kb-remote-fetch.js'
import { validateKbFileSize, writeKbContent, writeKbMeta } from './kb-storage.js'

export interface SyncableRemoteKbDoc extends RemoteKbDoc {
  id: string
  name: string
  contentHash?: string | null
  syncStatus: string
  updatedAt: Date
}

interface KbSyncLease {
  id: string
  acquiredAt: Date
}

export type KbSyncResult =
  | { status: 'completed'; document: typeof kbDocuments.$inferSelect; contentChanged: boolean }
  | { status: 'not-claimed' }
  | { status: 'superseded' }

/**
 * Produce a timestamp strictly greater than `previous`, used as the optimistic-lock version.
 *
 * ⚠️ Precision note: kb_documents.updatedAt is stored with Drizzle `mode: 'timestamp'`, i.e.
 * *second* precision (milliseconds are truncated on write). So the +1ms "monotonic increment"
 * here collapses back to the same second once persisted, and updatedAt alone **cannot
 * distinguish two changes within the same second**. The lock's correctness therefore actually
 * rests on the syncStatus state transition:
 *   - On claim, idle/synced/error → 'syncing' changes syncStatus, so a concurrent claimer is
 *     blocked by claimKbSyncLease's `eq(syncStatus, doc.syncStatus)`;
 *   - Re-claiming a stale 'syncing' → 'syncing' does not change the status, so it relies on
 *     updatedAt; hasActiveKbSyncLease's 10-minute lease guarantees the reclaimed row's updatedAt
 *     is already ten minutes old (second precision is enough to distinguish it);
 *   - A PATCH that changes credentials mid-sync sets syncStatus to 'idle', making the completion
 *     path's leaseCondition mismatch → superseded.
 * Maintenance note: if the lease timeout is lowered below ~1 second, or a transition that does not
 * change syncStatus is added, second-precision updatedAt will no longer be enough to prevent
 * re-entrancy — at that point migrate updatedAt to `mode: 'timestamp_ms'` or use a dedicated
 * auto-incrementing version column.
 */
export function nextKbUpdatedAt(previous?: Date | null): Date {
  return new Date(Math.max(Date.now(), (previous?.getTime() ?? 0) + 1))
}

function leaseCondition(lease: KbSyncLease) {
  return and(
    eq(kbDocuments.id, lease.id),
    eq(kbDocuments.syncStatus, 'syncing'),
    eq(kbDocuments.updatedAt, lease.acquiredAt),
  )
}

async function claimKbSyncLease(doc: SyncableRemoteKbDoc): Promise<KbSyncLease | null> {
  const acquiredAt = nextKbUpdatedAt(doc.updatedAt)
  const claimed = (
    await db
      .update(kbDocuments)
      .set({ syncStatus: 'syncing', updatedAt: acquiredAt })
      .where(
        and(
          eq(kbDocuments.id, doc.id),
          eq(kbDocuments.syncStatus, doc.syncStatus as 'idle' | 'syncing' | 'synced' | 'error'),
          eq(kbDocuments.updatedAt, doc.updatedAt),
        ),
      )
      .returning({ id: kbDocuments.id })
  )[0]

  return claimed ? { id: doc.id, acquiredAt } : null
}

export async function syncRemoteKbDocument(doc: SyncableRemoteKbDoc): Promise<KbSyncResult> {
  const lease = await claimKbSyncLease(doc)
  if (!lease) return { status: 'not-claimed' }

  try {
    const { title, content, contentHash } = await fetchRemoteKbContent(doc)
    const fileSize = Buffer.byteLength(content, 'utf-8')
    validateKbFileSize(fileSize)
    const contentChanged = contentHash !== doc.contentHash

    const updated = await withTransaction(async (tx) => {
      const row = (
        await tx
          .update(kbDocuments)
          .set({
            contentHash,
            fileSize,
            syncStatus: 'synced',
            lastSyncAt: new Date(),
            lastSyncError: null,
            storagePath: doc.id,
            updatedAt: nextKbUpdatedAt(lease.acquiredAt),
          })
          .where(leaseCondition(lease))
          .returning()
      )[0]

      if (!row) return null
      if (contentChanged) {
        writeKbContent(doc.id, content)
        writeKbMeta(doc.id, { title, fetchedAt: new Date().toISOString() })
      }
      return row
    })

    return updated
      ? { status: 'completed', document: updated, contentChanged }
      : { status: 'superseded' }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    const updated = (
      await db
        .update(kbDocuments)
        .set({
          syncStatus: 'error',
          lastSyncError: message,
          // Stamp lastSyncAt on failure too, so isDueForSync backs off by syncIntervalMin
          // instead of hot-retrying a persistently failing doc every check cycle.
          lastSyncAt: new Date(),
          updatedAt: nextKbUpdatedAt(lease.acquiredAt),
        })
        .where(leaseCondition(lease))
        .returning({ id: kbDocuments.id })
    )[0]

    if (!updated) return { status: 'superseded' }
    throw error
  }
}
