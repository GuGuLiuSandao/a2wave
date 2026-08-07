import { Hono } from 'hono'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const dbGet = vi.fn()
vi.mock('../../db/client.js', () => ({
  db: {
    select: () => ({
      from: () => asyncQuery({ get: dbGet }),
    }),
  },
}))

vi.mock('../../db/schema.js', () => ({
  runs: { id: 'runs.id' },
}))

const healthCheckAll = vi.fn()
vi.mock('../../engine/index.js', () => ({
  engineRegistry: { healthCheckAll: () => healthCheckAll() },
}))

vi.mock('../../env.js', () => ({
  env: {
    DATABASE_URL: './data/a2wave.db',
    A2WAVE_SKILLS_STORAGE: './data/skills',
  },
}))

const accessSyncMock = vi.fn()
vi.mock('node:fs', async () => {
  const actual = await vi.importActual<typeof import('node:fs')>('node:fs')
  return {
    ...actual,
    accessSync: (...args: unknown[]) => accessSyncMock(...args),
    constants: { W_OK: 2 },
  }
})

const execSyncMock = vi.fn()
vi.mock('node:child_process', async () => {
  const actual = await vi.importActual<typeof import('node:child_process')>('node:child_process')
  return {
    ...actual,
    execSync: (...args: unknown[]) => execSyncMock(...args),
  }
})

import health from '../health.js'

import { asyncQuery } from '../../test/async-query.js'

beforeEach(() => {
  dbGet.mockReset()
  healthCheckAll.mockReset()
  accessSyncMock.mockReset()
  execSyncMock.mockReset()
  delete process.env.APP_VERSION
})

afterEach(() => {
  vi.restoreAllMocks()
})

function buildApp() {
  return new Hono().route('/health', health)
}

describe('routes/health', () => {
  it('reports status=ok when every check passes', async () => {
    dbGet.mockReturnValue({ count: 7 })
    healthCheckAll.mockResolvedValue({ cursor: true })
    accessSyncMock.mockReturnValue(undefined)
    execSyncMock.mockReturnValue(Buffer.from('v1.2.3\n'))

    const res = await buildApp().request('/health')
    expect(res.status).toBe(200)
    const body = (await res.json()) as any
    expect(body.status).toBe('ok')
    expect(body.version).toBe('v1.2.3')
    expect(body.checks.database).toEqual({ ok: true, tables: 7 })
    expect(body.checks.dataDir.ok).toBe(true)
    expect(body.checks.skillsDir.ok).toBe(true)
    expect(body.checks.engines).toEqual({ cursor: true })
  })

  it('degrades when the database check throws', async () => {
    dbGet.mockImplementation(() => {
      throw new Error('db down')
    })
    healthCheckAll.mockResolvedValue({})
    accessSyncMock.mockReturnValue(undefined)
    execSyncMock.mockImplementation(() => {
      throw new Error('not a git repo')
    })

    const res = await buildApp().request('/health')
    const body = (await res.json()) as any
    expect(body.status).toBe('degraded')
    expect(body.checks.database).toMatchObject({ ok: false, error: 'db down' })
    expect(body.version).toBe('dev')
  })

  it('prefers APP_VERSION env over `git describe`', async () => {
    dbGet.mockReturnValue({ count: 0 })
    healthCheckAll.mockResolvedValue({})
    accessSyncMock.mockReturnValue(undefined)
    process.env.APP_VERSION = '9.9.9'

    const res = await buildApp().request('/health')
    const body = (await res.json()) as any
    expect(body.version).toBe('9.9.9')
    expect(execSyncMock).not.toHaveBeenCalled()
  })

  it('flags disk checks that throw as not writable', async () => {
    dbGet.mockReturnValue({ count: 0 })
    healthCheckAll.mockResolvedValue({})
    accessSyncMock.mockImplementation(() => {
      throw new Error('EACCES')
    })
    execSyncMock.mockReturnValue(Buffer.from('vX'))

    const res = await buildApp().request('/health')
    const body = (await res.json()) as any
    expect(body.status).toBe('degraded')
    expect(body.checks.dataDir).toEqual({ ok: false, writable: false, error: 'Disk check failed' })
    expect(body.checks.skillsDir.ok).toBe(false)
  })
})

/**
 * Liveness vs readiness. `/health` answers "is this process alive" — a failing
 * probe there should restart the pod. Readiness answers "may it receive
 * traffic yet", which is false during the boot window where the port is bound
 * but env-driven settings (SSO config among them) have not been written. A
 * rollout that routes into that window serves a login page with no SSO entry.
 */
describe('routes/health — readiness', () => {
  it('reports 503 not-ready before boot completes', async () => {
    const { resetReadinessForTests } = await import('../../lib/readiness.js')
    resetReadinessForTests()

    const res = await buildApp().request('/health/ready')
    expect(res.status).toBe(503)
    const body = (await res.json()) as { status: string }
    expect(body.status).toBe('starting')
  })

  it('reports 200 ready once boot completes', async () => {
    const { markReady, resetReadinessForTests } = await import('../../lib/readiness.js')
    resetReadinessForTests()
    markReady()

    const res = await buildApp().request('/health/ready')
    expect(res.status).toBe(200)
    const body = (await res.json()) as { status: string }
    expect(body.status).toBe('ready')
  })

  it('keeps liveness independent of readiness', async () => {
    const { resetReadinessForTests } = await import('../../lib/readiness.js')
    resetReadinessForTests()
    dbGet.mockReturnValue({ count: 1 })
    healthCheckAll.mockResolvedValue({})
    accessSyncMock.mockReturnValue(undefined)
    execSyncMock.mockReturnValue(Buffer.from('v1'))

    // Not ready yet, but the process is alive — liveness must still pass, or
    // Kubernetes would kill every pod during its own startup.
    const res = await buildApp().request('/health')
    expect(res.status).toBe(200)
    expect(((await res.json()) as { status: string }).status).toBe('ok')
  })
})
