/**
 * Real-SQLite tests for taskQueueDb dangling-sweep SQL.
 *
 * Mock-based tests can't catch SQL semantic bugs like
 * `NOT EXISTS (... WHERE id = NULL)` always being true. Spin up an in-memory
 * SQLite, apply a minimal schema, and exercise the actual queries.
 */
import BetterSqlite3 from 'better-sqlite3'
import { drizzle } from 'drizzle-orm/better-sqlite3'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import * as schema from '../../db/schema.js'

let testDb: ReturnType<typeof drizzle> | null = null
let testSqlite: BetterSqlite3.Database | null = null

vi.mock('../../db/client.js', () => ({
  get db() {
    return testDb
  },
}))

vi.mock('../../lib/logger.js', () => ({
  logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() },
}))

beforeEach(() => {
  testSqlite = new BetterSqlite3(':memory:')
  // Minimal CREATE TABLE matching only the columns the dangling queries touch —
  // avoids running the full migration set. We INSERT via raw SQL below to dodge
  // drizzle's "fill every schema column" insert behavior.
  testSqlite.exec(`
    CREATE TABLE agents (
      id TEXT PRIMARY KEY NOT NULL,
      name TEXT NOT NULL DEFAULT ''
    );
    CREATE TABLE runs (
      id TEXT PRIMARY KEY NOT NULL,
      intent TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'pending',
      result TEXT,
      trigger_source TEXT,
      trigger_session_id TEXT,
      initiator_agent_id TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      user_id TEXT
    );
  `)
  testDb = drizzle(testSqlite, { schema })
})

type SeedRun = {
  id: string
  status: 'pending' | 'queued'
  initiator_agent_id: string | null
  created_at_offset_ms?: number
}

function seedRuns(rows: SeedRun[]): void {
  if (!testSqlite) throw new Error('testSqlite not initialised')
  const stmt = testSqlite.prepare(
    'INSERT INTO runs (id, intent, status, initiator_agent_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)',
  )
  const nowSec = Math.floor(Date.now() / 1000)
  for (const r of rows) {
    // Drizzle's `mode: 'timestamp'` stores Unix seconds, not ms.
    const tsSec = nowSec - Math.floor((r.created_at_offset_ms ?? 60_000) / 1000)
    stmt.run(r.id, 'test', r.status, r.initiator_agent_id, tsSec, tsSec)
  }
}

function seedAgent(id: string): void {
  if (!testSqlite) throw new Error('testSqlite not initialised')
  testSqlite.prepare('INSERT INTO agents (id, name) VALUES (?, ?)').run(id, 'a')
}

describe('taskQueueDb.getDanglingPendingRuns (real SQLite)', () => {
  it('returns rows whose initiator_agent_id points to a deleted agent', async () => {
    const { taskQueueDb } = await import('../task-queue-db.js')
    seedAgent('agt_alive')
    seedRuns([
      { id: 'run_dead', status: 'pending', initiator_agent_id: 'agt_dead' },
      { id: 'run_alive', status: 'pending', initiator_agent_id: 'agt_alive' },
    ])

    const result = await taskQueueDb.getDanglingPendingRuns(Date.now())

    expect(result.map((r) => r.id)).toEqual(['run_dead'])
  })

  it('does NOT sweep pending runs with NULL initiator_agent_id (legitimate "execute later" state)', async () => {
    const { taskQueueDb } = await import('../task-queue-db.js')
    seedRuns([
      {
        id: 'run_unassigned',
        status: 'pending',
        initiator_agent_id: null,
        created_at_offset_ms: 5 * 60_000,
      },
    ])

    const result = await taskQueueDb.getDanglingPendingRuns(Date.now())

    expect(result).toEqual([])
  })

  it('respects the cutoff for deleted-agent rows (recent rows are kept)', async () => {
    const { taskQueueDb } = await import('../task-queue-db.js')
    seedRuns([
      {
        id: 'run_recent',
        status: 'pending',
        initiator_agent_id: 'agt_dead',
        created_at_offset_ms: 0,
      },
    ])

    // Cutoff in the past — rows newer than cutoff are excluded
    const result = await taskQueueDb.getDanglingPendingRuns(Date.now() - 60_000)

    expect(result).toEqual([])
  })
})

describe('taskQueueDb.getDanglingQueuedRuns (real SQLite)', () => {
  it('returns queued rows pointing to a deleted agent', async () => {
    const { taskQueueDb } = await import('../task-queue-db.js')
    seedAgent('agt_alive')
    seedRuns([
      { id: 'run_queued_dead', status: 'queued', initiator_agent_id: 'agt_dead' },
      { id: 'run_queued_alive', status: 'queued', initiator_agent_id: 'agt_alive' },
    ])

    const result = await taskQueueDb.getDanglingQueuedRuns()

    expect(result.map((r) => r.id)).toEqual(['run_queued_dead'])
  })

  it('does NOT sweep NULL-agent queued rows (manual DB edit; leave alone)', async () => {
    const { taskQueueDb } = await import('../task-queue-db.js')
    seedRuns([{ id: 'run_queued_null', status: 'queued', initiator_agent_id: null }])

    const result = await taskQueueDb.getDanglingQueuedRuns()

    expect(result).toEqual([])
  })
})
