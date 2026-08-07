import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { z } from 'zod'

const apiUrl = process.env.A2WAVE_API_URL ?? 'http://127.0.0.1:3502'
const BASE = '/api/internal/admin'
const internalAdminToken = process.env.A2WAVE_INTERNAL_ADMIN_TOKEN

// biome-ignore lint/suspicious/noExplicitAny: dynamic JSON responses
async function fetchJson(path: string): Promise<any> {
  if (!internalAdminToken) {
    throw new Error('A2WAVE_INTERNAL_ADMIN_TOKEN is required')
  }
  const res = await fetch(`${apiUrl}${BASE}${path}`, {
    headers: { 'x-a2wave-internal-admin-token': internalAdminToken },
  })
  if (!res.ok) {
    const body = await res.text().catch(() => '')
    throw new Error(`HTTP ${res.status}: ${body}`)
  }
  return res.json()
}

function textResult(data: unknown) {
  return { content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }] }
}

// ============================================================
// Tool handlers
// ============================================================

export async function listAgents(args: { page?: number; pageSize?: number }) {
  const params = new URLSearchParams()
  if (args.page) params.set('page', String(args.page))
  if (args.pageSize) params.set('pageSize', String(args.pageSize))
  const qs = params.toString()
  const result = await fetchJson(`/agents${qs ? `?${qs}` : ''}`)
  return textResult(result)
}

async function getAgent(args: { agentId: string }) {
  const result = await fetchJson(`/agents/${args.agentId}`)
  return textResult(result)
}

async function listRuns(args: { page?: number; pageSize?: number; agentId?: string }) {
  const params = new URLSearchParams()
  if (args.page) params.set('page', String(args.page))
  if (args.pageSize) params.set('pageSize', String(args.pageSize))
  if (args.agentId) params.set('agentId', args.agentId)
  const qs = params.toString()
  const result = await fetchJson(`/runs${qs ? `?${qs}` : ''}`)
  return textResult(result)
}

async function getRunDetail(args: { runId: string }) {
  const result = await fetchJson(`/runs/${args.runId}`)
  return textResult(result)
}

export async function getRunStats() {
  const result = await fetchJson('/runs/stats')
  return textResult(result)
}

async function listMcpServers() {
  const result = await fetchJson('/mcp-servers')
  return textResult(result)
}

async function getMcpServer(args: { mcpServerId: string }) {
  const result = await fetchJson(`/mcp-servers/${args.mcpServerId}`)
  return textResult(result)
}

async function listSkills() {
  const result = await fetchJson('/skills')
  return textResult(result)
}

async function getSkill(args: { skillId: string }) {
  const result = await fetchJson(`/skills/${args.skillId}`)
  return textResult(result)
}

async function listProviders() {
  const result = await fetchJson('/providers')
  return textResult(result)
}

async function getProvider(args: { providerId: string }) {
  const result = await fetchJson(`/providers/${args.providerId}`)
  return textResult(result)
}

async function getSettings() {
  const result = await fetchJson('/settings')
  return textResult(result)
}

async function listUsers() {
  const result = await fetchJson('/users')
  return textResult(result)
}

async function listAuditLogs(args: { page?: number; pageSize?: number }) {
  const params = new URLSearchParams()
  if (args.page) params.set('page', String(args.page))
  if (args.pageSize) params.set('pageSize', String(args.pageSize))
  const qs = params.toString()
  const result = await fetchJson(`/audit-logs${qs ? `?${qs}` : ''}`)
  return textResult(result)
}

export async function getPlatformOverview() {
  const [agentsResult, runsStats, mcpResult, skillsResult, providersResult, usersResult] =
    await Promise.all([
      fetchJson('/agents?pageSize=1'),
      fetchJson('/runs/stats'),
      fetchJson('/mcp-servers'),
      fetchJson('/skills'),
      fetchJson('/providers'),
      fetchJson('/users'),
    ])

  const overview = {
    agents: { total: agentsResult.pagination?.total ?? 0 },
    runs: runsStats,
    mcpServers: { total: mcpResult.data?.length ?? 0 },
    skills: { total: skillsResult.data?.length ?? 0 },
    providers: { total: providersResult.data?.length ?? 0 },
    users: { total: usersResult.data?.length ?? 0 },
  }
  return textResult(overview)
}

// ============================================================
// Server startup
// ============================================================

export async function startServer(): Promise<void> {
  const { McpServer } = await import('@modelcontextprotocol/sdk/server/mcp.js')
  const { StdioServerTransport } = await import('@modelcontextprotocol/sdk/server/stdio.js')

  const server = new McpServer({
    name: 'a2wave-platform-admin',
    version: '1.0.0',
  })

  // --- Platform Overview ---
  server.tool(
    'get_platform_overview',
    'Get an overview of the a2wave platform: agent count, run statistics, and the number of MCP servers, skills, providers and users. The entry point for an administrator to quickly assess platform state.',
    {},
    () => getPlatformOverview(),
  )

  // --- Agents ---
  server.tool(
    'list_agents',
    "List all agents, with pagination. Returns each agent's ID, name, description, status and publish status.",
    {
      page: z.number().optional().describe('Page number, defaults to 1'),
      pageSize: z.number().optional().describe('Items per page, defaults to 50'),
    },
    ({ page, pageSize }) => listAgents({ page, pageSize }),
  )

  server.tool(
    'get_agent',
    'Get the full configuration of a specific agent, including its system prompt, skills, MCP configuration and publish settings.',
    {
      agentId: z.string().describe('Agent ID, in the form agt_xxx'),
    },
    ({ agentId }) => getAgent({ agentId }),
  )

  // --- Runs ---
  server.tool(
    'list_runs',
    'List run records, filterable by agent and paginated. Returns run status, trigger source and the associated agent.',
    {
      page: z.number().optional().describe('Page number, defaults to 1'),
      pageSize: z.number().optional().describe('Items per page, defaults to 50'),
      agentId: z.string().optional().describe('Filter by agent ID'),
    },
    ({ page, pageSize, agentId }) => listRuns({ page, pageSize, agentId }),
  )

  server.tool(
    'get_run_detail',
    'Get the details of a run, including its execution steps, input, output and duration.',
    {
      runId: z.string().describe('Run ID, in the form run_xxx'),
    },
    ({ runId }) => getRunDetail({ runId }),
  )

  server.tool(
    'get_run_stats',
    'Get a run statistics overview: total runs, runs today, success rate, average duration and the distribution across statuses.',
    {},
    () => getRunStats(),
  )

  // --- MCP Servers ---
  server.tool(
    'list_mcp_servers',
    'List all MCP Server configurations, including transport type, enabled state and command or URL.',
    {},
    () => listMcpServers(),
  )

  server.tool(
    'get_mcp_server',
    'Get the full configuration of a specific MCP Server.',
    {
      mcpServerId: z.string().describe('MCP Server ID, in the form mcp_xxx'),
    },
    ({ mcpServerId }) => getMcpServer({ mcpServerId }),
  )

  // --- Skills ---
  server.tool(
    'list_skills',
    'List all skills, including name, description and file information.',
    {},
    () => listSkills(),
  )

  server.tool(
    'get_skill',
    'Get the full details of a specific skill, including its instruction content and file list.',
    {
      skillId: z.string().describe('Skill ID, in the form skl_xxx'),
    },
    ({ skillId }) => getSkill({ skillId }),
  )

  // --- Providers ---
  server.tool(
    'list_providers',
    'List all providers, including name, available models and system requirements.',
    {},
    () => listProviders(),
  )

  server.tool(
    'get_provider',
    'Get the full configuration of a specific provider.',
    {
      providerId: z.string().describe('Provider ID, in the form prv_xxx'),
    },
    ({ providerId }) => getProvider({ providerId }),
  )

  // --- Settings ---
  server.tool(
    'get_settings',
    'Get the platform-wide settings, including working directory, timeouts, artifact configuration and alert webhooks.',
    {},
    () => getSettings(),
  )

  // --- Users ---
  server.tool(
    'list_users',
    'List all users, including username, role and enabled state (passwords are never returned).',
    {},
    () => listUsers(),
  )

  // --- Audit Logs ---
  server.tool(
    'list_audit_logs',
    'List audit logs, the history of every write operation. Supports pagination.',
    {
      page: z.number().optional().describe('Page number, defaults to 1'),
      pageSize: z.number().optional().describe('Items per page, defaults to 50'),
    },
    ({ page, pageSize }) => listAuditLogs({ page, pageSize }),
  )

  const transport = new StdioServerTransport()
  await server.connect(transport)
}

const currentFile =
  typeof __filename !== 'undefined'
    ? __filename
    : import.meta.url
      ? fileURLToPath(import.meta.url)
      : undefined
const isDirectExecution =
  currentFile && process.argv[1] && resolve(process.argv[1]) === resolve(currentFile)

if (isDirectExecution) {
  startServer().catch((err) => {
    console.error('[platform-admin] Failed to start:', err)
    process.exit(1)
  })
}
