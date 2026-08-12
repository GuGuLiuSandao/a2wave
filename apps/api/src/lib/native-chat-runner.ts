import type {
  AttachmentRef,
  RunChannelContextDiscord,
  RunChannelContextQQOfficial,
  RunChannelContextSlack,
} from '@a2wave/shared'
import { eq } from 'drizzle-orm'
import { db } from '../db/client.js'
import { agents, runs } from '../db/schema.js'
import { taskQueueDb } from '../engine/task-queue-db.js'
import { tryAcquireSlot } from '../engine/task-queue.js'
import { executeChatRun } from './execute-chat-run.js'
import { createId } from './id.js'
import { logger } from './logger.js'
import type {
  NativeChatAttachment,
  PersistedNativeChatAttachment,
} from './native-chat-attachments.js'

export type NativeChatSource = 'slack' | 'discord' | 'qq_official'
export interface ReserveNativeChatRunInput {
  agentId: string
  source: NativeChatSource
  eventId: string
  conversationId: string
  intent: string
  channel: RunChannelContextSlack | RunChannelContextDiscord | RunChannelContextQQOfficial
  displayName?: string | null
  nativeAttachments?: PersistedNativeChatAttachment[]
  attachments?: AttachmentRef[]
  attachmentConsumerId?: string
}

export type ReserveNativeChatRunResult =
  | { status: 'ignored' | 'duplicate' }
  | { status: 'started' | 'queued' | 'queue_full'; runId: string }

/**
 * Did this insert lose the race on the native-chat event dedup index?
 *
 * Walks the cause chain: SQLite names the index in the error message, while
 * PostgreSQL puts the constraint on drizzle's `.cause` (its own message is just
 * "Failed query: ..."). Missing it would turn a duplicate Slack/Discord delivery
 * into a thrown error instead of a silent no-op — and the retry that follows
 * would have the agent answer the same message twice.
 */
function isNativeChatEventConflict(error: unknown): boolean {
  const seen = new Set<unknown>()
  let current: unknown = error

  while (current && typeof current === 'object' && !seen.has(current)) {
    seen.add(current)
    const { message, constraint, cause } = current as {
      message?: unknown
      constraint?: unknown
      cause?: unknown
    }
    if (constraint === 'runs_native_chat_event_unique') return true
    if (typeof message === 'string') {
      if (
        message.includes('runs_native_chat_event_unique') ||
        (message.includes('UNIQUE constraint failed') && message.includes('trigger_event_id'))
      ) {
        return true
      }
    }
    current = cause
  }
  return false
}

/**
 * Durably reserve a Slack/Discord event as a Run before the transport acknowledges it.
 * Execution always flows through executeChatRun, so native chat channels reuse the
 * existing queue, recovery, workspace preparation, lifecycle, and audit path.
 */
export async function reserveNativeChatRun(
  input: ReserveNativeChatRunInput,
): Promise<ReserveNativeChatRunResult> {
  const [agent] = await db.select().from(agents).where(eq(agents.id, input.agentId)).limit(1)
  const channels = agent?.publishChannels ?? []
  if (!agent || agent.publishStatus !== 'published' || !channels.includes(input.source)) {
    return { status: 'ignored' }
  }

  const runId = createId('run')
  try {
    await db.insert(runs).values({
      id: runId,
      intent: input.intent,
      initiatorAgentId: input.agentId,
      userId: agent.userId ?? undefined,
      status: 'pending',
      triggerSource: input.source,
      triggerSessionId: input.conversationId,
      triggerEventId: input.eventId,
      triggerUserName: input.displayName ?? null,
      executionMetadata: {
        nativeChatContext: { channel: input.channel },
        ...(input.attachments && input.attachments.length > 0
          ? {
              attachments: input.attachments,
              attachmentConsumerId: input.attachmentConsumerId ?? `agent:${input.agentId}`,
            }
          : {}),
        ...(input.nativeAttachments && input.nativeAttachments.length > 0
          ? { nativeAttachments: input.nativeAttachments }
          : {}),
      },
    })
  } catch (error) {
    if (isNativeChatEventConflict(error)) {
      logger.info(
        { agentId: input.agentId, source: input.source, eventId: input.eventId },
        'Native chat event already reserved',
      )
      return { status: 'duplicate' }
    }
    throw error
  }

  const slot = await tryAcquireSlot(taskQueueDb, input.agentId, runId, agent.maxConcurrency ?? 1)
  if (slot === 'queue_full') {
    await db
      .update(runs)
      .set({
        status: 'failed',
        result: { error: 'Agent queue is full' },
        updatedAt: new Date(),
      })
      .where(eq(runs.id, runId))
    return { status: 'queue_full', runId }
  }
  if (slot === 'queued') return { status: 'queued', runId }

  void executeChatRun(input.agentId, runId).catch((error) =>
    logger.error(
      { error, agentId: input.agentId, runId, source: input.source },
      'Native chat run execution failed unexpectedly',
    ),
  )
  return { status: 'started', runId }
}
