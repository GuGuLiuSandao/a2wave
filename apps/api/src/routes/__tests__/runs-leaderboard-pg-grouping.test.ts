/**
 * PostgreSQL rejects a SELECT/ORDER BY column that is neither grouped nor
 * aggregated; SQLite silently picks an arbitrary row. The leaderboard queries
 * project `agents.name` / `agents.icon` while grouping only by
 * `runs.initiator_agent_id`, so all three returned 500 on PostgreSQL and 200 on
 * SQLite:
 *
 *   column "agents.name" must appear in the GROUP BY clause
 *   or be used in an aggregate function
 *
 * The leaderboard cases in runs.test.ts mock the Drizzle chain, so no SQL is
 * ever generated and the dialect difference is invisible to them — which is why
 * they stayed green while the endpoint was broken in production.
 *
 * This suite drives the real handler and inspects the column references it
 * actually passes to `.groupBy()`, so it fails whenever a projected agent
 * column is left ungrouped.
 */
import { Hono } from 'hono'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { asyncQuery } from '../../test/async-query.js'

const mockDb = vi.hoisted(() => ({ select: vi.fn() }))
vi.mock('../../db/client.js', () => ({
  db: mockDb,
  dialect: 'sqlite',
  isPostgres: false,
  sqliteDatabase: { inTransaction: false, exec: vi.fn() },
}))

vi.mock('../../lib/logger.js', () => ({
  logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() },
}))

vi.mock('../../lib/audit.js', () => ({ logAudit: vi.fn() }))
vi.mock('../../lib/owner-filter.js', () => ({
  getCurrentUserId: vi.fn().mockReturnValue(undefined),
}))
vi.mock('../../lib/agent-access.js', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  getRunReadFilter: vi.fn(() => undefined),
}))

/** Columns the leaderboard rows expose beyond the grouping key. */
const PROJECTED_AGENT_COLUMNS = ['name', 'icon'] as const

/**
 * Capture the arguments of every `.groupBy()` the handler issues, alongside the
 * projection it selected, so each query can be checked independently.
 */
function makeCapturingChain() {
  const calls: Array<{ select: Record<string, unknown>; groupBy: unknown[] }> = []
  let current: { select: Record<string, unknown>; groupBy: unknown[] } | null = null

  const node: Record<string, unknown> = {}
  for (const key of ['from', 'innerJoin', 'where', 'orderBy', 'having', 'limit']) {
    node[key] = vi.fn(() => awaitable)
  }
  node.groupBy = vi.fn((...args: unknown[]) => {
    if (current) current.groupBy = args
    return awaitable
  })
  node.all = vi.fn(() => [])
  const awaitable = asyncQuery(node)

  mockDb.select.mockImplementation((projection: Record<string, unknown>) => {
    current = { select: projection, groupBy: [] }
    calls.push(current)
    return awaitable
  })

  return calls
}

/**
 * Render a captured column reference to its qualified SQL name. Comparing
 * rendered SQL (rather than object identity) keeps the assertion meaningful
 * even if the handler passes an equivalent-but-distinct column object.
 */
async function renderColumn(column: unknown): Promise<string> {
  const { PgDialect } = await import('drizzle-orm/pg-core')
  const { sql } = await import('drizzle-orm')
  return new PgDialect().sqlToQuery(sql`${column as never}`).sql
}

describe('GET /runs/leaderboard groups every agent column it projects', () => {
  let app: Hono

  beforeEach(async () => {
    vi.clearAllMocks()
    const mod = await import('../runs.js')
    app = new Hono().route('/runs', mod.default)
  })

  it('emits PostgreSQL-valid GROUP BY for byRuns, byUsers and byTokens', async () => {
    const calls = makeCapturingChain()

    const res = await app.request('/runs/leaderboard')
    expect(res.status).toBe(200)

    // byRuns / byUsers / byTokens — every leaderboard query joins agents.
    expect(calls).toHaveLength(3)

    for (const [index, call] of calls.entries()) {
      const grouped = await Promise.all(call.groupBy.map(renderColumn))

      for (const column of PROJECTED_AGENT_COLUMNS) {
        const projected = call.select[column]
        expect(projected, `query #${index + 1} should project agents.${column}`).toBeDefined()

        const rendered = await renderColumn(projected)
        expect(
          grouped,
          `query #${index + 1}: PostgreSQL rejects ungrouped ${rendered} in the projection`,
        ).toContain(rendered)
      }
    }
  })
})
