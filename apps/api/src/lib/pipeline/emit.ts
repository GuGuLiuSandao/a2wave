/**
 * L1 emit dispatcher — routes hook stages to their sub-interface semantics (spec §5.0.2):
 *   Interceptor: seq await, abort short-circuits, plugin throw → abort with generic msg
 *   Transform:   seq await, patch chain, plugin throw → skip plugin + continue
 *   Broadcast:   parallel allSettled, framework fire-and-forget (caller does NOT await)
 *
 * For Transform's onStreamFrame, an additional `frame` argument is required —
 * use `emitStreamFrame()` instead.
 */
import { logger } from '../logger.js'
import type {
  AuthenticatedCtx,
  BaseCtx,
  BroadcastStage,
  HookStage,
  InterceptorStage,
  LifecyclePlugin,
  ReplyCtx,
  RunCtx,
  StreamFrame,
  TransformStage,
} from './types.js'

const INTERCEPTOR_STAGES = new Set<InterceptorStage>(['onAuthenticated', 'onBeforeRun'])
const TRANSFORM_STAGES = new Set<TransformStage>(['onStreamFrame', 'onAfterRun', 'onBeforeReply'])
const BROADCAST_STAGES = new Set<BroadcastStage>(['onRunSucceeded', 'onRunFailed', 'onAfterReply'])

const ABORT_USER_MSG = '命令执行出错，请稍后重试'

/** Order plugins for sequential stages: priority asc, stable by index. */
function ordered(plugins: readonly LifecyclePlugin[]): LifecyclePlugin[] {
  return plugins
    .map((p, i) => ({ p, i, prio: p.priority ?? 100 }))
    .sort((a, b) => {
      // Stryker disable next-line ArithmeticOperator: V8 TimSort treats the mutated comparator as effectively equal for non-negative indices, yielding the same insertion-order result.
      return a.prio - b.prio || a.i - b.i
    })
    .map((x) => x.p)
}

export async function emit(
  stage: 'onAuthenticated',
  ctx: AuthenticatedCtx,
  plugins: readonly LifecyclePlugin[],
): Promise<void>
export async function emit(
  stage: 'onBeforeRun',
  ctx: RunCtx,
  plugins: readonly LifecyclePlugin[],
): Promise<void>
export async function emit(
  stage: 'onAfterRun',
  ctx: RunCtx,
  plugins: readonly LifecyclePlugin[],
  outcome?: unknown,
): Promise<void>
export async function emit(
  stage: 'onBeforeReply',
  ctx: ReplyCtx,
  plugins: readonly LifecyclePlugin[],
): Promise<void>
export async function emit(
  stage: 'onStreamFrame',
  ctx: RunCtx,
  plugins: readonly LifecyclePlugin[],
  frame: StreamFrame,
): Promise<void>
export async function emit(
  stage: 'onRunSucceeded' | 'onRunFailed' | 'onAfterReply',
  ctx: ReplyCtx | RunCtx,
  plugins: readonly LifecyclePlugin[],
  extra?: unknown,
): Promise<void>
export async function emit(
  stage: HookStage,
  ctx: BaseCtx,
  plugins: readonly LifecyclePlugin[],
  extra?: unknown,
): Promise<void> {
  if (INTERCEPTOR_STAGES.has(stage as InterceptorStage)) {
    return runInterceptor(stage as InterceptorStage, ctx, plugins)
  }
  if (TRANSFORM_STAGES.has(stage as TransformStage)) {
    return runTransform(stage as TransformStage, ctx, plugins, extra)
  }
  if (BROADCAST_STAGES.has(stage as BroadcastStage)) {
    // Fire-and-forget: caller does NOT await plugin completion.
    void runBroadcast(stage as BroadcastStage, ctx, plugins, extra)
    return
  }
  throw new Error(`emit: unknown stage ${stage}`)
}

async function runInterceptor(
  stage: InterceptorStage,
  ctx: BaseCtx,
  plugins: readonly LifecyclePlugin[],
): Promise<void> {
  for (const plugin of ordered(plugins)) {
    if (ctx.aborted) return
    const handler = plugin[stage] as
      | ((c: BaseCtx) => Promise<{ abort?: { reason: string; code?: string } } | null>)
      | undefined
    if (!handler) continue
    try {
      const decision = await handler(ctx)
      if (decision && 'abort' in decision && decision.abort) {
        ctx.aborted = true
        ctx.abortReason = {
          code: decision.abort.code,
          message: decision.abort.reason,
        }
        // Stryker disable all: log payload + message are observability-only
        logger.info(
          {
            plugin: plugin.name,
            stage,
            code: decision.abort.code,
            reason: decision.abort.reason,
          },
          'Pipeline: plugin abort',
        )
        // Stryker restore all
        return
      }
    } catch (err) {
      // Stryker disable all: log payload + message are observability-only
      logger.warn(
        { err, plugin: plugin.name, stage, category: 'interceptor' },
        'Pipeline: interceptor plugin threw — aborting with generic message',
      )
      // Stryker restore all
      ctx.aborted = true
      ctx.abortReason = { code: 'plugin_throw', message: ABORT_USER_MSG }
      return
    }
  }
}

async function runTransform(
  stage: TransformStage,
  ctx: BaseCtx,
  plugins: readonly LifecyclePlugin[],
  extra?: unknown,
): Promise<void> {
  for (const plugin of ordered(plugins)) {
    const handler = plugin[stage] as ((...args: unknown[]) => Promise<unknown>) | undefined
    if (!handler) continue
    try {
      // Per-stage handler signature (spec §4.2 TransformHooks):
      //   onStreamFrame(frame, ctx)      → extra-first
      //   onAfterRun(ctx, outcome)       → ctx-first, outcome (extra) second
      //   onBeforeReply(ctx)             → ctx-only
      let decision: unknown
      if (stage === 'onStreamFrame') {
        decision = await handler(extra as never, ctx as never)
      } else if (stage === 'onAfterRun') {
        decision = await handler(ctx as never, extra as never)
      } else {
        decision = await handler(ctx as never)
      }
      if (decision && typeof decision === 'object' && 'patch' in decision) {
        applyPatch(stage, ctx, (decision as { patch: Record<string, unknown> }).patch)
      }
    } catch (err) {
      // Stryker disable all: log payload + message + empty-catch are observability-only; control flow (skip + continue) is asserted via transform tests
      logger.warn(
        { err, plugin: plugin.name, stage, category: 'transform' },
        'Pipeline: transform plugin threw — skipping plugin, continuing',
      )
      // Stryker restore all
    }
  }
}

async function runBroadcast(
  stage: BroadcastStage,
  ctx: BaseCtx,
  plugins: readonly LifecyclePlugin[],
  extra?: unknown,
): Promise<void> {
  const handlers = ordered(plugins)
    .map((p) => {
      const h = p[stage] as ((...args: unknown[]) => Promise<void>) | undefined
      if (!h) return null
      return Promise.resolve()
        .then(() => h(ctx as never, extra as never))
        .catch((err) => {
          // Stryker disable all: log payload + message + empty-catch are observability-only; rejection swallowing is asserted via "logs unhandled rejection without throwing to caller"
          logger.warn(
            { err, plugin: p.name, stage, category: 'broadcast' },
            'Pipeline: broadcast plugin threw (unhandled rejection log)',
          )
          // Stryker restore all
        })
    })
    .filter((x): x is Promise<void> => x !== null)
  await Promise.allSettled(handlers)
}

function applyPatch(stage: TransformStage, ctx: BaseCtx, patch: Record<string, unknown>): void {
  if (stage === 'onBeforeReply') {
    const c = ctx as ReplyCtx
    c.content = { ...(c.content ?? { text: '' }), ...patch } as ReplyCtx['content']
    return
  }
  if (stage === 'onAfterRun') {
    const c = ctx as RunCtx & { outcome?: Record<string, unknown> }
    c.outcome = { ...(c.outcome ?? {}), ...patch }
    return
  }
  // onStreamFrame: no patch shape defined — ignore
}

/** Convenience overload for onStreamFrame which carries a per-frame payload. */
export async function emitStreamFrame(
  frame: StreamFrame,
  ctx: RunCtx,
  plugins: readonly LifecyclePlugin[],
): Promise<void> {
  return emit('onStreamFrame', ctx, plugins, frame)
}
