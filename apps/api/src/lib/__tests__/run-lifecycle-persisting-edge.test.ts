/**
 * Edge-case coverage for createPersistingLogCollector that
 * run-lifecycle-persisting.test.ts doesn't reach:
 *   - DB write failure → catches and emits the warn
 *   - MAX_STREAM_LOGS truncation marker (type/subtype/ts shape)
 *   - log entry rejected after stop()
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { runMock, setMock, whereMock, updateMock, loggerMock } = vi.hoisted(() => {
  const runMock = vi.fn()
  const whereMock = vi.fn((..._args: unknown[]) => asyncQuery({ run: runMock }))
  const setMock = vi.fn((..._args: unknown[]) => ({ where: whereMock }))
  const updateMock = vi.fn((..._args: unknown[]) => ({ set: setMock }))
  return {
    runMock,
    setMock,
    whereMock,
    updateMock,
    loggerMock: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
  }
})

vi.mock('../../db/client.js', () => ({
  db: {
    update: (...args: unknown[]) => updateMock(...(args as [])),
    select: vi.fn(),
    insert: vi.fn(),
    delete: vi.fn(),
  },
}))

vi.mock('../logger.js', () => ({ logger: loggerMock }))

import { MAX_STREAM_LOGS, createPersistingLogCollector } from '../run-lifecycle.js'

import { asyncQuery } from '../../test/async-query.js'

/**
 * Settle the final flush that `stop()` kicks off.
 *
 * `stop()` starts its last `writeNow()` without awaiting it, and the DB write inside
 * is itself awaited, so the terminator call lands a few microtasks after `stop()`
 * resolves. Draining the queue here is what makes the write-count assertions compare
 * two settled states rather than one settled and one still in flight.
 */
async function settleFinalFlush(): Promise<void> {
  for (let i = 0; i < 20; i++) await Promise.resolve()
}

beforeEach(() => {
  vi.useFakeTimers()
  runMock.mockReset()
  setMock.mockClear()
  whereMock.mockClear()
  updateMock.mockClear()
  loggerMock.warn.mockClear()
})

afterEach(() => {
  vi.useRealTimers()
})

describe('createPersistingLogCollector — error swallowing', () => {
  it('catches DB write errors and logs warn instead of crashing the run', async () => {
    runMock.mockImplementation(() => {
      throw new Error('disk full')
    })
    const collector = createPersistingLogCollector({
      stepId: 'step_err',
      baseOutput: {},
      debounceMs: 10,
    })
    collector.onLogEntry({ type: 'assistant', text: 'hello', ts: 1 })
    await vi.advanceTimersByTimeAsync(10)
    // Trigger another flush via stop() which also exercises the catch
    await collector.stop()

    expect(loggerMock.warn).toHaveBeenCalledWith(
      expect.objectContaining({ stepId: 'step_err' }),
      'Persisting log flush failed',
    )
  })
})

describe('createPersistingLogCollector — truncation marker', () => {
  it('appends exactly one marker { type:"system", subtype:"truncated" } after the limit', async () => {
    const collector = createPersistingLogCollector({
      stepId: 'step_trunc',
      baseOutput: {},
      debounceMs: 0,
    })

    // Push MAX_STREAM_LOGS + 3 entries — only MAX_STREAM_LOGS entries should
    // remain in the buffer, plus exactly one truncation marker.
    for (let i = 0; i < MAX_STREAM_LOGS + 3; i++) {
      collector.onLogEntry({ type: 'assistant', text: `e${i}`, ts: i })
    }
    await vi.advanceTimersByTimeAsync(1)
    await collector.stop()

    const lastSetCall = setMock.mock.calls.at(-1)![0] as { output: { logs: unknown[] } }
    const logs = lastSetCall.output.logs
    expect(logs).toHaveLength(MAX_STREAM_LOGS + 1)
    const marker = logs[MAX_STREAM_LOGS] as { type: string; subtype: string; ts: number }
    expect(marker.type).toBe('system')
    expect(marker.subtype).toBe('truncated')
    expect(typeof marker.ts).toBe('number')
  })
})

describe('createPersistingLogCollector — stop() idempotency', () => {
  it('calling stop() twice does not flush twice', async () => {
    runMock.mockClear()
    const collector = createPersistingLogCollector({
      stepId: 'step_stop',
      baseOutput: {},
      debounceMs: 50,
    })
    collector.onLogEntry({ type: 'assistant', text: 'x', ts: 0 })
    await collector.stop()
    await settleFinalFlush()
    const writesAfterFirstStop = runMock.mock.calls.length
    await collector.stop()
    await settleFinalFlush()
    expect(runMock.mock.calls.length).toBe(writesAfterFirstStop)
  })

  it('onLogEntry after stop() is ignored — buffer length stays the same', async () => {
    const collector = createPersistingLogCollector({
      stepId: 'step_ignore',
      baseOutput: {},
      debounceMs: 50,
    })
    collector.onLogEntry({ type: 'assistant', text: 'pre', ts: 0 })
    await collector.stop()
    const callsBefore = setMock.mock.calls.length

    collector.onLogEntry({ type: 'assistant', text: 'post', ts: 1 })
    await vi.advanceTimersByTimeAsync(1000)
    expect(setMock.mock.calls.length).toBe(callsBefore)
  })
})

describe('createPersistingLogCollector — baseOutput preservation', () => {
  it('every flush carries baseOutput fields verbatim + the accumulating logs', async () => {
    const collector = createPersistingLogCollector({
      stepId: 'step_base',
      baseOutput: { result: { exitCode: 0 }, customField: 'keep me' },
      debounceMs: 5,
    })
    collector.onLogEntry({ type: 'assistant', text: 'one', ts: 1 })
    await vi.advanceTimersByTimeAsync(5)
    collector.onLogEntry({ type: 'assistant', text: 'two', ts: 2 })
    await vi.advanceTimersByTimeAsync(5)
    await collector.stop()

    const everySetCallPreservesBase = setMock.mock.calls.every((call) => {
      const payload = call[0] as {
        output: {
          result?: { exitCode?: number }
          customField?: string
          logs: unknown[]
        }
      }
      return payload.output.customField === 'keep me' && payload.output.result?.exitCode === 0
    })
    expect(everySetCallPreservesBase).toBe(true)
  })
})
