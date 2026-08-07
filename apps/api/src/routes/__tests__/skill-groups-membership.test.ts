/**
 * Covers PATCH skill-membership rearrangement and DELETE-agent-ref cleanup in
 * skill-groups, plus the not-found branch in GET /:id/skills.
 */
import { Hono } from 'hono'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { dbSelect, txState, txChain, txMock } = vi.hoisted(() => {
  const dbSelect = vi.fn()
  const txState = {
    insertRun: vi.fn(),
    updateRun: vi.fn(),
    deleteRun: vi.fn(),
    selectAll: vi.fn(),
    updateReturningGet: vi.fn(),
  }
  const txChain = {
    insert: () => ({
      values: vi.fn().mockReturnValue(
        asyncQuery({
          run: txState.insertRun,
          returning: () => asyncQuery({ get: vi.fn(() => ({ id: 'skg_new' })) }),
        }),
      ),
    }),
    update: () => ({
      set: vi.fn().mockReturnValue(
        asyncQuery({
          where: vi.fn().mockReturnValue(
            asyncQuery({
              run: txState.updateRun,
              returning: () => asyncQuery({ get: txState.updateReturningGet }),
            }),
          ),
        }),
      ),
    }),
    delete: () => ({
      where: vi.fn().mockReturnValue(asyncQuery({ run: txState.deleteRun })),
    }),
    select: vi.fn(),
  }
  const txMock = vi.fn().mockImplementation((cb: (tx: typeof txChain) => unknown) => cb(txChain))
  return { dbSelect, txState, txChain, txMock }
})

vi.mock('../../db/client.js', () => ({
  db: {
    select: (...a: unknown[]) => dbSelect(...a),
    transaction: txMock,
  },
  // `db/transaction.js` reads these to pick a backend. Reporting PostgreSQL
  // routes withTransaction() through the mocked `transaction` above, so the
  // callback receives the `tx` stub this suite asserts on; the SQLite branch
  // would instead pass the shared `db` and BEGIN on a real handle.
  dialect: 'postgres',
  isPostgres: true,
  sqliteDatabase: null,
}))

vi.mock('../../db/schema.js', () => ({
  skills: { id: 'skills.id', groupId: 'skills.groupId', userId: 'skills.userId' },
  skillGroups: {
    id: 'skillGroups.id',
    userId: 'skillGroups.userId',
    createdAt: 'skillGroups.createdAt',
  },
  agents: { id: 'agents.id', skillGroupIds: 'agents.skillGroupIds' },
}))

vi.mock('../../lib/audit.js', () => ({ logAudit: vi.fn() }))
vi.mock('../../lib/id.js', () => ({ createId: vi.fn(() => 'skg_new') }))
vi.mock('../../lib/owner-filter.js', () => ({
  getOwnerFilter: vi.fn(() => undefined),
  getCurrentUserId: vi.fn(() => 'usr_test'),
}))

vi.mock('@a2wave/shared', () => ({
  createSkillGroupInput: { safeParse: () => ({ success: true, data: {} }) },
  updateSkillGroupInput: {
    safeParse: (body: unknown) => ({ success: true, data: body }),
  },
}))

import skillGroupsApp from '../skill-groups.js'

import { asyncQuery } from '../../test/async-query.js'

function makeChain() {
  const c: Record<string, ReturnType<typeof vi.fn>> = {}
  for (const k of [
    'from',
    'where',
    'limit',
    'orderBy',
    'offset',
    'groupBy',
    'having',
    'returning',
  ]) {
    c[k] = vi.fn((): unknown => __chain)
  }
  c.get = vi.fn()
  c.all = vi.fn()

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
  txMock.mockClear()
  txState.insertRun.mockClear()
  txState.updateRun.mockClear()
  txState.deleteRun.mockClear()
  txState.selectAll.mockReset()
  txState.updateReturningGet.mockReset().mockReturnValue({ id: 'skg_1', name: 'updated' })
  txChain.select.mockImplementation(() =>
    asyncQuery({
      from: () =>
        asyncQuery({
          where: () => asyncQuery({ all: txState.selectAll }),
          all: txState.selectAll, // DELETE handler calls .all() without where()
        }),
    }),
  )
})

afterEach(() => {
  vi.restoreAllMocks()
})

function buildApp() {
  return new Hono().route('/skill-groups', skillGroupsApp)
}

describe('GET /skill-groups/:id/skills', () => {
  it('returns 404 when group is missing', async () => {
    queueSelects({ get: undefined })
    const res = await buildApp().request('/skill-groups/skg_x/skills')
    expect(res.status).toBe(404)
    expect(((await res.json()) as any).error).toBe('Skill group not found')
  })
})

describe('PATCH /skill-groups/:id — skillIds membership rearrangement', () => {
  it('releases members no longer in the list and reassigns the new set', async () => {
    queueSelects(
      { get: { id: 'skg_1', name: 'g' } }, // existing
      // visible-skills filter inside filterVisibleSkillIds → returns ids 1,2
      { all: [{ id: 'skl_1' }, { id: 'skl_2' }] },
    )
    txState.selectAll.mockReturnValue([{ id: 'skl_old' }, { id: 'skl_1' }])

    const res = await buildApp().request('/skill-groups/skg_1', {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'g', skillIds: ['skl_1', 'skl_2'] }),
    })
    expect(res.status).toBe(200)
    // Two updates inside the tx: release old, assign new
    expect(txState.updateRun).toHaveBeenCalledTimes(2)
  })

  it('only assigns when there are no stale members to release', async () => {
    queueSelects({ get: { id: 'skg_1' } }, { all: [{ id: 'skl_1' }] })
    txState.selectAll.mockReturnValue([])

    await buildApp().request('/skill-groups/skg_1', {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ skillIds: ['skl_1'] }),
    })
    expect(txState.updateRun).toHaveBeenCalledTimes(1)
  })
})

describe('DELETE /skill-groups/:id — agent ref cleanup', () => {
  it('clears the group id from any agent that referenced it', async () => {
    queueSelects({ get: { id: 'skg_1' } })
    txState.selectAll.mockReturnValue([
      { id: 'agt_1', skillGroupIds: ['skg_1', 'skg_other'] },
      { id: 'agt_2', skillGroupIds: ['skg_other'] }, // not affected
      { id: 'agt_3', skillGroupIds: null }, // not affected
    ])

    const res = await buildApp().request('/skill-groups/skg_1', { method: 'DELETE' })
    expect(res.status).toBe(200)
    // Inside tx: release members + delete group + 1 agent update
    expect(txState.updateRun).toHaveBeenCalledTimes(2) // release members + 1 agent
    expect(txState.deleteRun).toHaveBeenCalledTimes(1)
  })
})
