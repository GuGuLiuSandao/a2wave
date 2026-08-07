/**
 * runWithLifecycle plugin fan-out.
 *
 * Asserts the emit ordering across all three paths (success / engine-fail / thrown):
 *   1. finishRun* runs first
 *   2. onAfterRun (Transform, awaited)
 *   3. onRunSucceeded | onRunFailed (Broadcast, fire-and-forget)
 *
 * onStreamFrame is deliberately NOT emitted here: a StreamLogEntry is not a
 * StreamFrame, and the real emitStreamFrame is injected by the engine adapter.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../execute-with-retry.js', () => ({
  executeWithRetry: vi.fn(),
}))
vi.mock('../run-lifecycle.js', () => ({
  finishRunSuccess: vi.fn().mockResolvedValue([]),
  finishRunError: vi.fn().mockReturnValue('Execution failed. Check server logs for details.'),
  createPersistingLogCollector: () => ({
    onLogEntry: vi.fn(),
    stop: vi.fn().mockResolvedValue(undefined),
    logs: [],
  }),
}))
vi.mock('../run-log-registry.js', () => ({
  registerLogCollector: vi.fn(),
  unregisterLogCollector: vi.fn(),
}))
vi.mock('../logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}))

import { executeWithRetry } from '../execute-with-retry.js'
import type { LifecyclePlugin, RunCtx } from '../pipeline/index.js'
import { runWithLifecycle } from '../run-launcher.js'

const execMock = executeWithRetry as unknown as ReturnType<typeof vi.fn>

const baseLifecycleParams = {
  taskId: 't',
  runId: 'r',
  stepId: 's',
  agentId: 'a',
  startTime: Date.now(),
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe('runWithLifecycle — plugins option', () => {
  it('emits onAfterRun then onRunSucceeded on engine success', async () => {
    execMock.mockResolvedValue({
      result: { success: true, output: 'hi', chatId: 'c' },
      retries: [],
      logs: [],
    })
    const onAfter = vi.fn()
    const onSucc = vi.fn()
    const onFail = vi.fn()
    const plugins: LifecyclePlugin[] = [
      { name: 'obs:t', onAfterRun: onAfter, onRunSucceeded: onSucc, onRunFailed: onFail },
    ]
    const pluginCtx = { runId: 'r', taskId: 't' } as unknown as RunCtx
    const r = await runWithLifecycle('t', {} as never, baseLifecycleParams, {
      plugins,
      pluginCtx,
    })
    expect(r.success).toBe(true)
    expect(onAfter).toHaveBeenCalledTimes(1)
    // onRunSucceeded is Broadcast (fire-and-forget); allow microtask flush
    await new Promise((res) => setTimeout(res, 5))
    expect(onSucc).toHaveBeenCalledTimes(1)
    expect(onFail).not.toHaveBeenCalled()
  })

  it('emits onAfterRun + onRunFailed (not onRunSucceeded) on engine fail', async () => {
    execMock.mockResolvedValue({
      result: { success: false, error: 'boom' },
      retries: [],
      logs: [],
    })
    const onAfter = vi.fn()
    const onSucc = vi.fn()
    const onFail = vi.fn()
    const plugins: LifecyclePlugin[] = [
      { name: 'obs:t', onAfterRun: onAfter, onRunSucceeded: onSucc, onRunFailed: onFail },
    ]
    const r = await runWithLifecycle('t', {} as never, baseLifecycleParams, {
      plugins,
      pluginCtx: {} as never,
    })
    expect(r.success).toBe(false)
    expect(r.error).toBe('boom')
    expect(onAfter).toHaveBeenCalledTimes(1)
    expect(onSucc).not.toHaveBeenCalled()
    await new Promise((res) => setTimeout(res, 5))
    expect(onFail).toHaveBeenCalledTimes(1)
  })

  it('emits onAfterRun + onRunFailed when executeWithRetry throws', async () => {
    execMock.mockRejectedValue(new Error('exec-threw'))
    const onAfter = vi.fn()
    const onSucc = vi.fn()
    const onFail = vi.fn()
    const plugins: LifecyclePlugin[] = [
      { name: 'obs:t', onAfterRun: onAfter, onRunSucceeded: onSucc, onRunFailed: onFail },
    ]
    const r = await runWithLifecycle('t', {} as never, baseLifecycleParams, {
      plugins,
      pluginCtx: {} as never,
    })
    expect(r.success).toBe(false)
    expect(onAfter).toHaveBeenCalledTimes(1)
    expect(onSucc).not.toHaveBeenCalled()
    await new Promise((res) => setTimeout(res, 5))
    expect(onFail).toHaveBeenCalledTimes(1)
  })

  it('no plugins → no inner emit (3 existing callsites unaffected)', async () => {
    execMock.mockResolvedValue({
      result: { success: true, output: 'hi' },
      retries: [],
      logs: [],
    })
    // Same call shape as gateway / oauth / agents callsites: no options at all.
    const r = await runWithLifecycle('t', {} as never, baseLifecycleParams)
    expect(r.success).toBe(true)
    expect(r.output).toBe('hi')
  })

  it('returns artifacts from awaited finishRunSuccess (Step 4b)', async () => {
    const { finishRunSuccess } = await import('../run-lifecycle.js')
    execMock.mockResolvedValue({
      result: { success: true, output: 'ok', chatId: 'c' },
      retries: [],
      logs: [],
    })
    ;(finishRunSuccess as unknown as ReturnType<typeof vi.fn>).mockResolvedValue([
      { id: 'art_1', filename: 'a.txt', storagePath: '/x/a.txt' },
    ])
    const r = await runWithLifecycle('t', {} as never, baseLifecycleParams)
    expect(r.success).toBe(true)
    expect(r.artifacts).toEqual([{ id: 'art_1', filename: 'a.txt', storagePath: '/x/a.txt' }])
  })

  it('artifacts surface into onAfterRun outcome (Step 4b)', async () => {
    const { finishRunSuccess } = await import('../run-lifecycle.js')
    execMock.mockResolvedValue({
      result: { success: true, output: 'ok' },
      retries: [],
      logs: [],
    })
    ;(finishRunSuccess as unknown as ReturnType<typeof vi.fn>).mockResolvedValue([
      { id: 'art_2', filename: 'b.bin', storagePath: '/x/b.bin' },
    ])
    const captured: Array<{ artifacts?: unknown }> = []
    const plugins: LifecyclePlugin[] = [
      {
        name: 'obs:capture',
        onAfterRun: async (_ctx, outcome) => {
          captured.push(outcome as { artifacts?: unknown })
        },
      },
    ]
    await runWithLifecycle('t', {} as never, baseLifecycleParams, {
      plugins,
      pluginCtx: {} as never,
    })
    expect(captured).toHaveLength(1)
    expect(captured[0]?.artifacts).toEqual([
      { id: 'art_2', filename: 'b.bin', storagePath: '/x/b.bin' },
    ])
  })

  it('uses onAfterRun patched success outcome for broadcast and return value', async () => {
    execMock.mockResolvedValue({
      result: { success: true, output: 'original', chatId: 'chat_original' },
      retries: [],
      logs: [],
    })
    const onSucc = vi.fn()
    const plugins: LifecyclePlugin[] = [
      {
        name: 'obs:patch-after-run',
        onAfterRun: async () => ({ patch: { output: 'patched', chatId: 'chat_patched' } }),
        onRunSucceeded: onSucc,
      },
    ]
    const pluginCtx = { runId: 'r', taskId: 't' } as unknown as RunCtx

    const r = await runWithLifecycle('t', {} as never, baseLifecycleParams, {
      plugins,
      pluginCtx,
    })

    expect(r.success).toBe(true)
    expect(r.output).toBe('patched')
    expect(r.chatId).toBe('chat_patched')
    await new Promise((res) => setTimeout(res, 5))
    expect(onSucc).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ output: 'patched', chatId: 'chat_patched' }),
    )
  })

  it('plugins provided but pluginCtx missing → no emit (defensive)', async () => {
    execMock.mockResolvedValue({
      result: { success: true, output: 'hi' },
      retries: [],
      logs: [],
    })
    const onAfter = vi.fn()
    const plugins: LifecyclePlugin[] = [{ name: 'obs:t', onAfterRun: onAfter }]
    const r = await runWithLifecycle('t', {} as never, baseLifecycleParams, {
      plugins,
      // pluginCtx undefined
    })
    expect(r.success).toBe(true)
    expect(onAfter).not.toHaveBeenCalled()
  })
})
