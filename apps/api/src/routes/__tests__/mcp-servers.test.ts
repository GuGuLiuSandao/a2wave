import { Hono } from 'hono'
import { type Mock, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../../db/client.js', () => ({
  db: {
    select: vi.fn(),
    insert: vi.fn(),
    update: vi.fn(),
    delete: vi.fn(),
  },
}))

vi.mock('../../lib/id.js', () => ({
  createId: vi.fn(() => 'mcp_test1'),
}))

vi.mock('@a2wave/shared', async () => {
  const actual = await vi.importActual<typeof import('@a2wave/shared')>('@a2wave/shared')
  return { ...actual }
})

vi.mock('../../lib/owner-filter.js', () => ({
  getOwnerFilter: vi.fn(() => undefined),
  getCurrentUserId: vi.fn(() => 'usr_admin'),
}))

vi.mock('../../lib/audit.js', () => ({
  logAudit: vi.fn(),
}))

const mockClose = vi.fn()
const mockConnect = vi.fn()
const mockListTools = vi.fn()
const mockSseTransport = vi.fn()
const mockHttpTransport = vi.fn()

vi.mock('@modelcontextprotocol/sdk/client/index.js', () => ({
  Client: class MockClient {
    connect = mockConnect
    listTools = mockListTools
    close = mockClose
  },
}))

vi.mock('@modelcontextprotocol/sdk/client/stdio.js', () => ({
  StdioClientTransport: class MockStdioClientTransport {},
}))

vi.mock('@modelcontextprotocol/sdk/client/sse.js', () => ({
  SSEClientTransport: class MockSSEClientTransport {
    constructor(...args: unknown[]) {
      mockSseTransport(...args)
    }
  },
}))

vi.mock('@modelcontextprotocol/sdk/client/streamableHttp.js', () => ({
  StreamableHTTPClientTransport: class MockStreamableHTTPClientTransport {
    constructor(...args: unknown[]) {
      mockHttpTransport(...args)
    }
  },
}))

function makeDbChain(result: unknown) {
  const leaf = {
    get: vi.fn().mockReturnValue(result),
    all: vi.fn().mockReturnValue(Array.isArray(result) ? result : result ? [result] : []),
  }
  return {
    from: vi.fn().mockReturnValue(
      asyncQuery({
        where: vi.fn().mockReturnValue(leaf),
        all: vi.fn().mockReturnValue(Array.isArray(result) ? result : result ? [result] : []),
      }),
    ),
  }
}

function makeInsertChain(result?: unknown) {
  return {
    values: vi.fn().mockReturnValue(
      asyncQuery({
        returning: vi.fn().mockReturnValue(
          asyncQuery({
            get: vi.fn().mockReturnValue(result ?? { id: 'mcp_test1', name: 'Test MCP' }),
          }),
        ),
        run: vi.fn(),
      }),
    ),
  }
}

function makeUpdateChain(result?: unknown) {
  return {
    set: vi.fn().mockReturnValue({
      where: vi.fn().mockReturnValue(
        asyncQuery({
          returning: vi.fn().mockReturnValue(
            asyncQuery({
              get: vi.fn().mockReturnValue(result ?? { id: 'mcp_test1', name: 'Updated MCP' }),
            }),
          ),
          run: vi.fn(),
        }),
      ),
    }),
  }
}

function makeDeleteChain(result?: unknown) {
  return {
    where: vi.fn().mockReturnValue({
      returning: vi.fn().mockReturnValue(
        asyncQuery({
          get: vi.fn().mockReturnValue(result ?? { id: 'mcp_test1' }),
        }),
      ),
    }),
  }
}

import { db } from '../../db/client.js'
import { getCurrentUserId } from '../../lib/owner-filter.js'

import { asyncQuery } from '../../test/async-query.js'

describe('MCP Servers routes', () => {
  let app: Hono

  beforeEach(async () => {
    vi.clearAllMocks()
    const mod = await import('../mcp-servers.js')
    app = new Hono()
    // Default to an admin identity so functional tests exercise the handler
    // logic; stdio-execution routes are admin-gated (see the dedicated
    // "stdio execution is admin-only" describe for the non-admin denials).
    app.use('*', async (c, next) => {
      c.set('userRole' as never, 'admin')
      c.set('userId' as never, 'usr_admin')
      await next()
    })
    app.route('/api/mcp-servers', mod.default)
  })

  describe('GET /', () => {
    it('returns all MCP servers', async () => {
      const servers = [{ id: 'mcp_1', name: 'Server1' }]
      ;(db.select as Mock)
        .mockReturnValueOnce({
          from: vi.fn().mockReturnValue({
            where: vi
              .fn()
              .mockReturnValue(
                asyncQuery({ get: vi.fn().mockReturnValue({ count: servers.length }) }),
              ),
          }),
        })
        .mockReturnValueOnce({
          from: vi.fn().mockReturnValue({
            where: vi.fn().mockReturnValue({
              orderBy: vi.fn().mockReturnValue({
                limit: vi.fn().mockReturnValue({
                  offset: vi
                    .fn()
                    .mockReturnValue(asyncQuery({ all: vi.fn().mockReturnValue(servers) })),
                }),
              }),
            }),
          }),
        })

      const res = await app.request('/api/mcp-servers')
      expect(res.status).toBe(200)
      const body = (await res.json()) as any
      expect(body.data).toEqual(servers)
    })
  })

  describe('GET /:id', () => {
    it('returns a server by id', async () => {
      const server = { id: 'mcp_1', name: 'Server1' }
      ;(db.select as Mock).mockReturnValue(makeDbChain(server))

      const res = await app.request('/api/mcp-servers/mcp_1')
      expect(res.status).toBe(200)
      const body = (await res.json()) as any
      expect(body.data).toEqual(server)
    })

    it('returns 404 for non-existent server', async () => {
      ;(db.select as Mock).mockReturnValue(makeDbChain(undefined))

      const res = await app.request('/api/mcp-servers/mcp_nonexistent')
      expect(res.status).toBe(404)
    })
  })

  describe('POST /', () => {
    it('creates a new MCP server', async () => {
      ;(db.insert as Mock).mockReturnValue(makeInsertChain())

      const res = await app.request('/api/mcp-servers', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'New Server', command: 'npx', args: ['@server/mcp'] }),
      })

      expect(res.status).toBe(201)
    })

    it('returns 400 for invalid input', async () => {
      const res = await app.request('/api/mcp-servers', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      })

      expect(res.status).toBe(400)
    })
  })

  describe('PATCH /:id', () => {
    it('updates an existing server', async () => {
      ;(db.select as Mock).mockReturnValue(makeDbChain({ id: 'mcp_1', name: 'Old' }))
      ;(db.update as Mock).mockReturnValue(makeUpdateChain())

      const res = await app.request('/api/mcp-servers/mcp_1', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'Updated' }),
      })

      expect(res.status).toBe(200)
    })

    it('rejects renaming a server to a reserved builtin name → 400, no update', async () => {
      // The reserved-name invariant must hold on PATCH too, not only POST: a user
      // must not be able to rename an owned row to shadow a builtin.
      ;(db.select as Mock).mockReturnValue(
        makeDbChain({ id: 'mcp_1', name: 'foo', type: 'sse', usageScope: 'private' }),
      )
      const res = await app.request('/api/mcp-servers/mcp_1', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'a2wave-agent-router' }),
      })
      expect(res.status).toBe(400)
      expect(db.update as Mock).not.toHaveBeenCalled()
    })

    it('returns 404 for non-existent server', async () => {
      ;(db.select as Mock).mockReturnValue(makeDbChain(undefined))

      const res = await app.request('/api/mcp-servers/mcp_none', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'Updated' }),
      })

      expect(res.status).toBe(404)
    })
  })

  describe('DELETE /:id', () => {
    it('deletes an existing server', async () => {
      ;(db.select as Mock)
        .mockReturnValueOnce(makeDbChain({ id: 'mcp_1' }))
        .mockReturnValueOnce(makeDbChain([]))
      ;(db.delete as Mock).mockReturnValue(makeDeleteChain())

      const res = await app.request('/api/mcp-servers/mcp_1', { method: 'DELETE' })
      expect(res.status).toBe(200)
    })

    it('returns 404 for non-existent server', async () => {
      ;(db.select as Mock).mockReturnValue(makeDbChain(undefined))

      const res = await app.request('/api/mcp-servers/mcp_none', { method: 'DELETE' })
      expect(res.status).toBe(404)
    })
  })

  describe('GET /:id/tools', () => {
    it('returns 404 for non-existent server', async () => {
      ;(db.select as Mock).mockReturnValue(makeDbChain(undefined))

      const res = await app.request('/api/mcp-servers/mcp_none/tools')
      expect(res.status).toBe(404)
    })

    it('returns 400 for stdio server without command', async () => {
      ;(db.select as Mock).mockReturnValue(
        makeDbChain({ id: 'mcp_1', type: 'stdio', command: null, url: null }),
      )

      const res = await app.request('/api/mcp-servers/mcp_1/tools')
      expect(res.status).toBe(400)
      const body = (await res.json()) as any
      expect(body.error).toContain('Command is required for stdio')
    })

    it('returns tools list for stdio server', async () => {
      ;(db.select as Mock).mockReturnValue(
        makeDbChain({
          id: 'mcp_1',
          type: 'stdio',
          command: 'npx',
          args: ['-y', 'mcp-server'],
          url: null,
        }),
      )
      mockConnect.mockResolvedValue(undefined)
      mockListTools.mockResolvedValue({
        tools: [
          { name: 'read_file', description: 'Read a file', inputSchema: { type: 'object' } },
          { name: 'write_file', description: 'Write a file', inputSchema: { type: 'object' } },
        ],
      })
      mockClose.mockResolvedValue(undefined)

      const res = await app.request('/api/mcp-servers/mcp_1/tools')
      expect(res.status).toBe(200)
      const body = (await res.json()) as any
      expect(body.data.tools).toHaveLength(2)
      expect(body.data.tools[0].name).toBe('read_file')
      expect(body.data.tools[1].name).toBe('write_file')
    })

    it('returns tools list for SSE server', async () => {
      ;(db.select as Mock).mockReturnValue(
        makeDbChain({ id: 'mcp_1', type: 'sse', url: 'https://example.com/sse', headers: {} }),
      )
      mockConnect.mockResolvedValue(undefined)
      mockListTools.mockResolvedValue({
        tools: [
          { name: 'read_file', description: 'Read a file', inputSchema: { type: 'object' } },
          { name: 'write_file', description: 'Write a file', inputSchema: { type: 'object' } },
        ],
      })
      mockClose.mockResolvedValue(undefined)

      const res = await app.request('/api/mcp-servers/mcp_1/tools')
      expect(res.status).toBe(200)
      const body = (await res.json()) as any
      expect(body.data.tools).toHaveLength(2)
      expect(body.data.tools[0].name).toBe('read_file')
      expect(body.data.tools[1].name).toBe('write_file')
      expect(mockHttpTransport.mock.calls.at(-1)?.[1]).toMatchObject({
        fetch: expect.any(Function),
      })
    })

    it('returns 502 when connection fails', async () => {
      ;(db.select as Mock).mockReturnValue(
        makeDbChain({ id: 'mcp_1', type: 'sse', url: 'https://example.com/sse', headers: {} }),
      )
      mockConnect.mockRejectedValue(new Error('Connection refused'))

      const res = await app.request('/api/mcp-servers/mcp_1/tools')
      expect(res.status).toBe(502)
      const body = (await res.json()) as any
      expect(body.error).toBe('Connection refused')
    })
  })

  describe('POST / - group type validation', () => {
    const validGroupConfig = {
      backends: {
        default: [
          {
            mode: 'inline',
            name: 'svc-a',
            type: 'stdio',
            command: 'npx',
            args: ['-y', 'server-a'],
          },
        ],
      },
    }

    it('creates a group type MCP server', async () => {
      ;(db.insert as Mock).mockReturnValue(
        makeInsertChain({
          id: 'mcp_test1',
          name: 'Group Server',
          type: 'group',
          groupConfig: validGroupConfig,
        }),
      )

      const res = await app.request('/api/mcp-servers', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: 'Group Server',
          type: 'group',
          groupConfig: validGroupConfig,
        }),
      })

      expect(res.status).toBe(201)
      const body = (await res.json()) as any
      expect(body.data.type).toBe('group')
    })

    it('returns 400 for group type without groupConfig', async () => {
      const res = await app.request('/api/mcp-servers', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'Group Server', type: 'group' }),
      })

      expect(res.status).toBe(400)
    })

    it('clears groupConfig for non-group types', async () => {
      ;(db.insert as Mock).mockReturnValue(
        makeInsertChain({
          id: 'mcp_test1',
          name: 'Stdio Server',
          type: 'stdio',
          groupConfig: null,
        }),
      )

      const res = await app.request('/api/mcp-servers', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: 'Stdio Server',
          type: 'stdio',
          command: 'npx',
          groupConfig: validGroupConfig,
        }),
      })

      expect(res.status).toBe(201)
    })
  })

  describe('PATCH /:id - group type validation', () => {
    const validGroupConfig = {
      backends: {
        default: [
          {
            mode: 'inline',
            name: 'svc-a',
            type: 'stdio',
            command: 'npx',
            args: ['-y', 'server-a'],
          },
        ],
      },
    }

    it('returns 400 when changing to group type without groupConfig', async () => {
      ;(db.select as Mock).mockReturnValue(
        makeDbChain({ id: 'mcp_1', name: 'Stdio Server', type: 'stdio', groupConfig: null }),
      )

      const res = await app.request('/api/mcp-servers/mcp_1', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ type: 'group' }),
      })

      expect(res.status).toBe(400)
    })

    it('allows updating existing group server', async () => {
      ;(db.select as Mock).mockReturnValue(
        makeDbChain({
          id: 'mcp_1',
          name: 'Group Server',
          type: 'group',
          groupConfig: validGroupConfig,
        }),
      )
      ;(db.update as Mock).mockReturnValue(
        makeUpdateChain({
          id: 'mcp_1',
          name: 'Renamed Group',
          type: 'group',
          groupConfig: validGroupConfig,
        }),
      )

      const res = await app.request('/api/mcp-servers/mcp_1', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'Renamed Group' }),
      })

      expect(res.status).toBe(200)
      const body = (await res.json()) as any
      expect(body.data.name).toBe('Renamed Group')
    })
  })

  describe('PATCH /:id - self-reference rejection', () => {
    it('returns 400 when group server references itself', async () => {
      const existingGroupConfig = {
        backends: {
          default: [
            {
              mode: 'inline',
              name: 'svc-a',
              type: 'stdio',
              command: 'npx',
              args: ['-y', 'server-a'],
            },
          ],
        },
      }
      ;(db.select as Mock).mockReturnValue(
        makeDbChain({
          id: 'mcp_1',
          name: 'Group Server',
          type: 'group',
          groupConfig: existingGroupConfig,
        }),
      )

      const res = await app.request('/api/mcp-servers/mcp_1', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          groupConfig: {
            backends: {
              default: [{ mode: 'ref', mcpServerId: 'mcp_1' }],
            },
          },
        }),
      })

      expect(res.status).toBe(400)
      const body = (await res.json()) as any
      expect(body.error).toContain('cannot reference itself')
    })
  })

  describe('POST /:id/clone - group warnings', () => {
    it('returns warnings for inaccessible refs in cloned group', async () => {
      const groupWithRef = {
        id: 'mcp_src',
        name: 'Group Server',
        type: 'group',
        groupConfig: {
          backends: {
            default: [{ mode: 'ref', mcpServerId: 'mcp_missing' }],
          },
        },
      }
      ;(db.select as Mock).mockReturnValue(makeDbChain(groupWithRef))
      ;(db.insert as Mock).mockReturnValue(
        makeInsertChain({ ...groupWithRef, id: 'mcp_test1', name: 'Group Server (Copy)' }),
      )
      // validateRefOwnership will find no accessible refs
      ;(db.select as Mock)
        .mockReturnValueOnce(makeDbChain(groupWithRef))
        // Second select call for ref validation: return empty accessible list
        .mockReturnValueOnce({
          from: vi.fn().mockReturnValue({
            where: vi.fn().mockReturnValue(
              asyncQuery({
                all: vi.fn().mockReturnValue([]),
              }),
            ),
          }),
        })

      const res = await app.request('/api/mcp-servers/mcp_src/clone', { method: 'POST' })
      expect(res.status).toBe(201)
      const body = (await res.json()) as any
      expect(body.warnings).toBeDefined()
      expect(body.warnings[0]).toContain('not accessible')
    })
  })

  describe('GET /:id/tools - group type', () => {
    it('returns static meta-tools for group type', async () => {
      ;(db.select as Mock).mockReturnValue(
        makeDbChain({
          id: 'mcp_1',
          type: 'group',
          groupConfig: {
            backends: {
              default: [
                {
                  mode: 'inline',
                  name: 'svc-a',
                  type: 'stdio',
                  command: 'npx',
                  args: ['-y', 'server-a'],
                },
              ],
            },
          },
        }),
      )

      const res = await app.request('/api/mcp-servers/mcp_1/tools')
      expect(res.status).toBe(200)
      const body = (await res.json()) as any
      expect(body.data.tools).toHaveLength(4)
      const toolNames = body.data.tools.map((t: { name: string }) => t.name)
      expect(toolNames).toContain('list_groups')
      expect(toolNames).toContain('list_tools')
      expect(toolNames).toContain('get_tool_schema')
      expect(toolNames).toContain('call_tool')
    })
  })

  describe('DELETE /:id - ref dependency check', () => {
    const groupWithRef = {
      id: 'mcp_group1',
      name: 'My Group',
      type: 'group',
      groupConfig: {
        backends: {
          default: [{ mode: 'ref', mcpServerId: 'mcp_1' }],
        },
      },
    }

    it('returns 409 when deleting server referenced by a group', async () => {
      ;(db.select as Mock)
        .mockReturnValueOnce(makeDbChain({ id: 'mcp_1', name: 'Target Server', type: 'stdio' }))
        .mockReturnValueOnce({
          from: vi.fn().mockReturnValue({
            where: vi.fn().mockReturnValue(
              asyncQuery({
                all: vi.fn().mockReturnValue([groupWithRef]),
              }),
            ),
          }),
        })

      const res = await app.request('/api/mcp-servers/mcp_1', { method: 'DELETE' })
      expect(res.status).toBe(409)
      const body = (await res.json()) as any
      expect(body.error).toContain('group MCP server(s)')
    })
  })

  describe('POST /probe-tools', () => {
    it('returns 400 for invalid type', async () => {
      const res = await app.request('/api/mcp-servers/probe-tools', {
        method: 'POST',
        body: JSON.stringify({ type: 'invalid' }),
        headers: { 'Content-Type': 'application/json' },
      })
      expect(res.status).toBe(400)
      const body = (await res.json()) as any
      expect(body.error).toBeDefined()
    })

    it('returns 400 for stdio without command', async () => {
      const res = await app.request('/api/mcp-servers/probe-tools', {
        method: 'POST',
        body: JSON.stringify({ type: 'stdio' }),
        headers: { 'Content-Type': 'application/json' },
      })
      expect(res.status).toBe(400)
      const body = (await res.json()) as any
      expect(body.error).toContain('command is required')
    })

    it('returns 400 for sse/http without url', async () => {
      const res = await app.request('/api/mcp-servers/probe-tools', {
        method: 'POST',
        body: JSON.stringify({ type: 'sse' }),
        headers: { 'Content-Type': 'application/json' },
      })
      expect(res.status).toBe(400)
      const body = (await res.json()) as any
      expect(body.error).toContain('url is required')
    })

    it('injects the DNS-pinning streaming-safe fetch into temporary HTTP probes', async () => {
      mockConnect.mockResolvedValue(undefined)
      mockListTools.mockResolvedValue({ tools: [] })
      mockClose.mockResolvedValue(undefined)

      const res = await app.request('/api/mcp-servers/probe-tools', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ type: 'http', url: 'https://mcp.example.com/mcp' }),
      })

      expect(res.status).toBe(200)
      expect(mockHttpTransport.mock.calls.at(-1)?.[1]).toMatchObject({
        fetch: expect.any(Function),
      })
    })

    it('rejects non-HTTP and private literal probe targets before connecting', async () => {
      for (const url of ['file:///etc/passwd', 'http://169.254.169.254/latest/meta-data/']) {
        const res = await app.request('/api/mcp-servers/probe-tools', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ type: 'http', url }),
        })
        expect(res.status).toBe(400)
      }
      expect(mockConnect).not.toHaveBeenCalled()
    })
  })

  describe('remote URL literal safety', () => {
    it('rejects a private top-level MCP URL on create before persistence', async () => {
      const res = await app.request('/api/mcp-servers', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: 'metadata',
          type: 'http',
          url: 'http://169.254.169.254/latest/meta-data/',
        }),
      })

      expect(res.status).toBe(400)
      expect(db.insert).not.toHaveBeenCalled()
    })

    it('rejects changing a saved MCP to a private literal URL', async () => {
      ;(db.select as Mock).mockReturnValue(
        makeDbChain({
          id: 'mcp_1',
          name: 'remote',
          type: 'http',
          url: 'https://mcp.example.com',
          usageScope: 'private',
          userId: 'usr_admin',
          groupConfig: null,
        }),
      )
      const res = await app.request('/api/mcp-servers/mcp_1', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url: 'http://127.0.0.1:8080/mcp' }),
      })

      expect(res.status).toBe(400)
      expect(db.update).not.toHaveBeenCalled()
    })

    it('allows unrelated edits on a legacy saved private target', async () => {
      ;(db.select as Mock).mockReturnValue(
        makeDbChain({
          id: 'mcp_legacy',
          name: 'legacy-private',
          type: 'http',
          url: 'http://10.0.0.8/mcp',
          usageScope: 'private',
          userId: 'usr_admin',
          groupConfig: null,
        }),
      )

      const res = await app.request('/api/mcp-servers/mcp_legacy', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ description: 'migration pending' }),
      })

      expect(res.status).toBe(200)
      expect(db.update).toHaveBeenCalled()
    })
  })

  // ==========================================================================
  // P0-1 regression: stdio MCP = arbitrary local command execution (host RCE).
  // Non-admins must not create/update/clone/probe stdio servers. Before the fix
  // any authenticated user could POST /probe-tools {type:'stdio',command:'/bin/sh'}
  // and run code as the API process user. sse/http (URL-only) stays open to all.
  // ==========================================================================
  describe('stdio execution is admin-only (P0-1)', () => {
    let userApp: Hono

    beforeEach(async () => {
      const mod = await import('../mcp-servers.js')
      userApp = new Hono()
      userApp.use('*', async (c, next) => {
        c.set('userRole' as never, 'user')
        c.set('userId' as never, 'usr_alice')
        await next()
      })
      userApp.route('/api/mcp-servers', mod.default)
    })

    it('GET /:id masks env/headers/url creds of a shared server for a non-owner viewer', async () => {
      // A shared (all-users) server owned by someone else is visible + bindable by
      // id, but its private config must be redacted — no cross-user credential leak.
      ;(db.select as Mock).mockReturnValue(
        makeDbChain({
          id: 'mcp_shared',
          name: 'shared-sse',
          type: 'sse',
          usageScope: 'all-users',
          userId: 'usr_bob', // NOT the caller (usr_alice)
          url: 'https://user:secret@remote.example.com/sse',
          headers: { Authorization: 'Bearer super-secret' },
          env: { API_KEY: 'sk-live-123' },
          groupConfig: null,
        }),
      )
      const res = await userApp.request('/api/mcp-servers/mcp_shared')
      expect(res.status).toBe(200)
      const body = (await res.json()) as { data: Record<string, unknown> }
      expect(body.data.headers).toEqual({ Authorization: '********' })
      expect(body.data.env).toEqual({ API_KEY: '********' })
      // credentials stripped from the URL, host/path preserved for reference
      expect(body.data.url).not.toContain('secret')
      // non-sensitive fields kept so the selector still works
      expect(body.data.name).toBe('shared-sse')
      expect(body.data.usageScope).toBe('all-users')
    })

    it('GET /:id strips a URL query-string / path token for a non-owner viewer', async () => {
      // Regression: a secret can hide in the query string (?apikey=...) or the path
      // (/sse/<token>), not only in user:pass@ userinfo. The mask must reduce a
      // shared server's URL to its bare origin so no token leaks cross-user.
      ;(db.select as Mock).mockReturnValue(
        makeDbChain({
          id: 'mcp_shared',
          name: 'shared-sse',
          type: 'sse',
          usageScope: 'all-users',
          userId: 'usr_bob', // NOT the caller (usr_alice)
          url: 'https://remote.example.com/sse/tok_PATHSECRET?apikey=sk-live-QUERYSECRET',
          headers: null,
          env: null,
          groupConfig: null,
        }),
      )
      const res = await userApp.request('/api/mcp-servers/mcp_shared')
      expect(res.status).toBe(200)
      const body = (await res.json()) as { data: { url: string } }
      expect(body.data.url).not.toContain('QUERYSECRET')
      expect(body.data.url).not.toContain('PATHSECRET')
      expect(body.data.url).not.toContain('apikey')
      // origin kept for recognizability, everything after it masked
      expect(body.data.url).toBe('https://remote.example.com/********')
    })

    it('GET /:id strips a URL fragment token for a non-owner viewer', async () => {
      // Regression: a token can also hide in the URL fragment (#...); the mask must
      // drop it too, not just userinfo/path/query.
      ;(db.select as Mock).mockReturnValue(
        makeDbChain({
          id: 'mcp_shared',
          name: 'shared-sse',
          type: 'sse',
          usageScope: 'all-users',
          userId: 'usr_bob', // NOT the caller (usr_alice)
          url: 'https://remote.example.com#token=sk-live-FRAGMENTSECRET',
          headers: null,
          env: null,
          groupConfig: null,
        }),
      )
      const res = await userApp.request('/api/mcp-servers/mcp_shared')
      expect(res.status).toBe(200)
      const body = (await res.json()) as { data: { url: string } }
      expect(body.data.url).not.toContain('FRAGMENTSECRET')
      expect(body.data.url).toBe('https://remote.example.com/********')
    })

    it('non-admin probing a stdio command → 403, no spawn', async () => {
      const res = await userApp.request('/api/mcp-servers/probe-tools', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ type: 'stdio', command: '/bin/sh', args: ['-c', 'id'] }),
      })
      expect(res.status).toBe(403)
      // Denied before any transport connect — no spawn happened.
      expect(mockConnect).not.toHaveBeenCalled()
    })

    it('non-admin creating a stdio server → 403, no insert', async () => {
      const res = await userApp.request('/api/mcp-servers', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'evil', type: 'stdio', command: '/bin/sh' }),
      })
      expect(res.status).toBe(403)
      expect(db.insert as Mock).not.toHaveBeenCalled()
    })

    it('non-admin creating an sse server → allowed and persisted private (owner-only)', async () => {
      // A non-admin's own sse/http defaults to 'private': owner-only (its
      // URL/headers/env are private credentials, never shared implicitly). They can
      // still bind their own server; only an admin may share it (all-users).
      let captured: Record<string, unknown> = {}
      ;(db.insert as Mock).mockReturnValue({
        values: vi.fn().mockImplementation((vals: Record<string, unknown>) => {
          captured = vals
          return {
            returning: vi
              .fn()
              .mockReturnValue(asyncQuery({ get: vi.fn().mockReturnValue({ ...vals }) })),
          }
        }),
      })
      const res = await userApp.request('/api/mcp-servers', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'remote', type: 'sse', url: 'https://example.com/mcp' }),
      })
      expect(res.status).toBe(201)
      expect(captured.usageScope).toBe('private')
    })

    it('non-admin cannot set all-users (share is admin-only) → clamped to private', async () => {
      let captured: Record<string, unknown> = {}
      ;(db.insert as Mock).mockReturnValue({
        values: vi.fn().mockImplementation((vals: Record<string, unknown>) => {
          captured = vals
          return {
            returning: vi
              .fn()
              .mockReturnValue(asyncQuery({ get: vi.fn().mockReturnValue({ ...vals }) })),
          }
        }),
      })
      const res = await userApp.request('/api/mcp-servers', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: 'remote',
          type: 'sse',
          url: 'https://example.com/mcp',
          usageScope: 'all-users', // a non-admin cannot share
        }),
      })
      expect(res.status).toBe(201)
      expect(captured.usageScope).toBe('private')
    })

    it('admin PATCH cannot cross-share a NON-admin-owned private server to all-users → 422', async () => {
      // Invariant: an all-users row must be owned by an admin or a builtin. An admin
      // PATCHing someone else's private server to all-users would expose the owner's
      // url/headers/env to everyone — reject with 422, no write.
      const adminApp = new Hono()
      adminApp.use('*', async (c, next) => {
        c.set('userRole' as never, 'admin')
        c.set('userId' as never, 'usr_admin')
        await next()
      })
      adminApp.route('/api/mcp-servers', (await import('../mcp-servers.js')).default)
      ;(db.select as Mock)
        // 1) existing row: a non-admin (usr_bob) owned private sse server
        .mockReturnValueOnce(
          makeDbChain({
            id: 'mcp_1',
            name: 'bob-sse',
            type: 'sse',
            url: 'https://example.com/mcp',
            groupConfig: null,
            usageScope: 'private',
            userId: 'usr_bob',
          }),
        )
        // 2) owner role lookup → non-admin
        .mockReturnValueOnce(makeDbChain({ role: 'user' }))

      const res = await adminApp.request('/api/mcp-servers/mcp_1', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ usageScope: 'all-users' }),
      })
      expect(res.status).toBe(422)
      expect(db.update as Mock).not.toHaveBeenCalled()
    })

    it('admin PATCH CAN share an admin-owned private server to all-users', async () => {
      const adminApp = new Hono()
      adminApp.use('*', async (c, next) => {
        c.set('userRole' as never, 'admin')
        c.set('userId' as never, 'usr_admin')
        await next()
      })
      adminApp.route('/api/mcp-servers', (await import('../mcp-servers.js')).default)
      ;(db.select as Mock)
        .mockReturnValueOnce(
          makeDbChain({
            id: 'mcp_1',
            name: 'admin-sse',
            type: 'sse',
            url: 'https://example.com/mcp',
            groupConfig: null,
            usageScope: 'private',
            userId: 'usr_admin',
          }),
        )
        .mockReturnValueOnce(makeDbChain({ role: 'admin' }))
      let captured: Record<string, unknown> = {}
      ;(db.update as Mock).mockReturnValue({
        set: vi.fn().mockImplementation((vals: Record<string, unknown>) => {
          captured = vals
          return {
            where: vi.fn().mockReturnValue({
              returning: vi
                .fn()
                .mockReturnValue(asyncQuery({ get: vi.fn().mockReturnValue({ ...vals }) })),
            }),
          }
        }),
      })

      const res = await adminApp.request('/api/mcp-servers/mcp_1', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ usageScope: 'all-users' }),
      })
      expect(res.status).toBe(200)
      expect(captured.usageScope).toBe('all-users')
    })

    it('admin creating an sse server can widen usageScope to all-users', async () => {
      const adminApp = new Hono()
      adminApp.use('*', async (c, next) => {
        c.set('userRole' as never, 'admin')
        c.set('userId' as never, 'usr_admin')
        await next()
      })
      adminApp.route('/api/mcp-servers', (await import('../mcp-servers.js')).default)
      let captured: Record<string, unknown> = {}
      ;(db.insert as Mock).mockReturnValue({
        values: vi.fn().mockImplementation((vals: Record<string, unknown>) => {
          captured = vals
          return {
            returning: vi
              .fn()
              .mockReturnValue(asyncQuery({ get: vi.fn().mockReturnValue({ ...vals }) })),
          }
        }),
      })

      const res = await adminApp.request('/api/mcp-servers', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: 'shared-sse',
          type: 'sse',
          url: 'https://example.com/mcp',
          usageScope: 'all-users',
        }),
      })
      expect(res.status).toBe(201)
      expect(captured.usageScope).toBe('all-users')
    })

    it('a stdio server is forced admin-only even when the admin requests all-users', async () => {
      const adminApp = new Hono()
      adminApp.use('*', async (c, next) => {
        c.set('userRole' as never, 'admin')
        c.set('userId' as never, 'usr_admin')
        await next()
      })
      adminApp.route('/api/mcp-servers', (await import('../mcp-servers.js')).default)
      let captured: Record<string, unknown> = {}
      ;(db.insert as Mock).mockReturnValue({
        values: vi.fn().mockImplementation((vals: Record<string, unknown>) => {
          captured = vals
          return {
            returning: vi
              .fn()
              .mockReturnValue(asyncQuery({ get: vi.fn().mockReturnValue({ ...vals }) })),
          }
        }),
      })

      const res = await adminApp.request('/api/mcp-servers', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: 'local-stdio',
          type: 'stdio',
          command: 'npx',
          usageScope: 'all-users', // must be overridden — stdio is host RCE
        }),
      })
      expect(res.status).toBe(201)
      expect(captured.usageScope).toBe('admin-only')
    })

    it('non-admin updating a server to stdio → 403', async () => {
      ;(db.select as Mock).mockReturnValue(makeDbChain({ id: 'mcp_1', name: 'S', type: 'sse' }))
      const res = await userApp.request('/api/mcp-servers/mcp_1', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ type: 'stdio', command: '/bin/sh' }),
      })
      expect(res.status).toBe(403)
      expect(db.update as Mock).not.toHaveBeenCalled()
    })

    it('non-admin cloning a stdio server → 403', async () => {
      ;(db.select as Mock).mockReturnValue(
        makeDbChain({ id: 'mcp_1', name: 'S', type: 'stdio', command: 'npx', groupConfig: null }),
      )
      const res = await userApp.request('/api/mcp-servers/mcp_1/clone', { method: 'POST' })
      expect(res.status).toBe(403)
      expect(db.insert as Mock).not.toHaveBeenCalled()
    })

    it('admin cloning a stdio server pins usageScope=admin-only on the new row', async () => {
      // create/update force 'admin-only' for stdio; clone must too, or it mints a
      // stdio row scoped 'all-users' that a non-admin could later bind or reach
      // via a group ref.
      const adminApp = new Hono()
      adminApp.use('*', async (c, next) => {
        c.set('userRole' as never, 'admin')
        c.set('userId' as never, 'usr_admin')
        await next()
      })
      adminApp.route('/api/mcp-servers', (await import('../mcp-servers.js')).default)
      ;(db.select as Mock).mockReturnValue(
        makeDbChain({
          id: 'mcp_1',
          name: 'S',
          type: 'stdio',
          command: 'npx',
          groupConfig: null,
          usageScope: 'admin-only',
        }),
      )
      let captured: Record<string, unknown> = {}
      ;(db.insert as Mock).mockReturnValue({
        values: vi.fn().mockImplementation((vals: Record<string, unknown>) => {
          captured = vals
          return {
            returning: vi
              .fn()
              .mockReturnValue(asyncQuery({ get: vi.fn().mockReturnValue({ ...vals }) })),
          }
        }),
      })

      const res = await adminApp.request('/api/mcp-servers/mcp_1/clone', { method: 'POST' })
      expect(res.status).toBe(201)
      expect(captured.usageScope).toBe('admin-only')
    })

    it('non-admin cloning an admin-shared (all-users) sse server → clone is PRIVATE', async () => {
      // Regression: a clone is a freshly authored row owned by the caller, so it
      // follows the CREATE rule (fallback 'private'), NOT the source's scope. A
      // non-admin must not be able to mint an all-users row by cloning a shared one.
      ;(db.select as Mock).mockReturnValue(
        makeDbChain({
          id: 'mcp_src',
          name: 'shared-sse',
          type: 'sse',
          url: 'https://remote.example.com/sse',
          groupConfig: null,
          usageScope: 'all-users', // admin previously shared it
          userId: 'usr_admin',
        }),
      )
      let captured: Record<string, unknown> = {}
      ;(db.insert as Mock).mockReturnValue({
        values: vi.fn().mockImplementation((vals: Record<string, unknown>) => {
          captured = vals
          return {
            returning: vi
              .fn()
              .mockReturnValue(asyncQuery({ get: vi.fn().mockReturnValue({ ...vals }) })),
          }
        }),
      })

      // The caller is usr_alice (userApp), NOT the source owner usr_admin.
      vi.mocked(getCurrentUserId).mockReturnValue('usr_alice')
      const res = await userApp.request('/api/mcp-servers/mcp_src/clone', { method: 'POST' })
      expect(res.status).toBe(201)
      expect(captured.usageScope).toBe('private')
      // Credentials of a server the caller does NOT own must be stripped, or clone
      // becomes a side-channel around the GET/list mask.
      expect(captured.url).toBeNull()
    })

    it('non-admin cloning a shared sse strips url/headers/env (no credential copy)', async () => {
      vi.mocked(getCurrentUserId).mockReturnValue('usr_alice')
      ;(db.select as Mock).mockReturnValue(
        makeDbChain({
          id: 'mcp_src',
          name: 'shared-sse',
          type: 'sse',
          url: 'https://remote.example.com/sse?apikey=SECRET',
          headers: { Authorization: 'Bearer SECRET' },
          env: { API_KEY: 'SECRET' },
          groupConfig: null,
          usageScope: 'all-users',
          userId: 'usr_admin', // NOT the caller (usr_alice)
        }),
      )
      let captured: Record<string, unknown> = {}
      ;(db.insert as Mock).mockReturnValue({
        values: vi.fn().mockImplementation((vals: Record<string, unknown>) => {
          captured = vals
          return {
            returning: vi
              .fn()
              .mockReturnValue(asyncQuery({ get: vi.fn().mockReturnValue({ ...vals }) })),
          }
        }),
      })

      const res = await userApp.request('/api/mcp-servers/mcp_src/clone', { method: 'POST' })
      expect(res.status).toBe(201)
      expect(captured.url).toBeNull()
      expect(captured.headers).toBeNull()
      expect(captured.env).toBeNull()
    })

    it('non-admin cloning a shared group strips inline backend credentials', async () => {
      vi.mocked(getCurrentUserId).mockReturnValue('usr_alice')
      ;(db.select as Mock).mockReturnValue(
        makeDbChain({
          id: 'mcp_src',
          name: 'shared-group',
          type: 'group',
          url: null,
          headers: null,
          env: null,
          groupConfig: {
            backends: {
              d: [
                {
                  mode: 'inline',
                  name: 'svc',
                  type: 'sse',
                  url: 'https://remote.example.com/sse?apikey=SECRET',
                  headers: { Authorization: 'Bearer SECRET' },
                  env: { API_KEY: 'SECRET' },
                },
                { mode: 'ref', mcpServerId: 'mcp_other' },
              ],
            },
          },
          usageScope: 'all-users',
          userId: 'usr_admin',
        }),
      )
      let captured: Record<string, unknown> = {}
      ;(db.insert as Mock).mockReturnValue({
        values: vi.fn().mockImplementation((vals: Record<string, unknown>) => {
          captured = vals
          return {
            returning: vi
              .fn()
              .mockReturnValue(asyncQuery({ get: vi.fn().mockReturnValue({ ...vals }) })),
          }
        }),
      })

      const res = await userApp.request('/api/mcp-servers/mcp_src/clone', { method: 'POST' })
      expect(res.status).toBe(201)
      const gc = captured.groupConfig as {
        backends: Record<string, Array<Record<string, unknown>>>
      }
      const inline = gc.backends.d[0]
      expect(inline.url).toBeNull()
      expect(inline.headers).toBeNull()
      expect(inline.env).toBeNull()
      // ref backends carry no inline secrets and are untouched
      expect(gc.backends.d[1]).toEqual({ mode: 'ref', mcpServerId: 'mcp_other' })
    })

    it('OWNER cloning their own server keeps full credentials (no strip)', async () => {
      vi.mocked(getCurrentUserId).mockReturnValue('usr_alice') // caller owns mcp_src below
      ;(db.select as Mock).mockReturnValue(
        makeDbChain({
          id: 'mcp_src',
          name: 'my-sse',
          type: 'sse',
          url: 'https://remote.example.com/sse?apikey=SECRET',
          headers: { Authorization: 'Bearer SECRET' },
          env: null,
          groupConfig: null,
          usageScope: 'private',
          userId: 'usr_alice', // the caller (userApp) owns it
        }),
      )
      let captured: Record<string, unknown> = {}
      ;(db.insert as Mock).mockReturnValue({
        values: vi.fn().mockImplementation((vals: Record<string, unknown>) => {
          captured = vals
          return {
            returning: vi
              .fn()
              .mockReturnValue(asyncQuery({ get: vi.fn().mockReturnValue({ ...vals }) })),
          }
        }),
      })

      const res = await userApp.request('/api/mcp-servers/mcp_src/clone', { method: 'POST' })
      expect(res.status).toBe(201)
      expect(captured.url).toBe('https://remote.example.com/sse?apikey=SECRET')
      expect(captured.headers).toEqual({ Authorization: 'Bearer SECRET' })
    })

    it('non-admin creating a reserved builtin name → 400, no insert', async () => {
      const res = await userApp.request('/api/mcp-servers', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: 'a2wave-agent-router',
          type: 'sse',
          url: 'https://x.example',
        }),
      })
      expect(res.status).toBe(400)
      expect(db.insert as Mock).not.toHaveBeenCalled()
    })

    it('non-admin creating a group with an inline stdio backend → 403', async () => {
      const res = await userApp.request('/api/mcp-servers', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: 'grp',
          type: 'group',
          groupConfig: {
            backends: {
              main: [{ mode: 'inline', name: 'sh', type: 'stdio', command: '/bin/sh' }],
            },
          },
        }),
      })
      expect(res.status).toBe(403)
      expect(db.insert as Mock).not.toHaveBeenCalled()
    })

    it('non-admin probing tools of an EXISTING stdio server → 403, no spawn', async () => {
      // Closes the escape path: create is gated, but a pre-existing / imported
      // stdio row must not be executable via GET /:id/tools either.
      ;(db.select as Mock).mockReturnValue(
        makeDbChain({ id: 'mcp_1', name: 'S', type: 'stdio', command: 'npx', groupConfig: null }),
      )
      const res = await userApp.request('/api/mcp-servers/mcp_1/tools')
      expect(res.status).toBe(403)
      expect(mockConnect).not.toHaveBeenCalled()
    })

    it('admin probing tools of an existing sse server is allowed (URL-only)', async () => {
      ;(db.select as Mock).mockReturnValue(
        makeDbChain({ id: 'mcp_2', name: 'R', type: 'sse', url: 'https://example.com/mcp' }),
      )
      // Uses the admin-defaulted `app`, not userApp; sse is not gated.
      const res = await app.request('/api/mcp-servers/mcp_2/tools')
      expect(res.status).not.toBe(403)
    })
  })
})
