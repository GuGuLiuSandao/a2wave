/**
 * Covers startServer + the individual tool handlers that are not exposed at
 * module level. We feed mock SDK constructors so we can capture every
 * server.tool(name, desc, schema, handler) registration, then directly invoke
 * those handlers with mocked fetch responses.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

type ToolHandler = (...args: unknown[]) => unknown
type ToolDef = { name: string; description: string; schema: unknown; handler: ToolHandler }

const recordedTools: ToolDef[] = []
let connectedTransport: unknown = null
const savedInternalAdminToken = process.env.A2WAVE_INTERNAL_ADMIN_TOKEN

const { McpServerCtorMock, StdioTransportCtorMock } = vi.hoisted(() => ({
  McpServerCtorMock: vi.fn(),
  StdioTransportCtorMock: vi.fn(),
}))

vi.mock('@modelcontextprotocol/sdk/server/mcp.js', () => ({
  McpServer: McpServerCtorMock,
}))
vi.mock('@modelcontextprotocol/sdk/server/stdio.js', () => ({
  StdioServerTransport: StdioTransportCtorMock,
}))

const fetchMock = vi.fn()

function mockJsonResponse(body: unknown, status = 200) {
  return {
    ok: status < 400,
    status,
    statusText: status === 200 ? 'OK' : 'Error',
    json: vi.fn().mockResolvedValue(body),
    text: vi.fn().mockResolvedValue(''),
  }
}

beforeEach(async () => {
  recordedTools.length = 0
  connectedTransport = null
  fetchMock.mockReset()
  vi.stubGlobal('fetch', fetchMock)
  vi.resetModules()
  process.env.A2WAVE_INTERNAL_ADMIN_TOKEN = 'platform-admin-server-test-token'

  McpServerCtorMock.mockReset().mockImplementation(function (this: unknown) {
    return {
      tool: vi.fn((name: string, description: string, schema: unknown, handler: ToolHandler) => {
        recordedTools.push({ name, description, schema, handler })
      }),
      connect: vi.fn(async (t: unknown) => {
        connectedTransport = t
      }),
    }
  })
  StdioTransportCtorMock.mockReset().mockImplementation(function (this: unknown) {
    return { __transportStub: true }
  })
})

afterEach(() => {
  vi.unstubAllGlobals()
  if (savedInternalAdminToken === undefined) {
    Reflect.deleteProperty(process.env, 'A2WAVE_INTERNAL_ADMIN_TOKEN')
  } else {
    process.env.A2WAVE_INTERNAL_ADMIN_TOKEN = savedInternalAdminToken
  }
})

function parseText(result: unknown) {
  const r = result as { content: Array<{ text: string }> }
  return JSON.parse(r.content[0]!.text)
}

describe('startServer', () => {
  it('registers every documented platform admin tool and connects via stdio', async () => {
    const mod = await import('../a2wave-platform-admin.js')
    await mod.startServer()

    expect(McpServerCtorMock).toHaveBeenCalledWith({
      name: 'a2wave-platform-admin',
      version: '1.0.0',
    })
    expect(connectedTransport).toMatchObject({ __transportStub: true })

    const names = recordedTools.map((t) => t.name).sort()
    expect(names).toEqual(
      [
        'get_agent',
        'get_mcp_server',
        'get_platform_overview',
        'get_provider',
        'get_run_detail',
        'get_run_stats',
        'get_settings',
        'get_skill',
        'list_agents',
        'list_audit_logs',
        'list_mcp_servers',
        'list_providers',
        'list_runs',
        'list_skills',
        'list_users',
      ].sort(),
    )
  })

  it('list_agents handler builds the URL with page/pageSize', async () => {
    const mod = await import('../a2wave-platform-admin.js')
    await mod.startServer()

    const tool = recordedTools.find((t) => t.name === 'list_agents')!
    fetchMock.mockResolvedValueOnce(mockJsonResponse({ data: [], pagination: { total: 0 } }))
    const result = await tool.handler({ page: 3, pageSize: 25 })
    expect(parseText(result)).toEqual({ data: [], pagination: { total: 0 } })
    const url = fetchMock.mock.calls[0]![0] as string
    expect(url).toContain('page=3')
    expect(url).toContain('pageSize=25')
    expect(fetchMock.mock.calls[0]?.[1]).toMatchObject({
      headers: { 'x-a2wave-internal-admin-token': 'platform-admin-server-test-token' },
    })
  })

  it('get_agent handler hits /agents/:id', async () => {
    const mod = await import('../a2wave-platform-admin.js')
    await mod.startServer()
    const tool = recordedTools.find((t) => t.name === 'get_agent')!
    fetchMock.mockResolvedValueOnce(mockJsonResponse({ data: { id: 'agt_1' } }))
    await tool.handler({ agentId: 'agt_1' })
    expect(fetchMock.mock.calls[0]![0]).toContain('/agents/agt_1')
  })

  it('list_runs supports agentId filtering and pagination params', async () => {
    const mod = await import('../a2wave-platform-admin.js')
    await mod.startServer()
    const tool = recordedTools.find((t) => t.name === 'list_runs')!
    fetchMock.mockResolvedValueOnce(mockJsonResponse({ data: [] }))
    await tool.handler({ page: 1, pageSize: 5, agentId: 'agt_1' })
    const url = fetchMock.mock.calls[0]![0] as string
    expect(url).toContain('agentId=agt_1')
    expect(url).toContain('pageSize=5')
  })

  it('get_run_detail / get_mcp_server / get_skill / get_provider hit their detail endpoints', async () => {
    const mod = await import('../a2wave-platform-admin.js')
    await mod.startServer()

    const cases = [
      { name: 'get_run_detail', arg: { runId: 'run_1' }, contains: '/runs/run_1' },
      { name: 'get_mcp_server', arg: { mcpServerId: 'mcp_1' }, contains: '/mcp-servers/mcp_1' },
      { name: 'get_skill', arg: { skillId: 'skl_1' }, contains: '/skills/skl_1' },
      { name: 'get_provider', arg: { providerId: 'prv_1' }, contains: '/providers/prv_1' },
    ]

    for (const { name, arg, contains } of cases) {
      fetchMock.mockResolvedValueOnce(mockJsonResponse({}))
      const tool = recordedTools.find((t) => t.name === name)!
      await tool.handler(arg)
      const url = fetchMock.mock.calls.at(-1)![0] as string
      expect(url).toContain(contains)
    }
  })

  it('list_audit_logs builds the query string', async () => {
    const mod = await import('../a2wave-platform-admin.js')
    await mod.startServer()
    const tool = recordedTools.find((t) => t.name === 'list_audit_logs')!
    fetchMock.mockResolvedValueOnce(mockJsonResponse({ data: [] }))
    await tool.handler({ page: 2, pageSize: 8 })
    const url = fetchMock.mock.calls[0]![0] as string
    expect(url).toMatch(/audit-logs\?.*page=2.*pageSize=8/)
  })

  it('parameterless tools hit their endpoints without a query string', async () => {
    const mod = await import('../a2wave-platform-admin.js')
    await mod.startServer()

    const cases = [
      { name: 'list_mcp_servers', endpoint: '/mcp-servers' },
      { name: 'list_skills', endpoint: '/skills' },
      { name: 'list_providers', endpoint: '/providers' },
      { name: 'get_settings', endpoint: '/settings' },
      { name: 'list_users', endpoint: '/users' },
      { name: 'get_run_stats', endpoint: '/runs/stats' },
    ]

    for (const { name, endpoint } of cases) {
      fetchMock.mockResolvedValueOnce(mockJsonResponse({}))
      const tool = recordedTools.find((t) => t.name === name)!
      await tool.handler({})
      const url = fetchMock.mock.calls.at(-1)![0] as string
      expect(url).toMatch(new RegExp(`${endpoint}$`))
    }
  })

  it('get_platform_overview composes counts in parallel', async () => {
    const mod = await import('../a2wave-platform-admin.js')
    await mod.startServer()
    const tool = recordedTools.find((t) => t.name === 'get_platform_overview')!

    fetchMock
      .mockResolvedValueOnce(mockJsonResponse({ pagination: { total: 5 } }))
      .mockResolvedValueOnce(mockJsonResponse({ total: 50 }))
      .mockResolvedValueOnce(mockJsonResponse({ data: [{}, {}] }))
      .mockResolvedValueOnce(mockJsonResponse({ data: [{}] }))
      .mockResolvedValueOnce(mockJsonResponse({ data: [] }))
      .mockResolvedValueOnce(mockJsonResponse({ data: [{}, {}, {}] }))

    const result = await tool.handler({})
    expect(parseText(result)).toEqual({
      agents: { total: 5 },
      runs: { total: 50 },
      mcpServers: { total: 2 },
      skills: { total: 1 },
      providers: { total: 0 },
      users: { total: 3 },
    })
  })
})
