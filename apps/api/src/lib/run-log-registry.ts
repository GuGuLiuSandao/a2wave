/**
 * In-memory registry mapping runId -> active PersistingLogCollector.
 *
 * Used so the cancel handler (which runs in a different request than the
 * executor) can explicitly drain the collector before it overwrites
 * `runs.status = 'cancelled'` in the database. Without this, a pending
 * debounce flush could race the cancel write and momentarily revert the
 * UI back to the pre-cancel state.
 */
import type { PersistingLogCollector } from './run-lifecycle.js'

const collectors = new Map<string, PersistingLogCollector>()

export function registerLogCollector(runId: string, collector: PersistingLogCollector): void {
  collectors.set(runId, collector)
}

export function unregisterLogCollector(runId: string): void {
  collectors.delete(runId)
}

/** Drain and detach the collector for the given runId. No-op if not registered. */
export async function stopLogCollector(runId: string): Promise<void> {
  const c = collectors.get(runId)
  if (!c) return
  collectors.delete(runId)
  await c.stop()
}

export function __resetForTest(): void {
  collectors.clear()
}
