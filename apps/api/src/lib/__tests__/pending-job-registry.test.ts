import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  __resetPendingRegistriesForTest,
  registerPendingContext,
  registerPendingJob,
  sweepPendingContexts,
  takePendingContext,
  takePendingJob,
} from '../pending-job-registry.js'

describe('pending-job-registry', () => {
  it('should return undefined for unknown runId', async () => {
    expect(takePendingJob('run_unknown')).toBeUndefined()
  })

  it('should register and take a pending job', async () => {
    const fn = async () => {}
    registerPendingJob('run_1', fn)
    expect(takePendingJob('run_1')).toBe(fn)
  })

  it('should delete the job after take (destructive)', async () => {
    const fn = async () => {}
    registerPendingJob('run_2', fn)
    expect(takePendingJob('run_2')).toBe(fn)
    expect(takePendingJob('run_2')).toBeUndefined()
  })

  it('should allow overwriting a registered job', async () => {
    const fn1 = async () => {}
    const fn2 = async () => {}
    registerPendingJob('run_3', fn1)
    registerPendingJob('run_3', fn2)
    expect(takePendingJob('run_3')).toBe(fn2)
  })

  it('should handle multiple independent jobs', async () => {
    const fnA = async () => {}
    const fnB = async () => {}
    registerPendingJob('run_a', fnA)
    registerPendingJob('run_b', fnB)

    expect(takePendingJob('run_a')).toBe(fnA)
    expect(takePendingJob('run_b')).toBe(fnB)
    expect(takePendingJob('run_a')).toBeUndefined()
    expect(takePendingJob('run_b')).toBeUndefined()
  })
})

describe('pending-context-registry', () => {
  it('returns undefined for unknown runId', async () => {
    expect(takePendingContext('ctx_unknown')).toBeUndefined()
  })

  it('registers and takes a context', async () => {
    const ctx = { caller: { type: 'client', idaasUser: { sub: 'u-1', issuer: 'i' } } }
    registerPendingContext('ctx_1', ctx)
    expect(takePendingContext('ctx_1')).toEqual(ctx)
  })

  it('is destructive on take (single-shot)', async () => {
    registerPendingContext('ctx_2', { foo: 'bar' })
    expect(takePendingContext('ctx_2')).toEqual({ foo: 'bar' })
    expect(takePendingContext('ctx_2')).toBeUndefined()
  })

  it('does not interfere with pending-job registry sharing the same key', async () => {
    const fn = async () => {}
    registerPendingJob('shared_id', fn)
    registerPendingContext('shared_id', { k: 1 })
    expect(takePendingJob('shared_id')).toBe(fn)
    expect(takePendingContext('shared_id')).toEqual({ k: 1 })
  })
})

describe('sweepPendingContexts (TTL leak defense)', () => {
  beforeEach(() => {
    __resetPendingRegistriesForTest()
  })

  afterEach(() => {
    vi.useRealTimers()
    __resetPendingRegistriesForTest()
  })

  it('does not sweep fresh entries', async () => {
    registerPendingContext('ctx_fresh', { foo: 'bar' })
    const removed = sweepPendingContexts(60_000)
    expect(removed).toBe(0)
    expect(takePendingContext('ctx_fresh')).toEqual({ foo: 'bar' })
  })

  it('sweeps entries older than maxAgeMs and makes them unretrievable', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-04-21T00:00:00Z'))
    registerPendingContext('ctx_old', { stale: true })

    // Advance beyond TTL
    vi.setSystemTime(new Date('2026-04-21T02:00:00Z'))
    const removed = sweepPendingContexts(60 * 60 * 1000)
    expect(removed).toBe(1)
    expect(takePendingContext('ctx_old')).toBeUndefined()
  })

  it('sweeps only the stale entries and leaves fresh ones intact', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-04-21T00:00:00Z'))
    registerPendingContext('ctx_old_1', { a: 1 })
    registerPendingContext('ctx_old_2', { b: 2 })

    vi.setSystemTime(new Date('2026-04-21T02:00:00Z'))
    registerPendingContext('ctx_new', { c: 3 })

    const removed = sweepPendingContexts(60 * 60 * 1000)
    expect(removed).toBe(2)
    expect(takePendingContext('ctx_old_1')).toBeUndefined()
    expect(takePendingContext('ctx_old_2')).toBeUndefined()
    expect(takePendingContext('ctx_new')).toEqual({ c: 3 })
  })
})
