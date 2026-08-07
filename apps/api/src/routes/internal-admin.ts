import { count, desc, eq, gte, sql } from 'drizzle-orm'
import { Hono } from 'hono'
import { db } from '../db/client.js'
import {
  agents,
  auditLogs,
  mcpServers,
  providers,
  runSteps,
  runs,
  skillGroups,
  skills,
  users,
} from '../db/schema.js'
import {
  redactSettingsForInternalAdmin,
  toInternalAdminProviderDto,
} from '../lib/internal-admin-redaction.js'
import { jsonExtractNumber } from '../lib/json-sql.js'
import { redactMcpServerSecrets } from '../lib/mcp-redaction.js'
import { getAllSettings } from '../lib/settings.js'
import { maskAgentSecrets } from './agents.js'

const app = new Hono()

// ============================================================
// Agents
// ============================================================

app.get('/agents', async (c) => {
  const { page = '1', pageSize = '50' } = c.req.query()
  const pageNum = Math.max(1, Number.parseInt(page) || 1)
  const limit = Math.min(200, Math.max(1, Number.parseInt(pageSize) || 50))
  const offset = (pageNum - 1) * limit

  const totalResult = (await db.select({ count: count() }).from(agents).limit(1))[0]
  const data = await db
    .select()
    .from(agents)
    .orderBy(desc(agents.createdAt))
    .limit(limit)
    .offset(offset)
  const total = totalResult?.count ?? 0

  return c.json({
    data: data.map((a) => maskAgentSecrets(a)),
    pagination: { total, page: pageNum, pageSize: limit, totalPages: Math.ceil(total / limit) },
  })
})

app.get('/agents/:id', async (c) => {
  const { id } = c.req.param()
  const agent = (await db.select().from(agents).where(eq(agents.id, id)).limit(1))[0]
  if (!agent) return c.json({ error: 'Agent not found' }, 404)
  return c.json({ data: maskAgentSecrets(agent) })
})

// ============================================================
// Runs
// ============================================================

app.get('/runs', async (c) => {
  const { page = '1', pageSize = '50', agentId } = c.req.query()
  const pageNum = Math.max(1, Number.parseInt(page) || 1)
  const limit = Math.min(200, Math.max(1, Number.parseInt(pageSize) || 50))
  const offset = (pageNum - 1) * limit

  const conditions = agentId ? eq(runs.initiatorAgentId, agentId) : undefined
  const totalResult = (await db.select({ count: count() }).from(runs).where(conditions).limit(1))[0]
  const data = await db
    .select({
      id: runs.id,
      intent: runs.intent,
      status: runs.status,
      result: runs.result,
      initiatorAgentId: runs.initiatorAgentId,
      triggerSource: runs.triggerSource,
      createdAt: runs.createdAt,
      updatedAt: runs.updatedAt,
      agentName: agents.name,
    })
    .from(runs)
    .leftJoin(agents, eq(runs.initiatorAgentId, agents.id))
    .where(conditions)
    .orderBy(desc(runs.createdAt))
    .limit(limit)
    .offset(offset)
  const total = totalResult?.count ?? 0

  return c.json({
    data,
    pagination: { total, page: pageNum, pageSize: limit, totalPages: Math.ceil(total / limit) },
  })
})

app.get('/runs/stats', async (c) => {
  const today = new Date()
  today.setHours(0, 0, 0, 0)

  const statusRows = await db
    .select({ status: runs.status, cnt: count() })
    .from(runs)
    .groupBy(runs.status)

  const byStatus: Record<string, number> = {}
  let total = 0
  for (const row of statusRows) {
    byStatus[row.status] = row.cnt
    total += row.cnt
  }

  const todayResult = (
    await db.select({ cnt: count() }).from(runs).where(gte(runs.createdAt, today)).limit(1)
  )[0]

  const durationResult = (
    await db
      .select({ avg: sql<number | null>`AVG(${jsonExtractNumber(runs.result, ['durationMs'])})` })
      .from(runs)
      .where(eq(runs.status, 'completed'))
      .limit(1)
  )[0]

  return c.json({
    total,
    todayRuns: todayResult?.cnt ?? 0,
    avgDuration: durationResult?.avg != null ? Math.round(durationResult.avg) : 0,
    successRate: total > 0 ? Math.round(((byStatus.completed ?? 0) / total) * 100) : 0,
    byStatus,
  })
})

app.get('/runs/:id', async (c) => {
  const { id } = c.req.param()
  const run = (await db.select().from(runs).where(eq(runs.id, id)).limit(1))[0]
  if (!run) return c.json({ error: 'Run not found' }, 404)

  const steps = await db.select().from(runSteps).where(eq(runSteps.runId, id))
  const { executionMetadata: _executionMetadata, ...publicRun } = run
  return c.json({ data: { ...publicRun, steps } })
})

// ============================================================
// MCP Servers
// ============================================================

app.get('/mcp-servers', async (c) => {
  const data = await db.select().from(mcpServers).orderBy(desc(mcpServers.createdAt))
  return c.json({ data: data.map((server) => redactMcpServerSecrets(server)) })
})

app.get('/mcp-servers/:id', async (c) => {
  const { id } = c.req.param()
  const server = (await db.select().from(mcpServers).where(eq(mcpServers.id, id)).limit(1))[0]
  if (!server) return c.json({ error: 'MCP Server not found' }, 404)
  return c.json({ data: redactMcpServerSecrets(server) })
})

// ============================================================
// Skills
// ============================================================

app.get('/skills', async (c) => {
  const data = await db.select().from(skills).orderBy(desc(skills.createdAt))
  return c.json({ data })
})

app.get('/skills/:id', async (c) => {
  const { id } = c.req.param()
  const skill = (await db.select().from(skills).where(eq(skills.id, id)).limit(1))[0]
  if (!skill) return c.json({ error: 'Skill not found' }, 404)
  return c.json({ data: skill })
})

// ============================================================
// Skill Groups
// ============================================================

app.get('/skill-groups', async (c) => {
  const data = await db.select().from(skillGroups).orderBy(desc(skillGroups.createdAt))
  return c.json({ data })
})

app.get('/skill-groups/:id', async (c) => {
  const { id } = c.req.param()
  const row = (await db.select().from(skillGroups).where(eq(skillGroups.id, id)).limit(1))[0]
  if (!row) return c.json({ error: 'Skill group not found' }, 404)
  return c.json({ data: row })
})

// ============================================================
// Providers
// ============================================================

app.get('/providers', async (c) => {
  const data = await db.select().from(providers).orderBy(desc(providers.createdAt))
  return c.json({ data: data.map((provider) => toInternalAdminProviderDto(provider)) })
})

app.get('/providers/:id', async (c) => {
  const { id } = c.req.param()
  const provider = (await db.select().from(providers).where(eq(providers.id, id)).limit(1))[0]
  if (!provider) return c.json({ error: 'Provider not found' }, 404)
  return c.json({ data: toInternalAdminProviderDto(provider) })
})

// ============================================================
// Settings
// ============================================================

app.get('/settings', async (c) => {
  const data = redactSettingsForInternalAdmin(getAllSettings())
  return c.json({ data })
})

// ============================================================
// Users
// ============================================================

app.get('/users', async (c) => {
  const data = await db
    .select({
      id: users.id,
      username: users.username,
      displayName: users.displayName,
      role: users.role,
      isActive: users.isActive,
      createdAt: users.createdAt,
    })
    .from(users)
    .orderBy(desc(users.createdAt))
  return c.json({ data })
})

// ============================================================
// Audit Logs
// ============================================================

app.get('/audit-logs', async (c) => {
  const { page = '1', pageSize = '50' } = c.req.query()
  const pageNum = Math.max(1, Number.parseInt(page) || 1)
  const limit = Math.min(200, Math.max(1, Number.parseInt(pageSize) || 50))
  const offset = (pageNum - 1) * limit

  const totalResult = (await db.select({ count: count() }).from(auditLogs).limit(1))[0]
  const data = await db
    .select()
    .from(auditLogs)
    .orderBy(desc(auditLogs.createdAt))
    .limit(limit)
    .offset(offset)
  const total = totalResult?.count ?? 0

  return c.json({
    data,
    pagination: { total, page: pageNum, pageSize: limit, totalPages: Math.ceil(total / limit) },
  })
})

export default app
