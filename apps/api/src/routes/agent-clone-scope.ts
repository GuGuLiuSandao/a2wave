import type { GroupConfig } from '@a2wave/shared'
/**
 * Clone-time resource scoping.
 *
 * A clone belongs to the caller, not to the source Agent's owner, so it must not
 * carry bindings the caller could not have created themselves — otherwise the
 * copy outlives a membership revoke and becomes a durable privilege escalation.
 * Both helpers therefore reuse the *same* predicates as the create/update bind
 * checks rather than reimplementing them.
 *
 * Extracted from routes/agents.ts, which the async conversion pushed past the
 * file-lines gate. These two are the most self-contained group in that file:
 * they take a Context plus id lists and return filtered id lists, touching no
 * route state.
 */
import { and, eq, inArray, or } from 'drizzle-orm'
import { db } from '../db/client.js'
import { mcpServers, skillGroups, skills } from '../db/schema.js'
import { canNonAdminUseMcp } from '../lib/mcp-stdio.js'
import { getCurrentUserId } from '../lib/owner-filter.js'
import { canNonAdminUseSkill } from '../lib/skill-access.js'
import { isAdmin } from '../middleware/auth-middleware.js'

export async function filterBindableMcpIdsForClone(
  c: import('hono').Context,
  mcpServerIds: string[] | null | undefined,
): Promise<string[]> {
  if (!mcpServerIds?.length) return []
  if (isAdmin(c)) return mcpServerIds
  const me = getCurrentUserId(c)
  const rows = await db
    .select({
      id: mcpServers.id,
      type: mcpServers.type,
      groupConfig: mcpServers.groupConfig,
      usageScope: mcpServers.usageScope,
      userId: mcpServers.userId,
    })
    .from(mcpServers)
    .where(inArray(mcpServers.id, mcpServerIds))
  // Keep only rows the caller may bind — same single predicate as the bind check.
  const allowed = new Set(
    rows
      .filter((s) =>
        canNonAdminUseMcp(
          {
            type: s.type,
            groupConfig: s.groupConfig as GroupConfig | null,
            usageScope: s.usageScope,
            userId: s.userId,
          },
          me,
        ),
      )
      .map((s) => s.id),
  )
  return mcpServerIds.filter((id) => allowed.has(id))
}

export async function projectBindableSkillReferencesForClone(
  c: import('hono').Context,
  skillIds: string[] | null | undefined,
  groupIds: string[] | null | undefined,
): Promise<{ skillIds: string[]; skillGroupIds: string[] }> {
  const directSkillIds = skillIds ?? []
  const sourceGroupIds = groupIds ?? []
  if (isAdmin(c)) {
    return { skillIds: directSkillIds, skillGroupIds: sourceGroupIds }
  }

  const callerId = getCurrentUserId(c)
  const ownedGroupIds = new Set(
    sourceGroupIds.length > 0
      ? (
          await db
            .select({ id: skillGroups.id })
            .from(skillGroups)
            .where(and(inArray(skillGroups.id, sourceGroupIds), eq(skillGroups.userId, callerId)))
        ).map((row) => row.id)
      : [],
  )
  if (directSkillIds.length === 0 && sourceGroupIds.length === 0) {
    return { skillIds: [], skillGroupIds: [] }
  }

  const candidateCondition =
    directSkillIds.length > 0 && sourceGroupIds.length > 0
      ? or(inArray(skills.id, directSkillIds), inArray(skills.groupId, sourceGroupIds))
      : directSkillIds.length > 0
        ? inArray(skills.id, directSkillIds)
        : inArray(skills.groupId, sourceGroupIds)
  const rows = await db
    .select({
      id: skills.id,
      groupId: skills.groupId,
      userId: skills.userId,
      visibility: skills.visibility,
    })
    .from(skills)
    .where(candidateCondition)
  const unsafeOwnedGroupIds = new Set(
    rows
      .filter(
        (row) =>
          row.groupId !== null &&
          ownedGroupIds.has(row.groupId) &&
          !canNonAdminUseSkill(row, callerId),
      )
      .flatMap((row) => (row.groupId === null ? [] : [row.groupId])),
  )
  const retainedGroupIds = [
    ...new Set(
      sourceGroupIds.filter((id) => ownedGroupIds.has(id) && !unsafeOwnedGroupIds.has(id)),
    ),
  ]
  const retainedGroupIdSet = new Set(retainedGroupIds)
  const droppedGroupIds = [...new Set(sourceGroupIds.filter((id) => !retainedGroupIdSet.has(id)))]
  const droppedGroupIdSet = new Set(droppedGroupIds)
  const allowedRows = rows.filter((row) => canNonAdminUseSkill(row, callerId))
  const allowedIds = new Set(allowedRows.map((row) => row.id))
  const flattenedIds = allowedRows
    .filter((row) => row.groupId !== null && droppedGroupIdSet.has(row.groupId))
    .map((row) => row.id)

  return {
    skillIds: [...new Set([...directSkillIds.filter((id) => allowedIds.has(id)), ...flattenedIds])],
    skillGroupIds: retainedGroupIds,
  }
}
