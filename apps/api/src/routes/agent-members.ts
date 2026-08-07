/**
 * Agent membership management routes.
 *
 * Mounted at `/api/agents` (alongside the main agents router) — only the
 * `/:id/members*` subtree is owned here, so there is no path conflict with
 * the parent agents router.
 *
 * Permission model:
 *   - GET    /:id/members         — read access (owner | editor | viewer | admin)
 *   - POST   /:id/members         — owner only (admin counts as owner)
 *   - PATCH  /:id/members/:userId — owner only
 *   - DELETE /:id/members/:userId — owner only
 *
 * NULL-owner agents (legacy/system) cannot have members; admins can read but
 * adding members is rejected.
 */
import { addAgentMemberInput, updateAgentMemberInput } from '@a2wave/shared'
import { and, asc, eq } from 'drizzle-orm'
import { Hono } from 'hono'
import { db } from '../db/client.js'
import { agentMembers, users } from '../db/schema.js'
import { requireAgentOwner, requireAgentRead } from '../lib/agent-access.js'
import { logAudit } from '../lib/audit.js'
import { isUniqueViolation } from '../lib/db-errors.js'

const app = new Hono()

interface MemberRow {
  userId: string
  username: string
  displayName: string | null
  email: string | null
  role: 'owner' | 'editor' | 'viewer'
  isOwner: boolean
  createdAt: Date
}

/** GET /:id/members — list members (owner + true members) */
app.get('/:id/members', async (c) => {
  const { id } = c.req.param()
  const { agent } = await requireAgentRead(c, id)

  const memberRows = await db
    .select({
      userId: agentMembers.userId,
      username: users.username,
      displayName: users.displayName,
      email: users.email,
      role: agentMembers.role,
      createdAt: agentMembers.createdAt,
    })
    .from(agentMembers)
    .leftJoin(users, eq(agentMembers.userId, users.id))
    .where(eq(agentMembers.agentId, id))
    .orderBy(asc(agentMembers.createdAt))

  const data: MemberRow[] = []

  // Synthesize owner row only when the agent has a real owner.
  // NULL-owner (legacy/system) agents are admin-only and do not expose any
  // implicit owner row — they appear as "no members" to admins.
  if (agent.userId !== null) {
    const ownerUser = (
      await db
        .select({
          id: users.id,
          username: users.username,
          displayName: users.displayName,
          email: users.email,
          createdAt: users.createdAt,
        })
        .from(users)
        .where(eq(users.id, agent.userId))
        .limit(1)
    )[0]
    if (ownerUser) {
      data.push({
        userId: ownerUser.id,
        username: ownerUser.username,
        displayName: ownerUser.displayName,
        email: ownerUser.email,
        role: 'owner',
        isOwner: true,
        // Use the owner's user.createdAt — represents when this user became
        // the agent's owner (since the owner is set at agent-create time and
        // owners cannot be changed in-place, this is the most stable anchor).
        createdAt: ownerUser.createdAt,
      })
    }
  }

  for (const row of memberRows) {
    data.push({
      userId: row.userId,
      username: row.username ?? '',
      displayName: row.displayName ?? null,
      email: row.email ?? null,
      role: row.role as 'editor' | 'viewer',
      isOwner: false,
      createdAt: row.createdAt,
    })
  }

  return c.json({ data })
})

/** POST /:id/members — owner adds a new member */
app.post('/:id/members', async (c) => {
  const { id } = c.req.param()
  const { agent } = await requireAgentOwner(c, id)
  const currentUserId = c.get('userId' as never) as string

  // NULL-owner agents are admin-only system agents — no membership concept.
  if (agent.userId === null) {
    return c.json({ error: 'Cannot add members to system agent' }, 400)
  }

  const body = await c.req.json().catch(() => null)
  const parsed = addAgentMemberInput.safeParse(body)
  if (!parsed.success) {
    return c.json({ error: parsed.error.flatten() }, 400)
  }
  const { userId: targetUserId, role } = parsed.data

  if (targetUserId === agent.userId) {
    return c.json({ error: 'Owner is implicitly a member' }, 400)
  }
  if (targetUserId === currentUserId) {
    // Defense-in-depth: requireAgentOwner already implies caller is owner
    // (or admin-acting-as-owner). For admins, currentUserId !== agent.userId,
    // so this catches "admin adding themselves to someone else's agent" too.
    return c.json({ error: 'Cannot add yourself' }, 400)
  }

  const targetUser = (await db.select().from(users).where(eq(users.id, targetUserId)).limit(1))[0]
  if (!targetUser || !targetUser.isActive) {
    return c.json({ error: 'User not found' }, 404)
  }

  try {
    await db.insert(agentMembers).values({
      agentId: id,
      userId: targetUserId,
      role,
      createdBy: currentUserId,
    })
  } catch (err: unknown) {
    if (isUniqueViolation(err)) {
      return c.json({ error: 'User is already a member' }, 409)
    }
    throw err
  }

  const inserted = (
    await db
      .select({
        userId: agentMembers.userId,
        role: agentMembers.role,
        createdAt: agentMembers.createdAt,
      })
      .from(agentMembers)
      .where(and(eq(agentMembers.agentId, id), eq(agentMembers.userId, targetUserId)))
      .limit(1)
  )[0]

  logAudit(c, {
    action: 'agent.member.add',
    resource: 'agent',
    resourceId: id,
    details: { targetUserId, role },
  })

  return c.json(
    {
      data: {
        userId: targetUser.id,
        username: targetUser.username,
        displayName: targetUser.displayName,
        email: targetUser.email,
        role: (inserted?.role ?? role) as 'editor' | 'viewer',
        isOwner: false,
        createdAt: inserted?.createdAt ?? new Date(),
      } satisfies MemberRow,
    },
    201,
  )
})

/** PATCH /:id/members/:userId — owner updates a member's role */
app.patch('/:id/members/:userId', async (c) => {
  const { id, userId: targetUserId } = c.req.param()
  const { agent } = await requireAgentOwner(c, id)

  if (targetUserId === agent.userId) {
    return c.json({ error: "Cannot modify owner's role" }, 400)
  }

  const body = await c.req.json().catch(() => null)
  const parsed = updateAgentMemberInput.safeParse(body)
  if (!parsed.success) {
    return c.json({ error: parsed.error.flatten() }, 400)
  }
  const { role } = parsed.data

  const existing = (
    await db
      .select()
      .from(agentMembers)
      .where(and(eq(agentMembers.agentId, id), eq(agentMembers.userId, targetUserId)))
      .limit(1)
  )[0]
  if (!existing) {
    return c.json({ error: 'Member not found' }, 404)
  }

  await db
    .update(agentMembers)
    .set({ role, updatedAt: new Date() })
    .where(and(eq(agentMembers.agentId, id), eq(agentMembers.userId, targetUserId)))

  const targetUser = (await db.select().from(users).where(eq(users.id, targetUserId)).limit(1))[0]
  const updated = (
    await db
      .select({ role: agentMembers.role, createdAt: agentMembers.createdAt })
      .from(agentMembers)
      .where(and(eq(agentMembers.agentId, id), eq(agentMembers.userId, targetUserId)))
      .limit(1)
  )[0]

  logAudit(c, {
    action: 'agent.member.update',
    resource: 'agent',
    resourceId: id,
    details: { targetUserId, role },
  })

  return c.json({
    data: {
      userId: targetUserId,
      username: targetUser?.username ?? '',
      displayName: targetUser?.displayName ?? null,
      email: targetUser?.email ?? null,
      role: (updated?.role ?? role) as 'editor' | 'viewer',
      isOwner: false,
      createdAt: updated?.createdAt ?? new Date(),
    } satisfies MemberRow,
  })
})

/** DELETE /:id/members/:userId — owner removes a member */
app.delete('/:id/members/:userId', async (c) => {
  const { id, userId: targetUserId } = c.req.param()
  const { agent } = await requireAgentOwner(c, id)

  if (targetUserId === agent.userId) {
    return c.json({ error: 'Cannot remove the owner' }, 400)
  }

  const existing = (
    await db
      .select()
      .from(agentMembers)
      .where(and(eq(agentMembers.agentId, id), eq(agentMembers.userId, targetUserId)))
      .limit(1)
  )[0]
  if (!existing) {
    return c.json({ error: 'Member not found' }, 404)
  }

  await db
    .delete(agentMembers)
    .where(and(eq(agentMembers.agentId, id), eq(agentMembers.userId, targetUserId)))

  logAudit(c, {
    action: 'agent.member.remove',
    resource: 'agent',
    resourceId: id,
    details: { targetUserId },
  })

  return c.json({ data: { removed: true, userId: targetUserId } })
})

export default app
