const KB_SYNC_LEASE_TIMEOUT_MS = 10 * 60 * 1000

interface KbSyncLeaseState {
  syncStatus: string
  updatedAt?: Date | null
}

export function hasActiveKbSyncLease(doc: KbSyncLeaseState, now = Date.now()): boolean {
  if (doc.syncStatus !== 'syncing' || !doc.updatedAt) return false
  return now - doc.updatedAt.getTime() < KB_SYNC_LEASE_TIMEOUT_MS
}
