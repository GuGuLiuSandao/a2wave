import { createSkillGroupInput, updateSkillGroupInput } from '@a2wave/shared'
import { and, count, desc, eq, inArray } from 'drizzle-orm'
import { Hono } from 'hono'
import { db } from '../db/client.js'
import { agents, skillGroups, skills } from '../db/schema.js'
import { withTransaction } from '../db/transaction.js'
import { logAudit } from '../lib/audit.js'
import { createId } from '../lib/id.js'
import { getCurrentUserId, getOwnerFilter } from '../lib/owner-filter.js'
import { canNonAdminUseSkill } from '../lib/skill-access.js'

const app = new Hono()

/** 只保留调用方可见的 Skill ID，防止挂僵尸/越权 */
async function filterVisibleSkillIds(
  c: Parameters<typeof getOwnerFilter>[0],
  rawIds: string[] | undefined,
): Promise<string[]> {
  const ids = Array.from(new Set(rawIds ?? []))
  if (ids.length === 0) return []
  const ownerFilter = getOwnerFilter(c, skills.userId)
  const conditions = ownerFilter
    ? and(inArray(skills.id, ids), ownerFilter)
    : inArray(skills.id, ids)
  const rows = await db.select({ id: skills.id }).from(skills).where(conditions)
  const valid = new Set(rows.map((r) => r.id))
  return ids.filter((id) => valid.has(id))
}

/**
 * Surface whether each group owner can resolve every member at runtime. This
 * query intentionally sees hidden members but exposes only the aggregate flag,
 * allowing the Agent picker to fail closed without leaking private Skill data.
 */
async function addOwnerBindingSafety(rows: Array<typeof skillGroups.$inferSelect>) {
  if (rows.length === 0) return []
  const ownerByGroupId = new Map(rows.map((row) => [row.id, row.userId]))
  const memberRows = await db
    .select({
      groupId: skills.groupId,
      userId: skills.userId,
      visibility: skills.visibility,
    })
    .from(skills)
    .where(
      inArray(
        skills.groupId,
        rows.map((row) => row.id),
      ),
    )
  const unsafeGroupIds = new Set<string>()
  for (const member of memberRows) {
    if (!member.groupId) continue
    const ownerId = ownerByGroupId.get(member.groupId)
    if (!canNonAdminUseSkill(member, ownerId)) unsafeGroupIds.add(member.groupId)
  }
  return rows.map((row) => ({
    ...row,
    ownerCanBindAllSkills: !unsafeGroupIds.has(row.id),
  }))
}

/** GET / - 列出所有 Skill Groups */
app.get('/', async (c) => {
  const { page = '1', pageSize = '50' } = c.req.query()
  const pageNum = Math.max(1, Number.parseInt(page) || 1)
  const limit = Math.min(500, Math.max(1, Number.parseInt(pageSize) || 50))
  const offset = (pageNum - 1) * limit

  const ownerFilter = getOwnerFilter(c, skillGroups.userId)
  const totalResult = (
    await db.select({ count: count() }).from(skillGroups).where(ownerFilter).limit(1)
  )[0]
  const rows = await db
    .select()
    .from(skillGroups)
    .where(ownerFilter)
    .orderBy(desc(skillGroups.createdAt))
    .limit(limit)
    .offset(offset)
  const data = await addOwnerBindingSafety(rows)
  const total = totalResult?.count ?? 0

  return c.json({
    data,
    pagination: { total, page: pageNum, pageSize: limit, totalPages: Math.ceil(total / limit) },
  })
})

/** GET /:id - 获取单个 Group */
app.get('/:id', async (c) => {
  const { id } = c.req.param()
  const ownerFilter = getOwnerFilter(c, skillGroups.userId)
  const conditions = ownerFilter ? and(eq(skillGroups.id, id), ownerFilter) : eq(skillGroups.id, id)
  const row = (await db.select().from(skillGroups).where(conditions).limit(1))[0]
  if (!row) {
    return c.json({ error: 'Skill group not found' }, 404)
  }
  return c.json({ data: row })
})

/** GET /:id/skills - 列出分组下的 Skill ID（便于前端 modal 初始化） */
app.get('/:id/skills', async (c) => {
  const { id } = c.req.param()
  const ownerFilter = getOwnerFilter(c, skillGroups.userId)
  const conditions = ownerFilter ? and(eq(skillGroups.id, id), ownerFilter) : eq(skillGroups.id, id)
  const existing = (await db.select().from(skillGroups).where(conditions).limit(1))[0]
  if (!existing) {
    return c.json({ error: 'Skill group not found' }, 404)
  }
  const skillOwnerFilter = getOwnerFilter(c, skills.userId)
  const skillConditions = skillOwnerFilter
    ? and(eq(skills.groupId, id), skillOwnerFilter)
    : eq(skills.groupId, id)
  const rows = await db.select({ id: skills.id }).from(skills).where(skillConditions)
  return c.json({ data: rows.map((r) => r.id) })
})

/** POST / - 创建 Group；若传 skillIds，把这些 Skill 归入本分组（会从旧分组迁出） */
app.post('/', async (c) => {
  const body = await c.req.json()
  const parsed = createSkillGroupInput.safeParse(body)
  if (!parsed.success) {
    return c.json({ error: parsed.error.flatten() }, 400)
  }

  const id = createId('skg')
  const userId = getCurrentUserId(c)
  const skillIds = await filterVisibleSkillIds(c, parsed.data.skillIds)

  const created = await withTransaction(async (tx) => {
    const row = (
      await tx
        .insert(skillGroups)
        .values({
          id,
          name: parsed.data.name,
          description: parsed.data.description ?? null,
          icon: parsed.data.icon ?? 'package',
          userId,
        })
        .returning()
    )[0]
    if ((await skillIds).length > 0) {
      await tx
        .update(skills)
        .set({ groupId: id, updatedAt: new Date() })
        .where(inArray(skills.id, skillIds))
    }
    return row
  })

  logAudit(c, { action: 'skill-group.create', resource: 'skill-group', resourceId: id })
  return c.json({ data: created }, 201)
})

/** PATCH /:id - 更新 Group；若传 skillIds，事务内把 Skill 成员关系同步到新的列表（会偷走/释放 Skill） */
app.patch('/:id', async (c) => {
  const { id } = c.req.param()
  const ownerFilter = getOwnerFilter(c, skillGroups.userId)
  const conditions = ownerFilter ? and(eq(skillGroups.id, id), ownerFilter) : eq(skillGroups.id, id)
  const existing = (await db.select().from(skillGroups).where(conditions).limit(1))[0]
  if (!existing) {
    return c.json({ error: 'Skill group not found' }, 404)
  }

  const body = await c.req.json()
  const parsed = updateSkillGroupInput.safeParse(body)
  if (!parsed.success) {
    return c.json({ error: parsed.error.flatten() }, 400)
  }

  const patch: Record<string, unknown> = { updatedAt: new Date() }
  if (parsed.data.name !== undefined) patch.name = parsed.data.name
  if (parsed.data.description !== undefined) patch.description = parsed.data.description
  if (parsed.data.icon !== undefined) patch.icon = parsed.data.icon

  const nextSkillIds =
    parsed.data.skillIds !== undefined ? await filterVisibleSkillIds(c, parsed.data.skillIds) : null
  const writableMemberFilter = getOwnerFilter(c, skills.userId)

  const updateResult = await withTransaction(async (tx) => {
    const row = (await tx.update(skillGroups).set(patch).where(conditions).returning())[0]
    if (!row) return { kind: 'not-found' as const }

    if (nextSkillIds !== null) {
      const currentMembers = await tx
        .select({ id: skills.id })
        .from(skills)
        .where(
          writableMemberFilter
            ? and(eq(skills.groupId, id), writableMemberFilter)
            : eq(skills.groupId, id),
        )
      const nextSet = new Set(nextSkillIds)
      const toRelease = currentMembers.map((m) => m.id).filter((sid) => !nextSet.has(sid))
      if (toRelease.length > 0) {
        await tx
          .update(skills)
          .set({ groupId: null, updatedAt: new Date() })
          .where(inArray(skills.id, toRelease))
      }
      if ((await nextSkillIds).length > 0) {
        await tx
          .update(skills)
          .set({ groupId: id, updatedAt: new Date() })
          .where(inArray(skills.id, nextSkillIds))
      }
    }
    return { kind: 'updated' as const, row }
  })

  if (updateResult.kind === 'not-found') {
    return c.json({ error: 'Skill group not found' }, 404)
  }

  logAudit(c, { action: 'skill-group.update', resource: 'skill-group', resourceId: id })
  return c.json({ data: updateResult.row })
})

/** DELETE /:id - 删除 Group；把成员 Skill 的 group_id 置空，并清理 agent 引用 */
app.delete('/:id', async (c) => {
  const { id } = c.req.param()
  const ownerFilter = getOwnerFilter(c, skillGroups.userId)
  const conditions = ownerFilter ? and(eq(skillGroups.id, id), ownerFilter) : eq(skillGroups.id, id)
  const existing = (await db.select().from(skillGroups).where(conditions).limit(1))[0]
  if (!existing) {
    return c.json({ error: 'Skill group not found' }, 404)
  }

  const writableMemberFilter = getOwnerFilter(c, skills.userId)
  const callerId = getCurrentUserId(c)
  const deleteResult = await withTransaction(async (tx) => {
    // BEGIN IMMEDIATE serializes the member check with the release below. A
    // second API process cannot attach a foreign Skill after this snapshot and
    // have it released by the regular user's DELETE.
    if (writableMemberFilter) {
      const hasAdminManagedMember = await (
        await tx
          .select({ id: skills.id, userId: skills.userId })
          .from(skills)
          .where(eq(skills.groupId, id))
      ).some((skill) => skill.userId !== callerId)
      if (hasAdminManagedMember) return 'foreign-member' as const
    }

    // 先手动释放成员 Skill（FK ON DELETE SET NULL 在未启用 PRAGMA foreign_keys 时不触发）
    await tx
      .update(skills)
      .set({ groupId: null, updatedAt: new Date() })
      .where(eq(skills.groupId, id))
    await tx.delete(skillGroups).where(eq(skillGroups.id, id))
    // 清理所有 agent 上对该分组的引用
    const allAgents = await tx
      .select({ id: agents.id, skillGroupIds: agents.skillGroupIds })
      .from(agents)
    for (const a of allAgents) {
      const ids = (a.skillGroupIds as string[] | null) ?? []
      if (!ids.includes(id)) continue
      await tx
        .update(agents)
        .set({ skillGroupIds: ids.filter((x) => x !== id), updatedAt: new Date() })
        .where(eq(agents.id, a.id))
    }
    return 'deleted' as const
  })

  if (deleteResult === 'foreign-member') {
    return c.json(
      {
        error:
          'Skill group contains Skills managed by an administrator; move them before deleting the group',
      },
      409,
    )
  }

  logAudit(c, { action: 'skill-group.delete', resource: 'skill-group', resourceId: id })
  return c.json({ data: { id } })
})

export default app
