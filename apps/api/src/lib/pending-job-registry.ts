import { logger } from './logger.js'

/**
 * In-memory registry for pending execution jobs.
 *
 * When a Feishu message is queued (tryAcquireSlot returns 'queued'), the full
 * execution closure is registered here. When scheduleNext promotes the run,
 * executeChatRun checks this registry first — if a pending job exists, the
 * closure runs with full Feishu reply capabilities instead of the degraded
 * DB-only path.
 *
 * On server restart the Map is lost; queued runs fall back to executeChatRun
 * (degraded but acceptable).
 */
const pendingJobs = new Map<string, () => Promise<void>>()

export function registerPendingJob(runId: string, execute: () => Promise<void>): void {
  pendingJobs.set(runId, execute)
}

export function takePendingJob(runId: string): (() => Promise<void>) | undefined {
  const job = pendingJobs.get(runId)
  if (job) pendingJobs.delete(runId)
  return job
}

/**
 * In-memory registry for the executor context of a queued run.
 *
 * Use case: when a REST gateway request is queued (tryAcquireSlot === 'queued'),
 * we cannot insert a runSteps row yet (executeChatRun owns that), but we still
 * want to forward request-time context (e.g. OAuth caller identity) to the eventual
 * step record. The gateway calls registerPendingContext(runId, context); executeChatRun
 * calls takePendingContext(runId) and uses it as the step's input.context.
 *
 * KNOWN LIMITATION (OAuth channel, accepted trade-off):
 * pendingContexts is in-memory only. If the server restarts while OAuth-authenticated
 * runs are queued, `recoverOnStartup` will still resume them but `takePendingContext`
 * returns undefined — runSteps.input.context.caller will be empty, breaking the audit
 * trail for those runs. Chosen over the alternative of a DB migration + write at each
 * enqueue. If stronger audit guarantees are required later, persist caller identity on
 * the `runs` row at enqueue time.
 *
 * Leak defense: sweepPendingContexts() is invoked at the top of executeChatRun to
 * evict entries older than STALE_CONTEXT_TTL_MS. This covers rare leak paths (worker
 * crash, admin direct-delete of a queued run) that bypass the cancel / executeChatRun
 * cleanup routes.
 */
interface PendingContextEntry {
  context: Record<string, unknown>
  enqueuedAt: number
}

const pendingContexts = new Map<string, PendingContextEntry>()

// 1 hour: > any realistic queue lifetime for gateway requests, so normal flow is
// never swept, but stale leaks (crashed worker, direct DB delete) are bounded.
const STALE_CONTEXT_TTL_MS = 60 * 60 * 1000

export function registerPendingContext(runId: string, context: Record<string, unknown>): void {
  pendingContexts.set(runId, { context, enqueuedAt: Date.now() })
}

export function takePendingContext(runId: string): Record<string, unknown> | undefined {
  const entry = pendingContexts.get(runId)
  if (!entry) return undefined
  pendingContexts.delete(runId)
  return entry.context
}

/**
 * Evict pending-context entries whose enqueuedAt is older than maxAgeMs.
 * Returns the number of entries removed. Safe to call from hot paths — the
 * Map typically has O(10) or fewer live entries, so O(n) scan is negligible.
 */
export function sweepPendingContexts(maxAgeMs: number = STALE_CONTEXT_TTL_MS): number {
  const now = Date.now()
  let removed = 0
  for (const [runId, entry] of pendingContexts) {
    const ageMs = now - entry.enqueuedAt
    if (ageMs > maxAgeMs) {
      pendingContexts.delete(runId)
      removed++
      logger.warn({ runId, ageMs }, 'Pending context swept as stale')
    }
  }
  return removed
}

// Test-only helper: resets both Maps so suites don't leak state across cases.
export function __resetPendingRegistriesForTest(): void {
  pendingJobs.clear()
  pendingContexts.clear()
}
