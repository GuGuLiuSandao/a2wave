/**
 * Covers the startDate / endDate validation branches in GET /runs that
 * runs.test.ts doesn't reach.
 */
import { Hono } from 'hono'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const dbSelect = vi.fn()
const dbInsert = vi.fn()
const dbUpdate = vi.fn()
vi.mock('../../db/client.js', () => ({
  db: {
    select: (...a: unknown[]) => dbSelect(...a),
    insert: (...a: unknown[]) => dbInsert(...a),
    update: (...a: unknown[]) => dbUpdate(...a),
  },
}))

vi.mock('../../db/schema.js', () => ({
  runs: {
    id: 'runs.id',
    initiatorAgentId: 'runs.initiatorAgentId',
    createdAt: 'runs.createdAt',
    updatedAt: 'runs.updatedAt',
    status: 'runs.status',
    userId: 'runs.userId',
    intent: 'runs.intent',
    result: 'runs.result',
  },
  agents: { id: 'agents.id', name: 'agents.name', icon: 'agents.icon' },
  runSteps: { id: 'runSteps.id', runId: 'runSteps.runId' },
  chatMessages: {
    id: 'chatMessages.id',
    runId: 'chatMessages.runId',
    createdAt: 'chatMessages.createdAt',
  },
}))

vi.mock('../../lib/audit.js', () => ({ logAudit: vi.fn() }))
vi.mock('../../lib/id.js', () => ({ createId: vi.fn(() => 'id_x') }))
vi.mock('../../lib/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}))
vi.mock('../../lib/owner-filter.js', () => ({
  getCurrentUserId: vi.fn(() => 'usr_test'),
}))
// This suite only exercises GET /runs date parsing; run visibility is covered by
// agent-access.test.ts, so stub the filter out (admin-equivalent, no WHERE).
vi.mock('../../lib/agent-access.js', () => ({
  getRunReadFilter: vi.fn(() => undefined),
  loadAgentWithPerm: vi.fn(() => null),
  requireAgentWrite: vi.fn(),
  // runs.ts imports this too. A full mock factory that omits it makes any future
  // cancel/execute case added here die with Vitest's "No export is defined on the
  // mock" instead of a readable assertion failure.
  hasAgentScopedAccess: vi.fn(() => true),
}))
vi.mock('../../lib/agent-helpers.js', () => ({
  buildAgentConfig: vi.fn(),
}))
vi.mock('../../lib/execute-with-retry.js', () => ({ executeWithRetry: vi.fn() }))
vi.mock('../../lib/run-lifecycle.js', () => ({
  createPersistingLogCollector: vi.fn(),
  registerLogCollector: vi.fn(),
  unregisterLogCollector: vi.fn(),
  finishRunSuccess: vi.fn(),
  finishRunError: vi.fn(),
  notifyRunError: vi.fn(),
}))
vi.mock('../../lib/run-launcher.js', () => ({
  resolveWorkDir: vi.fn(),
}))
vi.mock('../../engine/index.js', () => ({ engineRegistry: { get: vi.fn() } }))
vi.mock('../../engine/task-queue.js', () => ({
  scheduleNext: vi.fn(),
  tryAcquireSlot: vi.fn(),
  buildTaskId: vi.fn(() => 'task_id'),
  releaseSlot: vi.fn(),
}))
vi.mock('../../engine/task-queue-db.js', () => ({ taskQueueDb: {} }))
vi.mock('../../worker/index.js', () => ({ executeInWorker: vi.fn() }))
vi.mock('hono/streaming', () => ({ streamSSE: vi.fn() }))

const sharedMock = vi.hoisted(() => ({
  // POST /runs now validates against the shared createRunInput; stub it so the
  // date-filter suite (GET-only) never trips run-create validation.
  createRunInput: { safeParse: () => ({ success: true, data: {} }) },
}))
// 保留真实 shared 的其它导出（runs.ts 现在经 materializer 依赖 ATTACHMENT_* 常量），
// 只覆盖上面这个 schema。
vi.mock('@a2wave/shared', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  ...sharedMock,
}))

import runsApp from '../runs.js'

function makeChain() {
  const c: Record<string, ReturnType<typeof vi.fn>> = {}
  for (const k of [
    'from',
    'where',
    'leftJoin',
    'orderBy',
    'limit',
    'offset',
    'values',
    'returning',
    'set',
    'groupBy',
    'having',
  ]) {
    c[k] = vi.fn((): unknown => __chain)
  }
  c.get = vi.fn()
  c.all = vi.fn()
  c.run = vi.fn()

  // Awaiting the chain yields what `.get()`/`.all()` was configured to return,
  // as an array — production code destructures `[row]` from `.limit(1)` now.
  // The original mock fns stay reachable, so existing assertions are unaffected.
  let __settled: Promise<unknown[]> | undefined
  const __rows = (): unknown[] => {
    // `get` before `all`: mocks often define both, with `all` a placeholder.
    const get = c.get as undefined | (() => unknown)
    if (get) {
      const row = get()
      if (row != null) return [row]
    }
    const all = c.all as undefined | (() => unknown)
    if (all) {
      const v = all()
      return Array.isArray(v) ? v : v == null ? [] : [v]
    }
    if (get) return []
    const run = c.run as undefined | (() => unknown)
    if (run) {
      const res = run() as { changes?: number } | undefined
      const changes = typeof res?.changes === 'number' ? res.changes : 1
      return Array.from({ length: changes }, () => ({}))
    }
    return []
  }
  const __chain = Object.assign(
    {
      // Lazy: resolving eagerly would consume a queued `get` per intermediate
      // node while the chain is still being built.
      // biome-ignore lint/suspicious/noThenProperty: intentionally a thenable — it stands in for drizzle's awaitable query builder.
      then: (f?: (v: unknown[]) => unknown, r?: (e: unknown) => unknown) => {
        __settled ??= Promise.resolve().then(__rows)
        return __settled.then(f, r)
      },
      catch: (r?: (e: unknown) => unknown) => {
        __settled ??= Promise.resolve().then(__rows)
        return __settled.catch(r)
      },
    },
    c,
  )
  for (const k of Object.keys(c)) {
    const fn = c[k] as unknown
    if (typeof fn === 'function' && !['get', 'all', 'run'].includes(k)) {
      ;(__chain as Record<string, unknown>)[k] = fn
    }
  }
  return __chain as unknown as typeof c
}

function queueSelects(...returns: Array<{ get?: unknown; all?: unknown }>) {
  let i = 0
  dbSelect.mockImplementation(() => {
    const cfg = returns[i++] ?? {}
    const c = makeChain()
    if ('get' in cfg) c.get.mockReturnValue(cfg.get)
    if ('all' in cfg) c.all.mockReturnValue(cfg.all)
    return c
  })
}

beforeEach(() => {
  dbSelect.mockReset()
  dbInsert.mockReset().mockImplementation(() => makeChain())
  dbUpdate.mockReset().mockImplementation(() => makeChain())
})

afterEach(() => {
  vi.restoreAllMocks()
})

function buildApp() {
  return new Hono().route('/runs', runsApp)
}

describe('GET /runs — date filter', () => {
  it('rejects an invalid startDate', async () => {
    const res = await buildApp().request('/runs?startDate=not-a-date')
    expect(res.status).toBe(400)
    expect(((await res.json()) as any).error).toBe('Invalid startDate')
  })

  it('rejects an invalid endDate', async () => {
    const res = await buildApp().request('/runs?endDate=garbage')
    expect(res.status).toBe(400)
    expect(((await res.json()) as any).error).toBe('Invalid endDate')
  })

  it('accepts valid ISO startDate and endDate', async () => {
    queueSelects({ get: { count: 0 } }, { all: [] })
    const res = await buildApp().request(
      '/runs?startDate=2025-01-01T00:00:00Z&endDate=2025-12-31T23:59:59Z',
    )
    expect(res.status).toBe(200)
  })

  it('respects agentId filter', async () => {
    queueSelects({ get: { count: 0 } }, { all: [] })
    const res = await buildApp().request('/runs?agentId=agt_1')
    expect(res.status).toBe(200)
  })
})
