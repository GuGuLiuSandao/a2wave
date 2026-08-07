import { Hono } from 'hono'
/**
 * Characterization test for the chat run-launch seam in routes/agents.ts.
 *
 * Purpose: freeze the observable behavior of POST /agents/:id/chat across the
 * 5-step launch chain (validate → SCM check → run/step write → tryAcquireSlot →
 * executeWithRetry → finishRun*) BEFORE PR 2 extracts a shared
 * `launchChatRun` service. PR 2 must keep this test green without modification.
 *
 * Scope: branches not already covered by routes/__tests__/agents-integration.test.ts:
 *   - SCM unsynced workspace returns 400 with SCM_INITIAL_SYNC_REQUIRED
 *   - queue_full rolls back the freshly-created run and returns 429
 *   - queued (sync mode) returns 202 with { status: 'queued', runId }
 *   - sync happy path returns 200 with { data: { reply, chatId, durationMs, runId } }
 *   - executeWithRetry result.success=false returns 500 with the engine error
 *
 * Following Karpathy guidelines: this file is purely additive and asserts
 * current behavior — including any quirks. It does not "improve" anything.
 */
import { type Mock, beforeEach, describe, expect, it, vi } from 'vitest'

type Json = Record<string, unknown>

// ---------------------------------------------------------------------------
// Module mocks (must come before importing routes/agents.js)
// ---------------------------------------------------------------------------

vi.mock('../../db/client.js', () => ({
  db: {
    select: vi.fn(),
    insert: vi.fn(),
    update: vi.fn(),
    delete: vi.fn(),
  },
}))

vi.mock('../../lib/id.js', () => {
  let counter = 0
  return {
    createId: vi.fn((prefix?: string) => {
      counter++
      return prefix ? `${prefix}_seam${counter}` : `seam${counter}`
    }),
  }
})

vi.mock('../../engine/index.js', () => ({
  engineRegistry: {
    get: vi.fn().mockReturnValue({ kill: vi.fn().mockReturnValue(true) }),
    types: ['cursor'],
  },
}))

vi.mock('../../lib/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}))

vi.mock('../../worker/index.js', () => ({
  executeInWorker: vi.fn(),
}))

vi.mock('../../lib/agent-helpers.js', () => ({
  resolveWorkDir: vi.fn().mockReturnValue('/tmp/work'),
  injectScmEnv: vi.fn(),
  buildAgentConfig: vi.fn().mockReturnValue({ engineType: 'cursor' }),
  resolveEngineType: vi.fn(
    (agentConfig, agentType) => agentConfig.engineType || agentType || 'cursor',
  ),
}))

vi.mock('../../engine/task-queue.js', () => ({
  tryAcquireSlot: vi.fn(),
  scheduleNext: vi.fn(),
}))

vi.mock('../../engine/task-queue-db.js', () => ({
  taskQueueDb: {},
}))

vi.mock('../../lib/execute-with-retry.js', () => ({
  executeWithRetry: vi.fn(),
}))

// Real finishRunError ALWAYS returns a hardcoded publicErrorMsg regardless of
// the inner error (apps/api/src/lib/run-lifecycle.ts:183 + :219). The mock
// matches that exact contract so the test locks the real public response,
// not the developer-facing inner Error.message.
const PUBLIC_ERROR_MSG = 'Execution failed. Check server logs for details.'

vi.mock('../../lib/run-lifecycle.js', () => ({
  finishRunSuccess: vi.fn(),
  finishRunError: vi.fn(() => PUBLIC_ERROR_MSG),
  createLogCollector: vi.fn(() => ({ logs: [], onLogEntry: vi.fn() })),
  createPersistingLogCollector: vi.fn(() => ({
    logs: [],
    onLogEntry: vi.fn(),
    stop: vi.fn().mockResolvedValue(undefined),
  })),
  sanitizeLogsForStorage: vi.fn((logs: unknown[]) => logs),
}))

vi.mock('../../lib/run-log-registry.js', () => ({
  registerLogCollector: vi.fn(),
  unregisterLogCollector: vi.fn(),
  stopLogCollector: vi.fn().mockResolvedValue(undefined),
}))

vi.mock('../../lib/feishu-service.js', () => ({
  feishuConnectionManager: {
    stop: vi.fn(),
    getFeishuConnectionStatuses: vi.fn().mockReturnValue([]),
  },
}))

vi.mock('../../lib/schedule-trigger.js', () => ({
  scheduleTriggerManager: { stop: vi.fn() },
}))

vi.mock('../../lib/audit.js', () => ({
  logAudit: vi.fn(),
}))

vi.mock('../../lib/agent-export.js', () => ({
  buildExportZip: vi.fn(),
}))

vi.mock('../../lib/agent-import.js', () => ({
  importAgentFromZip: vi.fn(),
  importAgentFromUrl: vi.fn(),
}))

vi.mock('../../lib/agent-share.js', () => ({
  createShareToken: vi.fn(),
}))

vi.mock('../../lib/agent-execution-diagnose.js', () => ({
  collectAgentExecutionChecks: vi.fn().mockResolvedValue([]),
}))

vi.mock('../../lib/feishu-diagnose.js', () => ({
  runAgentFeishuDiagnose: vi.fn().mockResolvedValue({ checks: [], meta: {} }),
}))

vi.mock('../../lib/owner-filter.js', () => ({
  getOwnerFilter: vi.fn().mockReturnValue(undefined),
  getCurrentUserId: vi.fn().mockReturnValue('usr_admin'),
}))

// ---------------------------------------------------------------------------
// Imports after mocks are registered
// ---------------------------------------------------------------------------
import { db } from '../../db/client.js'
import { tryAcquireSlot } from '../../engine/task-queue.js'
import { executeWithRetry } from '../../lib/execute-with-retry.js'
import { finishRunError, finishRunSuccess } from '../../lib/run-lifecycle.js'

import { asyncQuery } from '../../test/async-query.js'

const mockDb = db as unknown as {
  select: Mock
  insert: Mock
  update: Mock
  delete: Mock
}

// ---------------------------------------------------------------------------
// Drizzle chain helpers (matches style of agents-integration.test.ts)
// ---------------------------------------------------------------------------

function makeSelectChain(result: unknown) {
  const dataArray = result ? (Array.isArray(result) ? result : [result]) : []
  const terminal = {
    get: vi.fn().mockReturnValue(result),
    all: vi.fn().mockReturnValue(dataArray),
    orderBy: vi.fn().mockReturnValue(
      asyncQuery({
        get: vi.fn().mockReturnValue(result),
        all: vi.fn().mockReturnValue(dataArray),
        limit: vi.fn().mockReturnValue({
          get: vi.fn().mockReturnValue(result),
          all: vi.fn().mockReturnValue(dataArray),
          offset: vi.fn().mockReturnValue(asyncQuery({ all: vi.fn().mockReturnValue(dataArray) })),
        }),
      }),
    ),
    limit: vi.fn().mockReturnValue(
      asyncQuery({
        get: vi.fn().mockReturnValue(result),
        all: vi.fn().mockReturnValue(dataArray),
        offset: vi.fn().mockReturnValue(asyncQuery({ all: vi.fn().mockReturnValue(dataArray) })),
      }),
    ),
  }
  return {
    from: vi.fn().mockReturnValue(
      asyncQuery({
        where: vi.fn().mockReturnValue(terminal),
        orderBy: terminal.orderBy,
        all: terminal.all,
      }),
    ),
  }
}

function makeInsertChain() {
  return {
    values: vi.fn().mockReturnValue(
      asyncQuery({
        returning: vi.fn().mockReturnValue(asyncQuery({ get: vi.fn().mockReturnValue({}) })),
        run: vi.fn(),
      }),
    ),
  }
}

function makeUpdateChain() {
  return {
    set: vi.fn().mockReturnValue({
      where: vi.fn().mockReturnValue(
        asyncQuery({
          run: vi.fn(),
          returning: vi.fn().mockReturnValue(asyncQuery({ get: vi.fn().mockReturnValue({}) })),
        }),
      ),
    }),
  }
}

function makeDeleteChain() {
  const runFn = vi.fn()
  const where = vi.fn().mockReturnValue(asyncQuery({ run: runFn }))
  return { chain: { where }, runFn, whereFn: where }
}

// ---------------------------------------------------------------------------
// Per-table select dispatcher.
//
// POST /:id/chat reads multiple tables in sequence:
//   agents → (optionally) scmSources → (optionally) runs (chatId reuse) → runSteps (max order)
// We dispatch the mocked select() returns based on call order configured per test.
// ---------------------------------------------------------------------------
function configureSelectQueue(returns: unknown[]) {
  let i = 0
  mockDb.select.mockImplementation((..._args: unknown[]) => {
    const next = i < returns.length ? returns[i] : undefined
    i++
    return makeSelectChain(next)
  })
}

const tempAgent = {
  id: 'agt_seam1',
  name: 'Seam Agent',
  type: 'cursor',
  config: {},
  systemPrompt: null,
  skills: [],
  mcpServerIds: [],
  kbDocumentIds: [],
  publishStatus: 'draft',
  publishChannels: ['api'],
  publishIpWhitelist: [],
  publishAuthType: 'api_key',
  endpointApiKey: null,
  feishuConfig: null,
  scheduleConfig: null,
  providerId: null,
  env: null,
  workspaceType: 'temp' as const,
  scmSourceId: null,
  maxConcurrency: 1,
  showLocalChildOutput: null,
  showRemoteChildOutput: null,
  userId: 'usr_admin',
}

const scmAgent = {
  ...tempAgent,
  id: 'agt_seam_scm',
  workspaceType: 'scm' as const,
  scmSourceId: 'scm_src1',
}

function createApp() {
  const app = new Hono()
  // Inject auth context (mirrors createTestApp's behavior)
  app.use('*', async (c, next) => {
    c.set('userId' as never, 'usr_admin' as never)
    c.set('userRole' as never, 'admin' as never)
    await next()
  })
  return app
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------
describe('POST /agents/:id/chat — characterization (run-launch seam)', () => {
  let agentsApp: Hono

  beforeEach(async () => {
    vi.clearAllMocks()
    mockDb.insert.mockReturnValue(makeInsertChain())
    mockDb.update.mockReturnValue(makeUpdateChain())
    mockDb.delete.mockReturnValue({
      where: vi.fn().mockReturnValue(asyncQuery({ run: vi.fn() })),
    })
    ;(tryAcquireSlot as Mock).mockReturnValue('acquired')

    const mod = await import('../../routes/agents.js')
    agentsApp = createApp()
    agentsApp.route('/agents', mod.default)
  })

  it('returns 400 SCM_INITIAL_SYNC_REQUIRED when SCM workspace has no initial sync', async () => {
    // select order: agent → scm source (with initialSyncCompletedAt = null)
    configureSelectQueue([scmAgent, { id: 'scm_src1', initialSyncCompletedAt: null }])

    const res = await agentsApp.request('/agents/agt_seam_scm/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: 'hello' }),
    })

    expect(res.status).toBe(400)
    const json = (await res.json()) as Json
    expect(json.error).toBe('SCM_INITIAL_SYNC_REQUIRED')
    // executeWithRetry must NOT be called
    expect(executeWithRetry as Mock).not.toHaveBeenCalled()
    // No run records should be created on the SCM-rejected path
    expect(mockDb.insert).not.toHaveBeenCalled()
  })

  it('returns 429 and rolls back the freshly-created run on queue_full', async () => {
    configureSelectQueue([tempAgent])
    ;(tryAcquireSlot as Mock).mockReturnValue('queue_full')

    // Capture delete invocation
    const deleteRunFn = vi.fn()
    mockDb.delete.mockReturnValue({
      where: vi.fn().mockReturnValue(asyncQuery({ run: deleteRunFn })),
    })

    const res = await agentsApp.request('/agents/agt_seam1/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: 'hello' }),
    })

    expect(res.status).toBe(429)
    const json = (await res.json()) as Json
    expect(json.error).toBe('Queue is full')
    // The newly inserted run must have been deleted
    expect(mockDb.delete).toHaveBeenCalled()
    expect(deleteRunFn).toHaveBeenCalled()
    // executeWithRetry must NOT run
    expect(executeWithRetry as Mock).not.toHaveBeenCalled()
  })

  it('returns 202 { status: "queued", runId } when slot is queued in sync mode', async () => {
    configureSelectQueue([tempAgent])
    ;(tryAcquireSlot as Mock).mockReturnValue('queued')

    const res = await agentsApp.request('/agents/agt_seam1/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: 'hello' }),
    })

    expect(res.status).toBe(202)
    const json = (await res.json()) as Json
    expect(json.status).toBe('queued')
    expect(typeof json.runId).toBe('string')
    expect(json.runId).toMatch(/^run_seam/)
    // No execution should occur for queued path
    expect(executeWithRetry as Mock).not.toHaveBeenCalled()
  })

  it('sync happy path returns 200 with { data: { reply, chatId, durationMs, runId } }', async () => {
    // select order: agent → runSteps max order
    configureSelectQueue([tempAgent, { maxOrder: 0 }])
    ;(executeWithRetry as Mock).mockResolvedValue({
      result: { success: true, output: 'hi from agent', chatId: 'chat_xyz', durationMs: 0 },
      retries: [],
      logs: [],
    })

    const res = await agentsApp.request('/agents/agt_seam1/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: 'hello' }),
    })

    expect(res.status).toBe(200)
    const json = (await res.json()) as Json
    const data = json.data as Json
    expect(data.reply).toBe('hi from agent')
    expect(data.chatId).toBe('chat_xyz')
    expect(typeof data.runId).toBe('string')
    expect(data.runId).toMatch(/^run_seam/)
    expect(typeof data.durationMs).toBe('number')

    expect(finishRunSuccess as Mock).toHaveBeenCalledTimes(1)
    expect(finishRunError as Mock).not.toHaveBeenCalled()
  })

  it('sync mode returns 500 with engine error when result.success is false', async () => {
    configureSelectQueue([tempAgent, { maxOrder: 0 }])
    ;(executeWithRetry as Mock).mockResolvedValue({
      result: {
        success: false,
        error: 'cursor crashed',
        output: '',
        chatId: undefined,
        durationMs: 0,
      },
      retries: [],
      logs: [],
    })

    const res = await agentsApp.request('/agents/agt_seam1/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: 'hello' }),
    })

    expect(res.status).toBe(500)
    const json = (await res.json()) as Json
    expect(json.error).toBe('cursor crashed')

    // finishRunError must be called for the failed engine result
    expect(finishRunError as Mock).toHaveBeenCalled()
    expect(finishRunSuccess as Mock).not.toHaveBeenCalled()
  })

  it('sync mode returns 500 with the redacted public error message when executeWithRetry throws', async () => {
    configureSelectQueue([tempAgent, { maxOrder: 0 }])
    const innerErr = new Error('worker exploded')
    ;(executeWithRetry as Mock).mockRejectedValue(innerErr)

    const res = await agentsApp.request('/agents/agt_seam1/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: 'hello' }),
    })

    expect(res.status).toBe(500)
    const json = (await res.json()) as Json
    // The HTTP response carries the redacted publicErrorMsg from finishRunError,
    // NOT the inner Error.message. This is intentional — finishRunError logs
    // the real error server-side and returns the redacted string for the client.
    // Locking this prevents PR 2 from accidentally leaking inner errors.
    expect(json.error).toBe(PUBLIC_ERROR_MSG)
    // The inner error must still be passed through to finishRunError so it's
    // logged + persisted to runs.result on the server side.
    expect(finishRunError as Mock).toHaveBeenCalledWith(expect.any(Object), innerErr)
    expect(finishRunSuccess as Mock).not.toHaveBeenCalled()
  })
})
