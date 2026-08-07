import { describe, expect, it, vi } from 'vitest'

const getSetting = vi.hoisted(() => vi.fn())
vi.mock('../settings.js', () => ({ getSetting }))
vi.mock('../../db/client.js', () => ({ db: {} }))
vi.mock('../../db/schema.js', () => ({
  runs: {},
  auditLogs: {},
  artifacts: {},
  artifactShares: {},
}))
vi.mock('../logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}))

import { resolveRetentionPolicy, runDataRetentionSweep } from '../data-retention.js'

describe('resolveRetentionPolicy', () => {
  it('defaults to enabled + 60 days when unset', async () => {
    getSetting.mockReturnValue(undefined)
    expect(await resolveRetentionPolicy()).toEqual({ enabled: true, retentionDays: 60 })
  })

  it('honors an explicit disable', async () => {
    getSetting.mockImplementation((_c: string, k: string) => (k === 'enabled' ? 'false' : '60'))
    expect((await resolveRetentionPolicy()).enabled).toBe(false)
  })

  it('falls back to 60 for a non-positive/NaN retentionDays (never deletes everything)', async () => {
    getSetting.mockImplementation((_c: string, k: string) => (k === 'enabled' ? 'true' : '0'))
    expect((await resolveRetentionPolicy()).retentionDays).toBe(60)
    getSetting.mockImplementation((_c: string, k: string) => (k === 'enabled' ? 'true' : 'abc'))
    expect((await resolveRetentionPolicy()).retentionDays).toBe(60)
  })

  it('reads a custom day count', async () => {
    getSetting.mockImplementation((_c: string, k: string) => (k === 'enabled' ? 'true' : '30'))
    expect((await resolveRetentionPolicy()).retentionDays).toBe(30)
  })
})

describe('runDataRetentionSweep', () => {
  it('deletes nothing when the policy is disabled', async () => {
    const deps = {
      deleteTerminalRunsBefore: vi.fn().mockResolvedValue(5),
      deleteAuditLogsBefore: vi.fn().mockResolvedValue(5),
    }
    const result = await runDataRetentionSweep(
      { enabled: false, retentionDays: 60 },
      new Date(),
      deps,
    )
    expect(result).toEqual({ runs: 0, auditLogs: 0 })
    expect(deps.deleteTerminalRunsBefore).not.toHaveBeenCalled()
  })

  it('computes the cutoff as now - retentionDays and reports deleted counts', async () => {
    const now = new Date('2026-03-01T00:00:00.000Z')
    const expectedCutoff = new Date('2026-01-30T00:00:00.000Z') // 30 days earlier
    let seenRunCutoff: Date | undefined
    const deps = {
      deleteTerminalRunsBefore: vi.fn(async (c: Date) => {
        seenRunCutoff = c
        return 3
      }),
      deleteAuditLogsBefore: vi.fn().mockResolvedValue(7),
    }

    const result = await runDataRetentionSweep({ enabled: true, retentionDays: 30 }, now, deps)

    expect(seenRunCutoff?.toISOString()).toBe(expectedCutoff.toISOString())
    expect(result).toEqual({ runs: 3, auditLogs: 7 })
  })

  it('forwards `now` to deleteTerminalRunsBefore (used for active-share exclusion)', async () => {
    const now = new Date('2026-03-01T12:00:00.000Z')
    let seenNow: Date | undefined
    const deps = {
      deleteTerminalRunsBefore: vi.fn(async (_c: Date, n?: Date) => {
        seenNow = n
        return 0
      }),
      deleteAuditLogsBefore: vi.fn().mockResolvedValue(0),
    }

    await runDataRetentionSweep({ enabled: true, retentionDays: 30 }, now, deps)

    expect(seenNow?.toISOString()).toBe(now.toISOString())
  })
})
