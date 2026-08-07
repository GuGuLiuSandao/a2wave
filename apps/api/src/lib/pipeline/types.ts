/**
 * L1 Lifecycle Hook Framework types.
 *
 * 8 hooks split across 3 sub-interfaces:
 *   Interceptor: onAuthenticated, onBeforeRun
 *   Transform:   onStreamFrame, onAfterRun, onBeforeReply
 *   Broadcast:   onRunSucceeded, onRunFailed, onAfterReply
 *
 * Fan-out semantics differ by sub-interface (see emit.ts):
 *   Interceptor: seq await, abort short-circuits, plugin throw → abort with generic msg
 *   Transform:   seq await, patch chain, plugin throw → skip plugin + continue
 *   Broadcast:   parallel allSettled, framework fire-and-forget (caller does NOT await)
 *
 * NOTE: 没有 onParsed hook。channel adapter 把 rawEvent 解到 ParsedCtx 后
 * 立刻补齐 agent / agentConfig / engineType 升级到 AuthenticatedCtx，再 emit。
 * commandsPlugin 在 onAuthenticated 里既做 prefix 匹配又跑 validators。
 */

import type { WorkerTaskPayload } from '../../worker/types.js'
import type { AgentConfig } from '../agent-helpers.js'

export type Awaitable<T> = T | Promise<T>

export type AbortableDecision = null | { abort: { reason: string; code?: string } }

export type PatchOnlyDecision<T> = null | { patch: T }

// biome-ignore lint/suspicious/noConfusingVoidType: transform hooks may return no patch or a patch decision.
type RunTransformDecision = void | PatchOnlyDecision<Partial<RunOutcome>>

// --- Stream frames (spec §4.2 onStreamFrame, §5.4 obs:compact-summary) ---

/**
 * Pipeline-owned 抽象 frame 类型。引擎适配层（claude-code / cursor / script）
 * 把各自的 stream 翻译成 StreamFrame 再投递 —— plugin 不依赖任何引擎内部 log 格式。
 *
 * Step 4a 只注册 onStreamFrame hook signature；实际 emit 在 Step 7 (PR-2)
 * 由引擎适配层补上。Step 4a 不投递任何 frame（hook 注册但永远不触发）。
 */
export type StreamFrame =
  | { readonly type: 'token'; readonly delta: string }
  | { readonly type: 'tool_call'; readonly name: string; readonly args?: unknown }
  | { readonly type: 'tool_result'; readonly name: string; readonly ok: boolean }
  | { readonly type: 'phase'; readonly phase: 'thinking' | 'responding' | 'finalizing' }

// --- Ctx progression (spec §4.4) ---

/** Default empty extension point; plugins use declaration merging (spec §4.4). */
// biome-ignore lint/suspicious/noEmptyInterface: extension point for plugin meta via declaration merging
export interface PluginMeta {}

export interface BaseCtx {
  readonly channelId: string
  readonly rawEvent: unknown
  aborted?: boolean
  abortReason?: { code?: string; message: string }
  meta: PluginMeta
}

/**
 * 消息上下文（用于 command 的 allowedContexts 过滤）。Channel adapter 填。
 * - chatType: 'p2p' (1:1) | 'group' (多人群)
 * - isThreadReply: 是否为话题/回复链中的非顶层消息（feishu 的 root_id !== message_id）
 *
 * "thread" 与 chatType 正交：群里可有 thread，p2p 里也可有（飞书的话题 P2P）。
 * Plugin 读 `isThreadReply` 优先，再读 `chatType`。
 */
export interface MessageContext {
  readonly chatType: 'p2p' | 'group'
  readonly isThreadReply: boolean
}

export interface ParsedCtx extends BaseCtx {
  rawText: string
  sender: { userId: string; openId?: string }
  messageKey: string
  /**
   * 频道侧配置原对象。Feishu 通道下为 `FeishuConfig`；其他 channel 为各自 config shape。
   * Plugin 按 channelId 做 narrow 后使用（commandsPlugin 只在 channelId='feishu' 时读）。
   *
   * 注意：原型 PR-1 没有这个字段——FeishuConfig 是 handleMessage 的入参。v3 把它放上 ctx
   * 是为了让 commandsPlugin 在 onAuthenticated 时能读到 commands 开关 / 自定义前缀。
   */
  channelConfig: unknown
  /** Channel adapter 填的消息上下文，用于 command 的 allowedContexts 过滤。 */
  messageContext: MessageContext
}

export interface AuthenticatedCtx extends ParsedCtx {
  agent: { id: string; userId: string | null; [k: string]: unknown }
  agentConfig: AgentConfig
  engineType: string
}

export interface MatchedCtx extends AuthenticatedCtx {
  matchedCommand?: string
  strippedText: string
  /** Dispatcher 命中后挂的 CommandPlugin；各 CommandPlugin 的 onBeforeRun 钩子读它判断是否激活。 */
  pendingCommandPlugin?: import('./commands/types.js').CommandPlugin
}

export interface RunCtx extends MatchedCtx {
  chatIdOverride?: string | null
  runConfigPatch?: Record<string, unknown>
  preAck?: string
  runId: string
  taskId: string
  payload: WorkerTaskPayload
}

export interface RunOutcome {
  success: true
  output: string
  chatId?: string
  durationMs: number
  artifacts: import('../artifact-storage.js').RegisteredArtifact[]
}

export interface PipelineError {
  success: false
  error: string
  durationMs: number
}

export interface ReplyContent {
  text: string
  [k: string]: unknown
}

export interface ReplyCtx extends RunCtx {
  outcome?: RunOutcome
  error?: PipelineError
  content?: ReplyContent
}

// --- Hook sub-interfaces (spec §4.2) ---

export interface InterceptorHooks {
  onAuthenticated?(ctx: AuthenticatedCtx): Awaitable<AbortableDecision>
  onBeforeRun?(ctx: RunCtx): Awaitable<AbortableDecision>
}

export interface TransformHooks {
  onStreamFrame?(frame: StreamFrame, ctx: RunCtx): Awaitable<void>
  onAfterRun?(ctx: RunCtx, outcome: RunOutcome | PipelineError): Awaitable<RunTransformDecision>
  onBeforeReply?(ctx: ReplyCtx): Awaitable<PatchOnlyDecision<Partial<ReplyContent>>>
}

export interface BroadcastHooks {
  onRunSucceeded?(ctx: RunCtx, outcome: RunOutcome): Awaitable<void>
  onRunFailed?(ctx: RunCtx, error: PipelineError): Awaitable<void>
  onAfterReply?(ctx: ReplyCtx): Awaitable<void>
}

export interface LifecyclePlugin
  extends Partial<InterceptorHooks>,
    Partial<TransformHooks>,
    Partial<BroadcastHooks> {
  readonly name: string
  readonly priority?: number
}

/** Hook stage names — union for emit() routing. */
export type InterceptorStage = 'onAuthenticated' | 'onBeforeRun'
export type TransformStage = 'onStreamFrame' | 'onAfterRun' | 'onBeforeReply'
export type BroadcastStage = 'onRunSucceeded' | 'onRunFailed' | 'onAfterReply'
export type HookStage = InterceptorStage | TransformStage | BroadcastStage
