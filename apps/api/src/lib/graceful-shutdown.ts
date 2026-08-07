import { logger } from './logger.js'

/**
 * Side effects the graceful-shutdown sequence orchestrates, injected so the
 * ordering can be unit-tested without the real server/DB/process.
 */
export interface GracefulShutdownDeps {
  /** Terminate every active agent CLI child (SIGTERM → SIGKILL) and AWAIT exit. */
  shutdownEngines: () => Promise<void>
  stopFeishu: () => void
  stopSlack: () => void
  stopDiscord: () => void
  stopSchedules: () => void
  /**
   * Wait for fire-and-forget audit inserts to settle. `logAudit` returns void and
   * no route awaits it, so an entry can still be queued when the signal arrives —
   * and the request that triggered it has already returned 200. Closing the
   * database first would drop it, which Iron Rule 5 forbids.
   */
  drainAuditWrites: () => Promise<void>
  /**
   * Close the database. Returns a promise on PostgreSQL, where closing drains a
   * connection pool over the network; SQLite closes synchronously. Awaited
   * either way, so an unawaited drain cannot let the process exit while
   * terminal-state writes are still in flight.
   */
  closeDatabase: () => void | Promise<void>
}

/**
 * Ordered shutdown: reap child processes FIRST and wait for them, so their
 * terminal-state writes land before the DB closes and no agent CLI subprocess
 * outlives the pod as an orphan still mutating the workspace. Every step is
 * guarded so one failure can't strand a later one (the DB must always close).
 *
 * NOTE: engineRegistry also registers its own SIGTERM/SIGINT handler that calls
 * the same shutdown; both awaiting the idempotent cliProcessRunner.shutdown()
 * is harmless (second call finds no active processes).
 */
export async function runGracefulShutdownSequence(deps: GracefulShutdownDeps): Promise<void> {
  try {
    await deps.shutdownEngines()
  } catch (error) {
    logger.error({ error }, 'graceful-shutdown: failed to terminate agent CLI processes')
  }
  safely(deps.stopFeishu, 'stopFeishu')
  safely(deps.stopSlack, 'stopSlack')
  safely(deps.stopDiscord, 'stopDiscord')
  safely(deps.stopSchedules, 'stopSchedules')
  // After the engines (their terminal-state writes may themselves audit) and
  // strictly before the database closes.
  await safelyAsync(deps.drainAuditWrites, 'drainAuditWrites')
  await safelyAsync(deps.closeDatabase, 'closeDatabase')
}

function safely(fn: () => void, label: string): void {
  try {
    fn()
  } catch (error) {
    logger.error({ error }, `graceful-shutdown: ${label} failed`)
  }
}

/**
 * `safely` for a step that may be asynchronous. Awaits the result so a rejected
 * promise is logged here rather than escaping as an unhandled rejection during
 * shutdown, where it would mask the real exit reason.
 */
async function safelyAsync(fn: () => void | Promise<void>, label: string): Promise<void> {
  try {
    await fn()
  } catch (error) {
    logger.error({ error }, `graceful-shutdown: ${label} failed`)
  }
}
