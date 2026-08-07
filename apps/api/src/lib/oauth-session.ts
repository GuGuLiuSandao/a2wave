import { createHash } from 'node:crypto'
import { and, desc, eq, inArray, lt } from 'drizzle-orm'
import { db } from '../db/client.js'
import { runs } from '../db/schema.js'
import type { GatewayCaller } from '../middleware/gateway-auth.js'

const OAUTH_ACTIVE_SESSION_UNIQUE_NAME = 'runs_oauth_active_session_unique'

export function isOAuthActiveSessionConflict(error: unknown): boolean {
  const message = (error as { message?: string } | null)?.message ?? ''
  return (
    message.includes(OAUTH_ACTIVE_SESSION_UNIQUE_NAME) ||
    message.includes('runs.initiator_agent_id, runs.trigger_source, runs.trigger_session_id')
  )
}

export function buildOAuthTriggerSessionId(input: {
  agentId: string
  caller: GatewayCaller
  sessionId: string
}): string {
  const user = input.caller.userInfo
  const oauthUserKey = `${user.issuer}\0${user.sub}`
  const digest = createHash('sha256')
    .update(`${input.agentId}\0${oauthUserKey}\0${input.sessionId}`)
    .digest('hex')
    .slice(0, 32)
  return `oauth:${digest}`
}

export async function findActiveOAuthSessionRun(agentId: string, triggerSessionId: string) {
  return (
    await db
      .select({ id: runs.id, status: runs.status })
      .from(runs)
      .where(
        and(
          eq(runs.initiatorAgentId, agentId),
          eq(runs.triggerSource, 'oauth'),
          eq(runs.triggerSessionId, triggerSessionId),
          inArray(runs.status, ['pending', 'queued', 'running']),
        ),
      )
      .orderBy(desc(runs.createdAt))
      .limit(1)
  )[0]
}

export async function lookupPreviousOAuthSessionChatId(
  agentId: string,
  triggerSessionId: string,
  opts: { beforeCreatedAt?: Date } = {},
): Promise<string | null> {
  const row = (
    await db
      .select({ result: runs.result })
      .from(runs)
      .where(
        and(
          eq(runs.initiatorAgentId, agentId),
          eq(runs.triggerSource, 'oauth'),
          eq(runs.triggerSessionId, triggerSessionId),
          eq(runs.status, 'completed'),
          opts.beforeCreatedAt ? lt(runs.createdAt, opts.beforeCreatedAt) : undefined,
        ),
      )
      .orderBy(desc(runs.createdAt))
      .limit(1)
  )[0]

  const result = row?.result as Record<string, unknown> | undefined
  return typeof result?.chatId === 'string' ? result.chatId : null
}
