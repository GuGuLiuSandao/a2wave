/**
 * L1 emit dispatcher — 3 sub-interface fan-out tests + 8-hook throw-isolation matrix.
 *
 * Spec §4.2 / §5.0 / §11 L7.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { logger } from '../../logger.js'
import { emit } from '../emit.js'
import type { AuthenticatedCtx, HookStage, LifecyclePlugin, ReplyCtx, RunCtx } from '../types.js'

function makeCtx(): AuthenticatedCtx {
  return {
    channelId: 'feishu',
    rawEvent: {},
    rawText: 'hi',
    sender: { userId: 'usr_1' },
    messageKey: 'msg_1',
    meta: {},
    channelConfig: { commands: {} },
    messageContext: { chatType: 'p2p', isThreadReply: false },
    agent: { id: 'agt_1', userId: null },
    agentConfig: {} as never,
    engineType: 'claude-code',
  }
}

function makeReplyCtx(): ReplyCtx {
  return {
    ...makeCtx(),
    strippedText: '',
    runId: 'r',
    taskId: 't',
    payload: {} as never,
    content: { text: 'orig' },
  } as ReplyCtx
}

describe('emit — Interceptor stage', () => {
  it('runs plugins sequentially in priority order', async () => {
    const calls: string[] = []
    const p1: LifecyclePlugin = {
      name: 'core:a',
      priority: 10,
      onAuthenticated: async () => {
        calls.push('a')
        return null
      },
    }
    const p2: LifecyclePlugin = {
      name: 'core:b',
      priority: 20,
      onAuthenticated: async () => {
        calls.push('b')
        return null
      },
    }
    const ctx = makeCtx()
    await emit('onAuthenticated', ctx, [p2, p1])
    expect(calls).toEqual(['a', 'b'])
  })

  it('short-circuits remaining plugins on abort', async () => {
    const after = vi.fn(async () => null)
    const ctx = makeCtx()
    const plugins: LifecyclePlugin[] = [
      {
        name: 'core:abort',
        onAuthenticated: async () => ({ abort: { reason: 'nope', code: 'X' } }),
      },
      { name: 'core:after', onAuthenticated: after },
    ]
    await emit('onAuthenticated', ctx, plugins)
    expect(ctx.aborted).toBe(true)
    expect(ctx.abortReason).toEqual({ code: 'X', message: 'nope' })
    expect(after).not.toHaveBeenCalled()
  })

  it('isolates plugin throw as abort with generic message (Interceptor)', async () => {
    const ctx = makeCtx()
    const plugins: LifecyclePlugin[] = [
      {
        name: 'core:throws',
        onAuthenticated: async () => {
          throw new Error('boom')
        },
      },
    ]
    await emit('onAuthenticated', ctx, plugins)
    expect(ctx.aborted).toBe(true)
    expect(ctx.abortReason?.message).toMatch(/出错|请稍后重试/)
  })
})

describe('emit — Transform handler argument order', () => {
  it('onStreamFrame receives (frame, ctx)', async () => {
    const ctx = makeReplyCtx()
    const received: unknown[] = []
    const plugins: LifecyclePlugin[] = [
      {
        name: 'obs:framespy',
        onStreamFrame: async (frame, c) => {
          received.push(frame, c)
        },
      },
    ]
    const frame = { type: 'token' as const, delta: 'x' }
    await emit('onStreamFrame', ctx, plugins, frame)
    expect(received[0]).toEqual(frame)
    expect(received[1]).toBe(ctx)
  })

  it('onAfterRun receives (ctx, outcome) — ctx first, outcome second', async () => {
    const ctx = makeReplyCtx()
    const received: unknown[] = []
    const plugins: LifecyclePlugin[] = [
      {
        name: 'obs:afterspy',
        onAfterRun: async (c, outcome) => {
          received.push(c, outcome)
        },
      },
    ]
    const outcome = {
      success: true as const,
      output: 'ok',
      durationMs: 1,
      artifacts: [],
    }
    await emit('onAfterRun', ctx, plugins, outcome)
    expect(received[0]).toBe(ctx)
    expect(received[1]).toEqual(outcome)
  })

  it('onBeforeReply receives ctx only', async () => {
    const ctx = makeReplyCtx()
    const received: unknown[] = []
    const plugins: LifecyclePlugin[] = [
      {
        name: 'obs:beforespy',
        onBeforeReply: async (c) => {
          received.push(c)
          return null
        },
      },
    ]
    await emit('onBeforeReply', ctx, plugins)
    expect(received).toHaveLength(1)
    expect(received[0]).toBe(ctx)
  })
})

describe('emit — Transform stage', () => {
  it('runs plugins sequentially and chains patches on onBeforeReply', async () => {
    const ctx = makeReplyCtx()
    const plugins: LifecyclePlugin[] = [
      { name: 'obs:p1', onBeforeReply: async () => ({ patch: { text: 'a' } }) },
      { name: 'obs:p2', onBeforeReply: async () => ({ patch: { extra: true } }) },
    ]
    await emit('onBeforeReply', ctx, plugins)
    expect(ctx.content).toEqual({ text: 'a', extra: true })
  })

  it('skips throwing plugin but continues with the rest', async () => {
    const after = vi.fn(async () => ({ patch: { extra: 'ok' } }))
    const ctx = makeReplyCtx()
    const plugins: LifecyclePlugin[] = [
      {
        name: 'obs:throws',
        onBeforeReply: async () => {
          throw new Error('boom')
        },
      },
      { name: 'obs:after', onBeforeReply: after },
    ]
    await emit('onBeforeReply', ctx, plugins)
    expect(after).toHaveBeenCalled()
    expect((ctx.content as unknown as { extra: string }).extra).toBe('ok')
  })
})

describe('emit — Broadcast stage', () => {
  it('does not block caller; returns before plugins complete', async () => {
    let pluginResolved = false
    const slow: LifecyclePlugin = {
      name: 'obs:slow',
      onAfterReply: () =>
        new Promise<void>((resolve) =>
          setTimeout(() => {
            pluginResolved = true
            resolve()
          }, 50),
        ),
    }
    const ctx = makeReplyCtx()
    const t0 = Date.now()
    await emit('onAfterReply', ctx, [slow])
    const elapsed = Date.now() - t0
    expect(elapsed).toBeLessThan(20) // returns before the 50ms plugin
    expect(pluginResolved).toBe(false)
  })

  it('logs unhandled rejection without throwing to caller', async () => {
    const ctx = makeReplyCtx()
    const plugins: LifecyclePlugin[] = [
      {
        name: 'obs:bang',
        onAfterReply: async () => {
          throw new Error('boom')
        },
      },
    ]
    await expect(emit('onAfterReply', ctx, plugins)).resolves.toBeUndefined()
  })

  it('isolates synchronous broadcast throw and still schedules sibling handlers', async () => {
    const warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => {})
    const calls: string[] = []
    const ctx = makeReplyCtx()
    const plugins: LifecyclePlugin[] = [
      {
        name: 'obs:sync-bang',
        onAfterReply: () => {
          throw new Error('sync boom')
        },
      },
      {
        name: 'obs:witness',
        onAfterReply: async () => {
          calls.push('witness')
        },
      },
    ]

    await expect(emit('onAfterReply', ctx, plugins)).resolves.toBeUndefined()
    await new Promise((resolve) => setTimeout(resolve, 30))

    expect(calls).toEqual(['witness'])
    expect(warnSpy).toHaveBeenCalled()
    warnSpy.mockRestore()
  })
})

// --- §11 L7: parametric matrix covering all 8 hooks ---

type Cat = 'interceptor' | 'transform' | 'broadcast'
interface MatrixRow {
  stage: HookStage
  category: Cat
  /** extra arg some stages need (frame / outcome / error) */
  extra?: unknown
}

const HOOK_MATRIX: readonly MatrixRow[] = [
  // Interceptor (2)
  { stage: 'onAuthenticated', category: 'interceptor' },
  { stage: 'onBeforeRun', category: 'interceptor' },
  // Transform (3)
  { stage: 'onStreamFrame', category: 'transform', extra: { type: 'token', delta: 'x' } },
  {
    stage: 'onAfterRun',
    category: 'transform',
    extra: { success: true, output: '', durationMs: 0, artifacts: [] },
  },
  { stage: 'onBeforeReply', category: 'transform' },
  // Broadcast (3)
  {
    stage: 'onRunSucceeded',
    category: 'broadcast',
    extra: { success: true, output: '', durationMs: 0, artifacts: [] },
  },
  {
    stage: 'onRunFailed',
    category: 'broadcast',
    extra: { success: false, error: 'x', durationMs: 0 },
  },
  { stage: 'onAfterReply', category: 'broadcast' },
]

// ─────────────────────────────────────────────────────────────────────────────
// Mutation-testing reinforcement: each describe targets specific surviving
// mutants in emit.ts.
// ─────────────────────────────────────────────────────────────────────────────

describe('emit — module-init constants (re-imports per test for per-test coverage)', () => {
  // STAGES Sets and ABORT_USER_MSG are initialized at module load. Stryker's
  // per-test coverage attributes those lines only to the first test that
  // happened to import — unless we vi.resetModules() and re-import each test.
  let emitFn: typeof emit
  beforeEach(async () => {
    vi.resetModules()
    emitFn = (await import('../emit.js')).emit
  })

  it('routes every known hook stage via freshly imported module', async () => {
    const ctx = makeReplyCtx() as RunCtx & ReplyCtx
    const noop: LifecyclePlugin = { name: 'noop' }
    const stages: Array<{ stage: HookStage; extra?: unknown }> = [
      { stage: 'onAuthenticated' },
      { stage: 'onBeforeRun' },
      { stage: 'onStreamFrame', extra: { type: 'token', delta: '' } },
      {
        stage: 'onAfterRun',
        extra: { success: true, output: '', durationMs: 0, artifacts: [] },
      },
      { stage: 'onBeforeReply' },
      {
        stage: 'onRunSucceeded',
        extra: { success: true, output: '', durationMs: 0, artifacts: [] },
      },
      { stage: 'onRunFailed', extra: { success: false, error: 'x', durationMs: 0 } },
      { stage: 'onAfterReply' },
    ]
    for (const { stage, extra } of stages) {
      await expect(
        emitFn(stage as never, ctx as never, [noop], extra as never),
      ).resolves.toBeUndefined()
    }
  })

  it('Interceptor throw uses exact ABORT_USER_MSG from freshly imported module', async () => {
    const ctx = makeCtx()
    await emitFn('onAuthenticated', ctx, [
      {
        name: 'thrower',
        onAuthenticated: async () => {
          throw new Error('boom')
        },
      },
    ])
    expect(ctx.abortReason?.message).toBe('命令执行出错，请稍后重试')
  })
})

describe('emit — control-flow + observability (logger spy)', () => {
  it('Interceptor: pre-aborted ctx skips all plugins (kills L97 aborted check)', async () => {
    const ctx = makeCtx()
    ctx.aborted = true
    const calls: string[] = []
    await emit('onAuthenticated', ctx, [
      {
        name: 'p',
        onAuthenticated: async () => {
          calls.push('hit')
          return null
        },
      },
    ])
    expect(calls).toEqual([])
  })

  it('Transform: handler-missing plugin does NOT trigger try-catch warn', async () => {
    const warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => {})
    await emit('onBeforeReply', makeReplyCtx(), [{ name: 'no-handler' }])
    expect(warnSpy).not.toHaveBeenCalled()
    warnSpy.mockRestore()
  })

  it('Transform onBeforeReply handler receives EXACTLY ONE arg (kills L154 stage discriminator)', async () => {
    const args: unknown[][] = []
    const ctx = makeReplyCtx()
    await emit('onBeforeReply', ctx, [
      {
        name: 'arg-checker',
        onBeforeReply: async (...rest: unknown[]) => {
          args.push(rest)
          return null
        },
      } as unknown as LifecyclePlugin,
    ])
    expect(args).toHaveLength(1)
    expect(args[0]).toEqual([ctx])
  })

  it('Transform: null decision does NOT enter applyPatch / trigger warn (kills L159 patch shape)', async () => {
    const warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => {})
    await emit('onBeforeReply', makeReplyCtx(), [{ name: 'null', onBeforeReply: async () => null }])
    expect(warnSpy).not.toHaveBeenCalled()
    warnSpy.mockRestore()
  })

  it('Transform: plugin throw DOES trigger warn (kills L162 empty-catch body)', async () => {
    const warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => {})
    await emit('onBeforeReply', makeReplyCtx(), [
      {
        name: 'thrower',
        onBeforeReply: async () => {
          throw new Error('boom')
        },
      },
    ])
    expect(warnSpy).toHaveBeenCalled()
    warnSpy.mockRestore()
  })

  it('Transform: non-object decision (string) does NOT crash (kills L160 typeof check)', async () => {
    // Without the `typeof decision === 'object'` guard, `'patch' in 'unexpected'`
    // throws (TypeError: cannot use 'in' on a primitive). With the guard, the
    // condition short-circuits and the body is skipped silently.
    const warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => {})
    await emit('onBeforeReply', makeReplyCtx(), [
      {
        name: 'str',
        onBeforeReply: async () => 'unexpected-string' as unknown as never,
      },
    ])
    expect(warnSpy).not.toHaveBeenCalled()
    warnSpy.mockRestore()
  })
})

describe('emit — stage dispatch & priority sort', () => {
  it('routes every known hook stage without throwing "unknown stage" (covers stage Set membership)', async () => {
    const ctx = makeReplyCtx() as RunCtx & ReplyCtx
    const noop: LifecyclePlugin = { name: 'noop' }
    const stages: Array<{ stage: HookStage; extra?: unknown }> = [
      { stage: 'onAuthenticated' },
      { stage: 'onBeforeRun' },
      { stage: 'onStreamFrame', extra: { type: 'token', delta: '' } },
      {
        stage: 'onAfterRun',
        extra: { success: true, output: '', durationMs: 0, artifacts: [] },
      },
      { stage: 'onBeforeReply' },
      {
        stage: 'onRunSucceeded',
        extra: { success: true, output: '', durationMs: 0, artifacts: [] },
      },
      { stage: 'onRunFailed', extra: { success: false, error: 'x', durationMs: 0 } },
      { stage: 'onAfterReply' },
    ]
    for (const { stage, extra } of stages) {
      await expect(
        emit(stage as never, ctx as never, [noop], extra as never),
      ).resolves.toBeUndefined()
    }
  })

  it('throws on unknown stage name (negative path for routing)', async () => {
    const ctx = makeReplyCtx() as RunCtx & ReplyCtx
    await expect(
      emit('totallyUnknownStage' as never, ctx as never, [], undefined as never),
    ).rejects.toThrow(/unknown stage/)
  })

  it('Interceptor: same-priority plugins run in insertion order (stable sort)', async () => {
    // `a.prio - b.prio || a.i - b.i` mutated to `||  a.i + b.i` breaks stability.
    const calls: string[] = []
    const mk = (n: string): LifecyclePlugin => ({
      name: n,
      priority: 50,
      onAuthenticated: async () => {
        calls.push(n)
        return null
      },
    })
    await emit('onAuthenticated', makeCtx(), [mk('a'), mk('b'), mk('c')])
    expect(calls).toEqual(['a', 'b', 'c'])
  })
})

describe('emit — Interceptor edge cases', () => {
  it('after a plugin sets aborted, subsequent plugins are not invoked', async () => {
    // Direct assertion targeting `if (ctx.aborted) return` inside the for-loop.
    const calls: string[] = []
    const aborter: LifecyclePlugin = {
      name: 'aborter',
      onAuthenticated: async () => {
        calls.push('aborter')
        return { abort: { reason: 'X', code: 'A' } }
      },
    }
    const next: LifecyclePlugin = {
      name: 'next',
      onAuthenticated: async () => {
        calls.push('next')
        return null
      },
    }
    const ctx = makeCtx()
    await emit('onAuthenticated', ctx, [aborter, next])
    expect(calls).toEqual(['aborter'])
    expect(ctx.aborted).toBe(true)
  })

  it('Interceptor: plugin without a handler is skipped without crashing', async () => {
    const calls: string[] = []
    const noHandler: LifecyclePlugin = { name: 'no-handler' }
    const withHandler: LifecyclePlugin = {
      name: 'with-handler',
      onAuthenticated: async () => {
        calls.push('hit')
        return null
      },
    }
    await expect(
      emit('onAuthenticated', makeCtx(), [noHandler, withHandler]),
    ).resolves.toBeUndefined()
    expect(calls).toEqual(['hit'])
  })

  it('Interceptor throw → abort uses exact ABORT_USER_MSG + code "plugin_throw"', async () => {
    const ctx = makeCtx()
    const thrower: LifecyclePlugin = {
      name: 'thrower',
      onAuthenticated: async () => {
        throw new Error('boom')
      },
    }
    await emit('onAuthenticated', ctx, [thrower])
    expect(ctx.aborted).toBe(true)
    expect(ctx.abortReason?.message).toBe('命令执行出错，请稍后重试')
    expect(ctx.abortReason?.code).toBe('plugin_throw')
  })
})

describe('emit — Transform edge cases', () => {
  it('Transform: plugin without a handler is skipped without crashing', async () => {
    const ctx = makeReplyCtx()
    const noHandler: LifecyclePlugin = { name: 'noh' }
    const withHandler: LifecyclePlugin = {
      name: 'wh',
      onBeforeReply: async () => ({ patch: { text: 'changed' } }),
    }
    await expect(emit('onBeforeReply', ctx, [noHandler, withHandler])).resolves.toBeUndefined()
    expect(ctx.content).toEqual({ text: 'changed' })
  })

  it('Transform: applies patch only when decision has shape { patch: ... }', async () => {
    // 4 patch-shape variants → covers ConditionalExpression / LogicalOperator mutants on the `decision && typeof === object && "patch" in decision` guard.
    const ctxNull = makeReplyCtx()
    await emit('onBeforeReply', ctxNull, [{ name: 'null', onBeforeReply: async () => null }])
    expect(ctxNull.content).toEqual({ text: 'orig' })

    const ctxNoPatch = makeReplyCtx()
    await emit('onBeforeReply', ctxNoPatch, [
      { name: 'noPatch', onBeforeReply: async () => ({ other: 'x' }) as unknown as never },
    ])
    expect(ctxNoPatch.content).toEqual({ text: 'orig' })

    const ctxUndef = makeReplyCtx()
    await emit('onBeforeReply', ctxUndef, [
      { name: 'undef', onBeforeReply: async () => undefined as unknown as never },
    ])
    expect(ctxUndef.content).toEqual({ text: 'orig' })

    const ctxPatch = makeReplyCtx()
    await emit('onBeforeReply', ctxPatch, [
      { name: 'patch', onBeforeReply: async () => ({ patch: { text: 'changed' } }) },
    ])
    expect(ctxPatch.content).toEqual({ text: 'changed' })
  })

  it('Transform onAfterRun: patch updates ctx.outcome (and leaves ctx.content alone)', async () => {
    // applyPatch's `if (stage === 'onBeforeReply')` mutated to `true` would
    // patch ctx.content even on onAfterRun. This asserts the per-stage routing.
    const ctx = makeReplyCtx()
    ;(ctx as unknown as { outcome: Record<string, unknown> }).outcome = { initial: 'val' }
    await emit(
      'onAfterRun',
      ctx as RunCtx,
      [
        {
          name: 'ar-patch',
          onAfterRun: async () => ({ patch: { output: 'extra' } }),
        },
      ],
      { success: true, output: 'x', durationMs: 0, artifacts: [] },
    )
    expect((ctx as unknown as { outcome: Record<string, unknown> }).outcome).toEqual({
      initial: 'val',
      output: 'extra',
    })
    expect(ctx.content).toEqual({ text: 'orig' })
  })
})

describe('emit — Broadcast handler filter', () => {
  it('runs every broadcast plugin handler (filter must NOT drop entries with handlers)', async () => {
    const calls: string[] = []
    const p1: LifecyclePlugin = {
      name: 'b1',
      onAfterReply: async () => {
        calls.push('p1')
      },
    }
    const p2: LifecyclePlugin = {
      name: 'b2',
      onAfterReply: async () => {
        calls.push('p2')
      },
    }
    const ctx = makeReplyCtx()
    await emit('onAfterReply', ctx, [p1, p2])
    // broadcast fire-and-forget — wait a tick for plugins to settle
    await new Promise((resolve) => setTimeout(resolve, 30))
    expect(calls.sort()).toEqual(['p1', 'p2'])
  })

  it('broadcast: plugin without handler does not crash + does not block others', async () => {
    const calls: string[] = []
    const noHandler: LifecyclePlugin = { name: 'no' }
    const withHandler: LifecyclePlugin = {
      name: 'wh',
      onAfterReply: async () => {
        calls.push('hit')
      },
    }
    const ctx = makeReplyCtx()
    await expect(emit('onAfterReply', ctx, [noHandler, withHandler])).resolves.toBeUndefined()
    await new Promise((resolve) => setTimeout(resolve, 30))
    expect(calls).toEqual(['hit'])
  })
})

describe('emit — throw isolation matrix (all 8 hooks)', () => {
  it.each(HOOK_MATRIX)(
    '$category $stage isolates thrown error per its category contract',
    async (row) => {
      const after = vi.fn(async () => null)
      const ctx = makeReplyCtx() as RunCtx & ReplyCtx
      const thrower: LifecyclePlugin = {
        name: 'x:throws',
        [row.stage]: async () => {
          throw new Error('boom')
        },
      } as never
      const witness: LifecyclePlugin = {
        name: 'x:witness',
        [row.stage]: after,
      } as never

      // emit must NOT propagate the throw to the caller regardless of category
      await expect(
        emit(row.stage as never, ctx, [thrower, witness], row.extra as never),
      ).resolves.toBeUndefined()

      if (row.category === 'interceptor') {
        // Interceptor: throw → abort with generic msg + downstream short-circuit
        expect(ctx.aborted).toBe(true)
        expect(after).not.toHaveBeenCalled()
      } else if (row.category === 'transform') {
        // Transform: throw → skip thrower + continue down chain (witness runs)
        expect(after).toHaveBeenCalledTimes(1)
        expect(ctx.aborted).not.toBe(true)
      } else {
        // Broadcast: fire-and-forget; caller does not await plugin completion.
        // We don't assert witness was called (timing-dependent) — only that no abort + no throw.
        expect(ctx.aborted).not.toBe(true)
      }
    },
  )
})
