import { Hono } from 'hono'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { asyncQuery } from '../../test/async-query.js'

const totalGet = vi.fn()
const dataAll = vi.fn()
/** Captures the where clause so date filtering can be asserted, not just survived. */
const whereCalls: unknown[] = []
// Each node is built fresh: an awaitable node memoises the rows it resolved to,
// so reusing one singleton across requests would replay the first test's data.
const dataChain = (): Record<string, unknown> =>
  asyncQuery({
    from: () => dataChain(),
    leftJoin: () => dataChain(),
    where: (clause: unknown) => {
      whereCalls.push(clause)
      return dataChain()
    },
    orderBy: () => dataChain(),
    limit: () => dataChain(),
    offset: () => dataChain(),
    all: dataAll,
  })
const totalChain = (): Record<string, unknown> =>
  asyncQuery({
    from: () => totalChain(),
    where: () => totalChain(),
    // `.limit(1)` is how the count row is fetched now; resolve it from `get`
    // alone so a mocked `undefined` stays an empty result set.
    limit: () => asyncQuery({ get: totalGet }),
    get: totalGet,
  })

const selectMock = vi.fn()
vi.mock('../../db/client.js', () => ({
  db: {
    select: (...args: unknown[]) => selectMock(...args),
  },
}))

vi.mock('../../db/schema.js', () => ({
  auditLogs: {
    id: 'auditLogs.id',
    userId: 'auditLogs.userId',
    action: 'auditLogs.action',
    resource: 'auditLogs.resource',
    resourceId: 'auditLogs.resourceId',
    details: 'auditLogs.details',
    ipAddress: 'auditLogs.ipAddress',
    createdAt: 'auditLogs.createdAt',
  },
  users: { id: 'users.id', username: 'users.username' },
}))

import auditLogs from '../audit-logs.js'

beforeEach(() => {
  selectMock.mockReset()
  totalGet.mockReset()
  dataAll.mockReset()
  whereCalls.length = 0

  // First select() call -> count chain; subsequent -> data chain.
  let call = 0
  selectMock.mockImplementation(() => {
    call += 1
    return call === 1 ? totalChain() : dataChain()
  })
})

afterEach(() => {
  vi.restoreAllMocks()
})

function buildApp() {
  return new Hono().route('/audit-logs', auditLogs)
}

describe('routes/audit-logs', () => {
  it('returns paginated rows with default page/pageSize', async () => {
    totalGet.mockReturnValue({ count: 3 })
    dataAll.mockReturnValue([
      { id: 'aud_1', userId: 'usr_1', action: 'create', resource: 'agent' },
      { id: 'aud_2', userId: 'usr_2', action: 'delete', resource: 'skill' },
    ])

    const res = await buildApp().request('/audit-logs')
    expect(res.status).toBe(200)
    const body = (await res.json()) as any
    expect(body.data).toHaveLength(2)
    expect(body.pagination).toEqual({ total: 3, page: 1, pageSize: 20, totalPages: 1 })
  })

  it('clamps pageSize to the [1, 100] range', async () => {
    totalGet.mockReturnValue({ count: 0 })
    dataAll.mockReturnValue([])
    const res = await buildApp().request('/audit-logs?page=2&pageSize=500')
    const body = (await res.json()) as any
    expect(body.pagination.pageSize).toBe(100)
    expect(body.pagination.page).toBe(2)
  })

  it('treats malformed numbers as defaults', async () => {
    totalGet.mockReturnValue({ count: 5 })
    dataAll.mockReturnValue([])
    const res = await buildApp().request('/audit-logs?page=abc&pageSize=xyz')
    const body = (await res.json()) as any
    expect(body.pagination.page).toBe(1)
    expect(body.pagination.pageSize).toBe(20)
    expect(body.pagination.totalPages).toBe(1)
  })

  it('accepts filter params without crashing', async () => {
    totalGet.mockReturnValue({ count: 1 })
    dataAll.mockReturnValue([{ id: 'aud_1' }])
    const res = await buildApp().request('/audit-logs?userId=usr_1&action=delete&resource=agent')
    expect(res.status).toBe(200)
    const body = (await res.json()) as any
    expect(body.data).toHaveLength(1)
  })

  it('filters by startDate and endDate', async () => {
    totalGet.mockReturnValue({ count: 1 })
    dataAll.mockReturnValue([{ id: 'aud_1' }])
    const res = await buildApp().request(
      '/audit-logs?startDate=2026-07-01T00:00:00.000Z&endDate=2026-07-29T23:59:59.999Z',
    )
    expect(res.status).toBe(200)
    // Both bounds must reach the query — a silently ignored date range would
    // show the full history while the UI claims it is filtered.
    expect(JSON.stringify(whereCalls)).toContain('createdAt')
    expect(whereCalls.length).toBeGreaterThan(0)
  })

  it('rejects a malformed startDate', async () => {
    totalGet.mockReturnValue({ count: 0 })
    dataAll.mockReturnValue([])
    const res = await buildApp().request('/audit-logs?startDate=not-a-date')
    expect(res.status).toBe(400)
  })

  it('rejects a malformed endDate', async () => {
    totalGet.mockReturnValue({ count: 0 })
    dataAll.mockReturnValue([])
    const res = await buildApp().request('/audit-logs?endDate=13/45/2026')
    expect(res.status).toBe(400)
  })

  it('handles a null totalResult by reporting total=0', async () => {
    totalGet.mockReturnValue(undefined)
    dataAll.mockReturnValue([])
    const res = await buildApp().request('/audit-logs')
    const body = (await res.json()) as any
    expect(body.pagination.total).toBe(0)
    expect(body.pagination.totalPages).toBe(0)
  })
})
