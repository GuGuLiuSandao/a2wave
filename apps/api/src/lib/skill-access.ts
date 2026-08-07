import type { SkillVisibility } from '@a2wave/shared'
import { type SQL, eq, or } from 'drizzle-orm'
import type { SQLiteColumn } from 'drizzle-orm/sqlite-core'
import type { Context } from 'hono'

/** The minimal persisted shape needed to decide Skill access. */
export interface SkillAccessRow {
  visibility: SkillVisibility
  userId: string | null
}

/**
 * True when a non-admin may discover and bind this Skill: they either own the
 * private row or an administrator explicitly published it to all users.
 */
export function canNonAdminUseSkill(
  row: SkillAccessRow,
  callerId: string | null | undefined,
): boolean {
  if (row.visibility === 'all-users') return true
  return row.userId != null && row.userId === callerId
}

/**
 * Runtime and bind-time rule for Skills attached to an Agent. An active admin
 * owner may use every persisted Skill; every other Agent is limited to Skills
 * its owner could bind directly.
 */
export function canAgentOwnerUseSkill(
  row: SkillAccessRow,
  ownerId: string | null,
  ownerIsActiveAdmin: boolean,
): boolean {
  return ownerIsActiveAdmin || canNonAdminUseSkill(row, ownerId)
}

/**
 * Read/bind visibility filter for Skill queries. Admins see every row; other
 * users see their own rows plus Skills explicitly published to all users.
 */
export function getSkillVisibilityFilter(
  c: Context,
  userIdColumn: SQLiteColumn,
  visibilityColumn: SQLiteColumn,
): SQL<unknown> | undefined {
  const role = c.get('userRole' as never) as string
  if (role === 'admin') return undefined

  const userId = c.get('userId' as never) as string | undefined
  if (!userId) return eq(visibilityColumn, 'all-users')
  return or(eq(userIdColumn, userId), eq(visibilityColumn, 'all-users'))
}
