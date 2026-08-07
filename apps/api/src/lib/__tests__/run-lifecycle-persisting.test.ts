import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// Mock the DB client before importing the module under test so the
// `db.update(runSteps).set(...).where(...).run()` chain is observable
// without pulling in drizzle's migration machinery.
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

import { asyncQuery } from '../../test/async-query.js'

/**
 * Settle the final flush that `stop()` kicks off.
 *
 * `stop()` starts its last `writeNow()` without awaiting it, and the DB write inside
 * is itself awaited, so the `.set()`/terminator calls land a few microtasks after
 * `stop()` resolves. Draining the queue here is what makes the assertions observe the
 * completed flush rather than a not-yet-issued one.
 */
async function settleFinalFlush(): Promise<void> {
  for (let i = 0; i < 20; i++) await Promise.resolve()
}

describe('createPersistingLogCollector', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    runMock.mockClear()
    setMock.mockClear()
    whereMock.mockClear()
    updateMock.mockClear()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('defers the first flush until debounceMs elapses', async () => {
    const collector = createPersistingLogCollector({
      stepId: 'step_1',
      baseOutput: {},
      debounceMs: 1000,
    })

    collector.onLogEntry({ type: 'assistant', text: 'hi', ts: 1 })
    expect(runMock).not.toHaveBeenCalled()

    await vi.advanceTimersByTimeAsync(999)
    expect(runMock).not.toHaveBeenCalled()

    await vi.advanceTimersByTimeAsync(1)
    expect(runMock).toHaveBeenCalledTimes(1)
    // The first arg to .set() should carry the logs in `output`.
    const setArg = setMock.mock.calls[0][0] as { output: { logs: unknown[] } }
    expect(setArg.output.logs).toHaveLength(1)
  })

  it('coalesces rapid appends into a single flush', async () => {
    const collector = createPersistingLogCollector({
      stepId: 'step_2',
      baseOutput: {},
      debounceMs: 500,
    })

    for (let i = 0; i < 5; i++) {
      collector.onLogEntry({ type: 'assistant', text: `m${i}`, ts: i })
    }

    expect(runMock).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(500)

    expect(runMock).toHaveBeenCalledTimes(1)
    const setArg = setMock.mock.calls[0][0] as { output: { logs: unknown[] } }
    expect(setArg.output.logs).toHaveLength(5)
  })

  it('stop() cancels the pending timer and flushes immediately', async () => {
    const collector = createPersistingLogCollector({
      stepId: 'step_3',
      baseOutput: {},
      debounceMs: 2000,
    })

    collector.onLogEntry({ type: 'assistant', text: 'pending', ts: 1 })
    await collector.stop()
    await settleFinalFlush()

    expect(runMock).toHaveBeenCalledTimes(1)

    // Advance past the original debounce window — no additional flush should
    // fire because stop() cleared the timer and marked the collector terminal.
    await vi.advanceTimersByTimeAsync(5000)
    expect(runMock).toHaveBeenCalledTimes(1)
  })

  it('ignores onLogEntry calls after stop()', async () => {
    const collector = createPersistingLogCollector({
      stepId: 'step_4',
      baseOutput: {},
      debounceMs: 500,
    })

    await collector.stop()
    await settleFinalFlush()
    runMock.mockClear()

    collector.onLogEntry({ type: 'assistant', text: 'late', ts: 99 })
    await vi.advanceTimersByTimeAsync(2000)

    expect(runMock).not.toHaveBeenCalled()
    expect(collector.logs).toHaveLength(0)
  })

  it('preserves baseOutput fields in each flush', async () => {
    const baseOutput = { result: '', chatId: 'chat_abc' }
    const collector = createPersistingLogCollector({
      stepId: 'step_5',
      baseOutput,
      debounceMs: 100,
    })

    collector.onLogEntry({ type: 'assistant', text: 'x', ts: 1 })
    await vi.advanceTimersByTimeAsync(100)

    const setArg = setMock.mock.calls[0][0] as { output: Record<string, unknown> }
    expect(setArg.output.chatId).toBe('chat_abc')
    expect(setArg.output.result).toBe('')
    expect(setArg.output).toHaveProperty('logs')
  })
})
