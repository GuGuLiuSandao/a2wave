/**
 * core:command-dispatch — pipeline 基础设施 plugin。
 *
 * 通过闭包持有所有 CommandPlugin，在 onAuthenticated 阶段做前缀仲裁并
 * 把命中结果写入 ctx.matchedCommand / strippedText / pendingCommandPlugin。
 * 各 CommandPlugin 自己的 onBeforeRun 钩子读这些字段决定是否激活。
 *
 * dispatcher 的 priority 必须小于 cmd plugin priority（factory 默认 20），
 * 确保仲裁先跑、命令 plugin 后跑。
 *
 * 没有 abort 路径：未注册或当前上下文不允许的命令 =
 * silent fall-through 当普通文本走 LLM。
 */

import type { AbortableDecision, AuthenticatedCtx, LifecyclePlugin, MatchedCtx } from '../types.js'
import { matchByLongestPrefix } from './prefix-matcher.js'
import type { CommandPlugin } from './types.js'

const PRIORITY_DISPATCH = 10

function deriveCurrentContext(ctx: AuthenticatedCtx): 'p2p' | 'group' | 'thread' {
  // isThreadReply 优先于 chatType：话题/回复链中的消息一律算 'thread'，
  // 这样想"在所有 thread 上禁用 X"的 command 只需写 allowedContexts: ['p2p','group']。
  if (ctx.messageContext.isThreadReply) return 'thread'
  return ctx.messageContext.chatType
}

export function createCommandDispatchPlugin(cmdPlugins: readonly CommandPlugin[]): LifecyclePlugin {
  return {
    name: 'core:command-dispatch',
    priority: PRIORITY_DISPATCH,

    async onAuthenticated(ctx): Promise<AbortableDecision> {
      const mctx = ctx as AuthenticatedCtx & MatchedCtx
      // 默认 strippedText = rawText（无命中时下游照样能用）
      mctx.strippedText = ctx.rawText

      const match = matchByLongestPrefix(ctx.rawText, cmdPlugins)
      if (!match) return null

      const { plugin, rest } = match
      const currentContext = deriveCurrentContext(ctx)
      const isAllowed =
        plugin.allowedContexts === undefined || plugin.allowedContexts.includes(currentContext)

      if (!isAllowed) {
        // Disallowed context：等同未命中，整条 rawText 原样透传给下游。
        // 不挂 pendingCommandPlugin → cmd plugin 的 onBeforeRun 不激活，
        // applySession 不跑，session 不重置。
        return null
      }

      // 命中：写 matchedCommand + 处理 emptyTextFallback
      mctx.matchedCommand = plugin.commandName
      mctx.strippedText =
        rest === '' && plugin.emptyTextFallback !== undefined ? plugin.emptyTextFallback : rest
      mctx.pendingCommandPlugin = plugin
      return null
    },
  }
}
