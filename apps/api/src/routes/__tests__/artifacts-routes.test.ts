import { Hono } from 'hono'
/**
 * Unit tests for routes/artifacts.ts
 * Uses Hono's built-in test helper (app.request) — no HTTP server needed.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { NotFoundError } from '../../lib/errors.js'

import { asyncQuery } from '../../test/async-query.js'

// ── DB mock state ──────────────────────────────────────────────────────────

let mockArtifacts: Record<string, unknown>[] = []
const mockDeleteCalled = false

const mockWhereAll = vi.fn(() => mockArtifacts)
// Use unknown return type so mockReturnValue(null) is accepted by TypeScript
const mockWhereGet: ReturnType<typeof vi.fn> = vi.fn(() => mockArtifacts[0] ?? null)
const mockDeleteWhere = vi.fn(() => asyncQuery({ run: vi.fn() }))
const mockWhereDelete = vi.fn(() => asyncQuery({ where: mockDeleteWhere }))

vi.mock('../../db/client.js', () => ({
  db: {
    select: vi.fn(() =>
      asyncQuery({
        from: vi.fn(() => ({
          where: vi.fn(() =>
            asyncQuery({
              all: mockWhereAll,
              get: mockWhereGet,
              // A `.limit(1)` single-row lookup must resolve from `get` alone.
              // Falling back to `all` here would make a mocked "row missing"
              // (`get -> null`) surface the unrelated list rows instead.
              limit: vi.fn(() => asyncQuery({ get: mockWhereGet })),
              orderBy: vi.fn(() => asyncQuery({ all: mockWhereAll })),
            }),
          ),
        })),
      }),
    ),
    delete: vi.fn(() => asyncQuery({ where: mockDeleteWhere })),
  },
}))

vi.mock('../../db/schema.js', () => ({
  artifacts: {
    id: 'id',
    runId: 'run_id',
    agentId: 'agent_id',
    userId: 'user_id',
  },
  // agent-access resolves artifact permission through these two.
  agents: { id: 'agents.id', userId: 'agents.user_id' },
  agentMembers: {
    agentId: 'agent_members.agent_id',
    userId: 'agent_members.user_id',
    role: 'agent_members.role',
  },
  runs: { id: 'runs.id', userId: 'runs.user_id', initiatorAgentId: 'runs.initiator_agent_id' },
}))

// ── FS mock ────────────────────────────────────────────────────────────────

let mockFileExists = true

vi.mock('node:fs', () => ({
  existsSync: vi.fn(() => mockFileExists),
  rmSync: vi.fn(),
  createReadStream: vi.fn(() => ({
    on: vi.fn(),
    pipe: vi.fn(),
  })),
}))

vi.mock('node:stream', () => ({
  Readable: {
    toWeb: vi.fn(() => new ReadableStream()),
  },
}))

// ── Owner filter mock ──────────────────────────────────────────────────────

let mockRole = 'user'
let mockUserId = 'usr_alice'

vi.mock('../../lib/owner-filter.js', () => ({
  getCurrentUserId: vi.fn(() => mockUserId),
}))

// agent-access is deliberately NOT mocked: hasAgentScopedAccess calls
// loadAgentWithPerm through a module-local reference, which vi.mock cannot
// intercept, so a partial mock would silently run the real lookup against an
// incomplete schema mock and turn every assertion into a 500. Drive the real
// helper instead and feed it rows via queueGets().
/** Queue successive `.get()` results: artifact row, then agent row, then membership row. */
function queueGets(...values: unknown[]) {
  mockWhereGet.mockReset()
  for (const v of values) mockWhereGet.mockReturnValueOnce(v)
}

vi.mock('../../lib/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}))

vi.mock('../../lib/audit.js', () => ({ logAudit: vi.fn() }))

let mockRequireAuthForDownload = 'true'
vi.mock('../../lib/settings.js', () => ({
  getSetting: vi.fn((category: string, key: string) => {
    if (category === 'artifacts' && key === 'requireAuthForDownload')
      return mockRequireAuthForDownload
    return undefined
  }),
}))

vi.mock('../../lib/artifact-storage.js', () => ({
  getArtifactsStorageRoot: vi.fn(() => '/data'),
}))

vi.mock('drizzle-orm', () => ({
  eq: vi.fn((col: unknown, val: unknown) => ({ col, val, op: 'eq' })),
  and: vi.fn((...args: unknown[]) => ({ op: 'and', args })),
  or: vi.fn((...args: unknown[]) => ({ op: 'or', args })),
  desc: vi.fn((col: unknown) => ({ col, op: 'desc' })),
  sql: vi.fn((strings: unknown, ...vals: unknown[]) => ({ op: 'sql', strings, vals })),
}))

// ── Build test app ─────────────────────────────────────────────────────────

async function buildTestApp() {
  const { default: artifactsRoutes } = await import('../../routes/artifacts.js')

  const app = new Hono()

  // Inject auth context
  app.use('*', async (c, next) => {
    c.set('userId' as never, mockUserId)
    c.set('userRole' as never, mockRole)
    await next()
  })

  app.route('/api/artifacts', artifactsRoutes)

  app.onError((err, c) => {
    if (err instanceof NotFoundError) {
      return c.json({ error: err.message, code: err.code }, err.statusCode as never)
    }
    return c.json({ error: 'Internal Server Error' }, 500)
  })

  return app
}

// ── Tests ──────────────────────────────────────────────────────────────────

describe('GET /api/artifacts', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockArtifacts = []
    mockRole = 'user'
    mockUserId = 'usr_alice'
    mockFileExists = true
  })

  it('returns 400 when runId is missing', async () => {
    const app = await buildTestApp()
    const res = await app.request('/api/artifacts')
    expect(res.status).toBe(400)
    const body = (await res.json()) as { error: string }
    expect(body.error).toBe('runId or agentId is required')
  })

  it('returns empty array when no artifacts for run', async () => {
    mockArtifacts = []
    mockWhereAll.mockReturnValue([])

    const app = await buildTestApp()
    const res = await app.request('/api/artifacts?runId=run_abc')
    expect(res.status).toBe(200)
    const body = (await res.json()) as { data: unknown[] }
    expect(body.data).toEqual([])
  })

  it('returns list of artifacts for run', async () => {
    const artifact = {
      id: 'art_1',
      runId: 'run_abc',
      userId: 'usr_alice',
      filename: 'report.md',
      storagePath: '/data/artifacts/report.md',
      mimeType: 'text/markdown',
      size: 1024,
      expiresAt: null,
    }
    mockWhereAll.mockReturnValue([artifact])

    const app = await buildTestApp()
    const res = await app.request('/api/artifacts?runId=run_abc')
    expect(res.status).toBe(200)
    const body = (await res.json()) as { data: (typeof artifact)[] }
    expect(body.data).toHaveLength(1)
    expect(body.data[0].filename).toBe('report.md')
  })

  it('does not expose storagePath in response', async () => {
    // The mock returns data without storagePath, matching what Drizzle returns
    // when db.select({ id, runId, ... }) excludes storagePath from the projection
    mockWhereAll.mockReturnValue([
      {
        id: 'art_2',
        runId: 'run_abc',
        agentId: null,
        userId: 'usr_alice',
        filename: 'secret.txt',
        mimeType: 'text/plain',
        size: 42,
        expiresAt: null,
        createdAt: null,
      },
    ])

    const app = await buildTestApp()
    const res = await app.request('/api/artifacts?runId=run_abc')
    expect(res.status).toBe(200)
    const body = (await res.json()) as { data: Record<string, unknown>[] }
    expect(body.data[0]).not.toHaveProperty('storagePath')

    // Verify the route calls db.select with explicit column projection that excludes storagePath
    const { db } = await import('../../db/client.js')
    const selectMock = db.select as ReturnType<typeof vi.fn>
    const selectArg = selectMock.mock.calls[selectMock.mock.calls.length - 1]?.[0] as
      | Record<string, unknown>
      | undefined
    expect(selectArg).toBeDefined()
    expect(selectArg).not.toHaveProperty('storagePath')
    expect(selectArg).toHaveProperty('id')
    expect(selectArg).toHaveProperty('filename')
  })
})

describe('GET /api/artifacts/:id/download', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockRole = 'user'
    mockUserId = 'usr_alice'
    mockFileExists = true
  })

  it('returns 404 when artifact not found in DB', async () => {
    mockWhereGet.mockReturnValue(null)

    const app = await buildTestApp()
    const res = await app.request('/api/artifacts/art_ghost/download')
    expect(res.status).toBe(404)
  })

  it('returns 403 when user does not own artifact', async () => {
    mockUserId = 'usr_bob'
    mockWhereGet.mockReturnValue({
      id: 'art_1',
      userId: 'usr_alice', // owned by alice, not bob
      storagePath: '/data/file.txt',
      filename: 'file.txt',
      mimeType: 'text/plain',
      size: 100,
    })

    const app = await buildTestApp()
    const res = await app.request('/api/artifacts/art_1/download')
    expect(res.status).toBe(403)
  })

  it('returns 404 when file is missing from disk', async () => {
    mockFileExists = false
    mockWhereGet.mockReturnValue({
      id: 'art_1',
      userId: 'usr_alice',
      storagePath: '/data/missing.txt',
      filename: 'missing.txt',
      mimeType: 'text/plain',
      size: 100,
    })

    const app = await buildTestApp()
    const res = await app.request('/api/artifacts/art_1/download')
    expect(res.status).toBe(404)
  })

  it('admin can download any artifact regardless of ownership', async () => {
    mockRole = 'admin'
    mockUserId = 'usr_admin'
    mockFileExists = true
    mockWhereGet.mockReturnValue({
      id: 'art_1',
      userId: 'usr_alice', // owned by alice
      storagePath: '/data/report.md',
      filename: 'report.md',
      mimeType: 'text/markdown',
      size: 500,
    })

    const app = await buildTestApp()
    const res = await app.request('/api/artifacts/art_1/download')
    // Should not be 403
    expect(res.status).not.toBe(403)
  })

  it('returns correct Content-Disposition header', async () => {
    mockWhereGet.mockReturnValue({
      id: 'art_1',
      userId: 'usr_alice',
      storagePath: '/data/my report.md',
      filename: 'my report.md',
      mimeType: 'text/markdown',
      size: 200,
    })

    const app = await buildTestApp()
    const res = await app.request('/api/artifacts/art_1/download')

    if (res.status === 200) {
      const disposition = res.headers.get('Content-Disposition')
      expect(disposition).toContain('attachment')
      expect(disposition).toContain(encodeURIComponent('my report.md'))
    }
  })

  it('when requireAuthForDownload is false, allows download without auth context', async () => {
    mockRequireAuthForDownload = 'false'
    mockWhereGet.mockReturnValue({
      id: 'art_1',
      userId: 'usr_alice',
      storagePath: '/data/public.txt',
      filename: 'public.txt',
      mimeType: 'text/plain',
      size: 50,
    })

    const { default: artifactsRoutes } = await import('../../routes/artifacts.js')
    const app = new Hono()
    // No auth middleware / no userId injection
    app.route('/api/artifacts', artifactsRoutes)
    app.onError((err, c) => {
      if (err instanceof NotFoundError) {
        return c.json({ error: err.message, code: err.code }, err.statusCode as never)
      }
      return c.json({ error: 'Internal Server Error' }, 500)
    })

    const res = await app.request('/api/artifacts/art_1/download')
    expect(res.status).toBe(200)

    mockRequireAuthForDownload = 'true'
  })
})

describe('DELETE /api/artifacts/:id', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockRole = 'user'
    mockUserId = 'usr_alice'
    mockFileExists = true
  })

  it('returns 404 when artifact not found', async () => {
    mockWhereGet.mockReturnValue(null)

    const app = await buildTestApp()
    const res = await app.request('/api/artifacts/art_ghost', { method: 'DELETE' })
    expect(res.status).toBe(404)
  })

  it('returns 403 when user does not own artifact', async () => {
    mockUserId = 'usr_bob'
    mockWhereGet.mockReturnValue({
      id: 'art_1',
      userId: 'usr_alice',
      storagePath: '/data/file.txt',
      filename: 'file.txt',
    })

    const app = await buildTestApp()
    const res = await app.request('/api/artifacts/art_1', { method: 'DELETE' })
    expect(res.status).toBe(403)
  })

  it('returns 200 and deletes owned artifact', async () => {
    mockWhereGet.mockReturnValue({
      id: 'art_1',
      userId: 'usr_alice',
      storagePath: '/data/file.txt',
      filename: 'file.txt',
    })

    const app = await buildTestApp()
    const res = await app.request('/api/artifacts/art_1', { method: 'DELETE' })
    expect(res.status).toBe(200)
    const body = (await res.json()) as { success: boolean }
    expect(body.success).toBe(true)
  })

  it('admin can delete any artifact', async () => {
    mockRole = 'admin'
    mockUserId = 'usr_admin'
    mockWhereGet.mockReturnValue({
      id: 'art_1',
      userId: 'usr_alice', // owned by alice
      storagePath: '/data/file.txt',
      filename: 'file.txt',
    })

    const app = await buildTestApp()
    const res = await app.request('/api/artifacts/art_1', { method: 'DELETE' })
    expect(res.status).toBe(200)
  })
})

// ============================================================================
// Agent-derived artifact permission.
//
// `artifacts.user_id` is inherited from the run that produced the artifact, so
// it is NULL for Feishu / gateway API key / OAuth runs. Gating on that column
// alone locked the agent's own non-admin owner out of their agent's artifacts:
// the run-detail drawer's "运行产物" block disappeared entirely, and turning
// `requireAuthForDownload` on turned that into a hard 403 on the download link.
// ============================================================================
describe('artifact permission derives from the agent', () => {
  const channelArtifact = {
    id: 'art_1',
    // The regression: a Feishu/gateway/OAuth run leaves no trigger identity.
    userId: null,
    agentId: 'agt_mine',
    storagePath: '/data/report.xlsx',
    filename: 'report.xlsx',
    mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    size: 15400,
  }
  /** Agent row as loadAgentWithPerm reads it — owned by someone other than the caller. */
  const foreignAgent = { id: 'agt_mine', userId: 'usr_owner' }

  beforeEach(() => {
    vi.clearAllMocks()
    mockRole = 'user'
    mockUserId = 'usr_alice'
    mockFileExists = true
    mockRequireAuthForDownload = 'true'
  })

  describe('download (requireAuthForDownload on)', () => {
    it('agent owner can download an artifact with no trigger identity', async () => {
      // Caller owns the agent → resolved in one lookup, no membership row needed.
      queueGets(channelArtifact, { id: 'agt_mine', userId: 'usr_alice' })
      const res = await (await buildTestApp()).request('/api/artifacts/art_1/download')
      expect(res.status).toBe(200)
    })

    it('viewer member can download — read visibility matches the listing', async () => {
      queueGets(channelArtifact, foreignAgent, { role: 'viewer' })
      const res = await (await buildTestApp()).request('/api/artifacts/art_1/download')
      expect(res.status).toBe(200)
    })

    it('a user with no relationship to the agent is still refused', async () => {
      queueGets(channelArtifact, foreignAgent, undefined)
      const res = await (await buildTestApp()).request('/api/artifacts/art_1/download')
      expect(res.status).toBe(403)
    })
  })

  describe('delete', () => {
    it('agent owner can delete an artifact with no trigger identity', async () => {
      queueGets(channelArtifact, { id: 'agt_mine', userId: 'usr_alice' })
      const res = await (await buildTestApp()).request('/api/artifacts/art_1', { method: 'DELETE' })
      expect(res.status).toBe(200)
    })

    it('editor member can delete', async () => {
      queueGets(channelArtifact, foreignAgent, { role: 'editor' })
      const res = await (await buildTestApp()).request('/api/artifacts/art_1', { method: 'DELETE' })
      expect(res.status).toBe(200)
    })

    it('viewer member can see it but must NOT delete it', async () => {
      queueGets(channelArtifact, foreignAgent, { role: 'viewer' })
      const res = await (await buildTestApp()).request('/api/artifacts/art_1', { method: 'DELETE' })
      expect(res.status).toBe(403)
    })

    it('viewer member CAN delete an artifact they produced themselves', async () => {
      // Own trigger identity short-circuits before the agent lookup.
      queueGets({ ...channelArtifact, userId: 'usr_alice' })
      const res = await (await buildTestApp()).request('/api/artifacts/art_1', { method: 'DELETE' })
      expect(res.status).toBe(200)
    })
  })
})

// ============================================================================
// Visibility-filter wiring.
//
// The diff removed the `getOwnerFilter` sentinel these tests used to rely on and
// replaced it with a filter stubbed to `undefined`, which by construction can
// never notice the filter being dropped from the route. A mutation check
// confirmed it: replacing the list's conditions with the bare scope filter left
// every test green, i.e. every authenticated user would see every artifact.
// ============================================================================
describe('GET /api/artifacts applies the visibility filter', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockUserId = 'usr_alice'
    mockWhereAll.mockReturnValue([])
  })

  it('combines the scope filter with the visibility predicate for a non-admin', async () => {
    mockRole = 'user'
    const app = await buildTestApp()
    const res = await app.request('/api/artifacts?runId=run_abc')
    expect(res.status).toBe(200)

    // drizzle-orm is mocked in this suite, so the real getArtifactReadFilter
    // renders as `{ op: 'or', args: [...] }` and `and(...)` records its inputs.
    // If the route stopped combining the two, `and` would never be called.
    const { and } = await import('drizzle-orm')
    const andCalls = (and as unknown as ReturnType<typeof vi.fn>).mock.calls
    expect(andCalls).toHaveLength(1)
    expect(andCalls[0]).toHaveLength(2)
    expect((andCalls[0][1] as { op?: string }).op).toBe('or')
  })

  it('leaves an admin query unwrapped — no visibility predicate to combine', async () => {
    mockRole = 'admin'
    const app = await buildTestApp()
    const res = await app.request('/api/artifacts?runId=run_abc')
    expect(res.status).toBe(200)

    const { and } = await import('drizzle-orm')
    expect((and as unknown as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(0)
  })
})

// ============================================================================
// Audit coverage.
//
// Iron Rule 5 (docs/agent/audit-logging.md): deleting an artifact removes the
// file from disk and its row from the database, yet artifacts.ts wrote no audit
// entry at all — "who deleted that report" was permanently unanswerable.
// ============================================================================
describe('DELETE /api/artifacts/:id — audit trail', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockRole = 'user'
    mockUserId = 'usr_alice'
    mockFileExists = true
  })

  it('records artifact.delete with the filename', async () => {
    queueGets({
      id: 'art_1',
      userId: 'usr_alice',
      agentId: 'agt_mine',
      storagePath: '/data/report.xlsx',
      filename: 'report.xlsx',
    })

    const app = await buildTestApp()
    const res = await app.request('/api/artifacts/art_1', { method: 'DELETE' })
    expect(res.status).toBe(200)

    const { logAudit } = await import('../../lib/audit.js')
    expect(logAudit).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        action: 'artifact.delete',
        resource: 'artifact',
        resourceId: 'art_1',
        details: expect.objectContaining({ filename: 'report.xlsx' }),
      }),
    )
  })

  it('does not record a deletion it refused', async () => {
    queueGets(
      { id: 'art_1', userId: null, agentId: 'agt_shared', storagePath: '/data/x', filename: 'x' },
      { id: 'agt_shared', userId: 'usr_owner' },
      { role: 'viewer' },
    )

    const app = await buildTestApp()
    const res = await app.request('/api/artifacts/art_1', { method: 'DELETE' })
    expect(res.status).toBe(403)

    const { logAudit } = await import('../../lib/audit.js')
    expect(logAudit).not.toHaveBeenCalled()
  })
})
