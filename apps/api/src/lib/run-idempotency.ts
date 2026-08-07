import { and, desc, eq } from 'drizzle-orm'
import { db } from '../db/client.js'
import { runs } from '../db/schema.js'

export type IdempotentTriggerSource = 'api' | 'a2a'

export interface IdempotentRun {
  id: string
  status: string
  result: Record<string, unknown> | null
}

const RUN_IDEMPOTENCY_UNIQUE_NAME = 'runs_idempotency_key_unique'

/**
 * Did this write lose the race on the run idempotency index?
 *
 * Walks the cause chain, because the two backends surface it differently:
 * SQLite throws an Error whose message names the index (or its column list),
 * while PostgreSQL's constraint name reaches us on drizzle's `.cause` — its own
 * message is only "Failed query: insert into ...". Matching just the top level
 * would turn every duplicate A2A/gateway call into a 500 instead of replaying
 * the original run.
 *
 * Scoped to *this* constraint rather than any unique violation: a duplicate
 * username must stay an error, since answering it with an existing run would be
 * far worse than failing.
 */
export function isRunIdempotencyConflict(error: unknown): boolean {
  const seen = new Set<unknown>()
  let current: unknown = error

  while (current && typeof current === 'object' && !seen.has(current)) {
    seen.add(current) // guard against a self-referential cause
    const { message, constraint, cause } = current as {
      message?: unknown
      constraint?: unknown
      cause?: unknown
    }

    if (constraint === RUN_IDEMPOTENCY_UNIQUE_NAME) return true
    if (typeof message === 'string') {
      if (
        message.includes(RUN_IDEMPOTENCY_UNIQUE_NAME) ||
        message.includes('runs.initiator_agent_id, runs.trigger_source, runs.trigger_session_id')
      ) {
        return true
      }
    }

    current = cause
  }

  return false
}

export async function findIdempotentRun(
  agentId: string,
  source: IdempotentTriggerSource,
  triggerSessionId: string,
): Promise<IdempotentRun | undefined> {
  const row = (
    await db
      .select({ id: runs.id, status: runs.status, result: runs.result })
      .from(runs)
      .where(
        and(
          eq(runs.initiatorAgentId, agentId),
          eq(runs.triggerSource, source),
          eq(runs.triggerSessionId, triggerSessionId),
        ),
      )
      .orderBy(desc(runs.createdAt))
      .limit(1)
  )[0]

  if (!row) return undefined
  return { id: row.id, status: row.status, result: row.result ?? null }
}

export function isActiveOrCompletedRun(status: string): boolean {
  return (
    status === 'pending' || status === 'queued' || status === 'running' || status === 'completed'
  )
}
