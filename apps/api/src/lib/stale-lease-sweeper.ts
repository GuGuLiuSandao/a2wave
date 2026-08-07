import {
  completeExecutionLease,
  listActiveExecutionLeases,
} from '../engine/execution-lease-registry.js'
import { taskQueueDb } from '../engine/task-queue-db.js'
import { scheduleNext, sweepStaleLeases } from '../engine/task-queue.js'
import { executeChatRun } from './execute-chat-run.js'
import { logger } from './logger.js'

const DEFAULT_SWEEP_INTERVAL_MS = 60_000

/**
 * Periodically reconcile in-memory execution leases against DB run status,
 * releasing any lease whose run has already terminated. This is the safety net
 * for a lease leaked on an un-guarded early-return path (see sweepStaleLeases):
 * without it a single leak permanently consumes a concurrency slot and wedges
 * the agent's queue until restart.
 */
export function startStaleLeaseSweeper(intervalMs = DEFAULT_SWEEP_INTERVAL_MS): () => void {
  // When each still-held lease's run was first OBSERVED terminal, so the grace
  // window is measured from termination — not from a (possibly hours-old) task
  // start. Held across ticks; entries are pruned as runs finish/reset.
  const firstSeenTerminalAt = new Map<string, number>()
  // async callback: sweepStaleLeases reads run status from the DB, which is a
  // Promise on PostgreSQL. Without awaiting it, `released` would be a Promise —
  // truthy, but with no `.length` — so the guard below would never fire and
  // leaked leases would pin the agent's concurrency until a restart.
  const timer = setInterval(async () => {
    try {
      const released = await sweepStaleLeases(
        taskQueueDb,
        listActiveExecutionLeases(),
        completeExecutionLease,
        Date.now(),
        firstSeenTerminalAt,
      )
      if (released.length > 0) {
        logger.warn(
          { swept: released.length },
          'stale-lease-sweeper: released leaked execution leases',
        )
        // Freeing a slot may unblock a queued run; nudge each affected agent's
        // queue so an already-queued run advances rather than waiting for the
        // next unrelated trigger.
        const agentIds = new Set(released.map((r) => r.agentId).filter((id): id is string => !!id))
        for (const agentId of agentIds) {
          void scheduleNext(taskQueueDb, agentId, (rid, aid) => void executeChatRun(aid, rid))
        }
      }
    } catch (error) {
      logger.error({ error }, 'stale-lease-sweeper: sweep failed')
    }
  }, intervalMs)
  // Don't keep the event loop alive just for the sweeper.
  timer.unref?.()
  return () => clearInterval(timer)
}
