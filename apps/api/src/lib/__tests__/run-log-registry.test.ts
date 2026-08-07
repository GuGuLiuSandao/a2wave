/**
 * Cancel race + collector registry integration.
 *
 * Scenario: a provider is mid-execution, the UI dispatches cancel. The cancel
 * handler MUST drain the persisting collector's pending debounce flush before
 * it writes `status = 'cancelled'`, otherwise a late flush would revert the
 * step output to its pre-cancel shape and the UI would flicker.
 *
 * This test doesn't spin up the HTTP server — it exercises the same
 * collector + registry primitives the cancel handler uses.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const runMock = vi.fn<(...args: unknown[]) => void>()
const whereMock = vi.fn<(...args: unknown[]) => { run: typeof runMock }>(() =>
  asyncQuery({ run: runMock }),
)
const setMock = vi.fn<(...args: unknown[]) => { where: typeof whereMock }>(() => ({
  where: whereMock,
}))
const updateMock = vi.fn<(...args: unknown[]) => { set: typeof setMock }>(() => ({ set: setMock }))

vi.mock('../../db/client.js', () => ({
  db: {
    update: (...args: unknown[]) => updateMock(...args),
    select: vi.fn(),
    insert: vi.fn(),
    delete: vi.fn(),
  },
}))

vi.mock('../logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}))

import { createPersistingLogCollector } from '../run-lifecycle.js'
import {
  __resetForTest,
  registerLogCollector,
  stopLogCollector,
  unregisterLogCollector,
} from '../run-log-registry.js'

import { asyncQuery } from '../../test/async-query.js'

describe('run-log-registry — cancel race', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    runMock.mockClear()
    setMock.mockClear()
    whereMock.mockClear()
    updateMock.mockClear()
    __resetForTest()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('stopLogCollector drains the pending flush before returning', async () => {
    const collector = createPersistingLogCollector({
      stepId: 'step_cancel',
      baseOutput: {},
      debounceMs: 2000,
    })
    registerLogCollector('run_cancel', collector)

    // Three entries buffered, debounce timer armed but not yet fired.
    collector.onLogEntry({ type: 'assistant', text: 'a', ts: 1 })
    collector.onLogEntry({ type: 'assistant', text: 'b', ts: 2 })
    collector.onLogEntry({ type: 'assistant', text: 'c', ts: 3 })
    expect(runMock).not.toHaveBeenCalled()

    // Cancel path calls stopLogCollector(runId). Must flush synchronously.
    await stopLogCollector('run_cancel')
    expect(runMock).toHaveBeenCalled()
    // After flush, the payload contains all 3 entries.
    const lastCall = setMock.mock.calls[setMock.mock.calls.length - 1][0] as {
      output: { logs: unknown[] }
    }
    expect(lastCall.output.logs).toHaveLength(3)

    // No further writes after the registered collector has been drained,
    // even if fake time advances past the original debounce window.
    runMock.mockClear()
    await vi.advanceTimersByTimeAsync(5000)
    expect(runMock).not.toHaveBeenCalled()
  })

  it('late log entries after stopLogCollector are dropped', async () => {
    const collector = createPersistingLogCollector({
      stepId: 'step_late',
      baseOutput: {},
      debounceMs: 500,
    })
    registerLogCollector('run_late', collector)

    await stopLogCollector('run_late')
    runMock.mockClear()

    // Simulate a stream event arriving after cancel — should be ignored.
    collector.onLogEntry({ type: 'assistant', text: 'late', ts: 99 })
    await vi.advanceTimersByTimeAsync(2000)
    expect(runMock).not.toHaveBeenCalled()
    expect(collector.logs).toHaveLength(0)
  })

  it('stopLogCollector on unknown runId is a no-op', async () => {
    await expect(stopLogCollector('not_registered')).resolves.toBeUndefined()
  })

  it('unregisterLogCollector detaches without draining', async () => {
    const collector = createPersistingLogCollector({
      stepId: 'step_unreg',
      baseOutput: {},
      debounceMs: 1000,
    })
    registerLogCollector('run_unreg', collector)
    unregisterLogCollector('run_unreg')

    // After unregister, stopLogCollector for the same id is a no-op.
    await stopLogCollector('run_unreg')
    expect(runMock).not.toHaveBeenCalled()

    // But the collector itself is still usable by whoever holds a reference —
    // unregister does NOT terminate it.
    collector.onLogEntry({ type: 'assistant', text: 'still alive', ts: 1 })
    await vi.advanceTimersByTimeAsync(1000)
    expect(runMock).toHaveBeenCalledTimes(1)
  })

  it('multiple runs register concurrently without collision', async () => {
    const cA = createPersistingLogCollector({ stepId: 'sA', baseOutput: {}, debounceMs: 200 })
    const cB = createPersistingLogCollector({ stepId: 'sB', baseOutput: {}, debounceMs: 200 })
    registerLogCollector('runA', cA)
    registerLogCollector('runB', cB)

    cA.onLogEntry({ type: 'assistant', text: 'A1', ts: 1 })
    cB.onLogEntry({ type: 'assistant', text: 'B1', ts: 1 })

    await stopLogCollector('runA')
    // runA drained, runB still armed; its debounce will fire independently.
    const flushForA = setMock.mock.calls.filter((call) => {
      const arg = call[0] as { output: { logs: Array<{ type: string; text?: string }> } }
      return arg.output.logs.some((l) => l.type === 'assistant' && l.text === 'A1')
    })
    const flushForB = setMock.mock.calls.filter((call) => {
      const arg = call[0] as { output: { logs: Array<{ type: string; text?: string }> } }
      return arg.output.logs.some((l) => l.type === 'assistant' && l.text === 'B1')
    })
    expect(flushForA.length).toBeGreaterThanOrEqual(1)
    expect(flushForB.length).toBe(0)

    await vi.advanceTimersByTimeAsync(200)
    const flushForBAfter = setMock.mock.calls.filter((call) => {
      const arg = call[0] as { output: { logs: Array<{ type: string; text?: string }> } }
      return arg.output.logs.some((l) => l.type === 'assistant' && l.text === 'B1')
    })
    expect(flushForBAfter.length).toBeGreaterThanOrEqual(1)

    await stopLogCollector('runB')
  })
})
