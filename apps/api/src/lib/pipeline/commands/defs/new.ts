/**
 * /new — 强制开启新 LLM 会话。
 *
 * applySession 返回 override:null → 调用方把 previousChatId 清空。
 * 三 engine 都通过（无 provider 限定）。瞬时操作无 longRunningAck。
 *
 * emptyTextFallback：bare `/new`（无附带文本）也走完整 pipeline，让引擎产生一条
 * completed run + 新 chatId，使下次 lookupPreviousChatId 不再命中旧 session。
 *
 * allowedContexts: ['p2p']：群聊和 thread reply 各自有原生的"开新会话"方式（群里
 * 发顶层消息、话题回复链外发新话题），只有 P2P 顶层用户无法主动重置会话——所以
 * /new 仅在 P2P 顶层有效，群/thread 里发 "/new ..." 等同普通文本，dispatcher
 * 不激活命令逻辑，也不剥前缀。
 */
import { createCommandPlugin } from '../factory.js'

export const newCommandPlugin = createCommandPlugin({
  commandName: 'new',
  prefixes: ['/new'],
  allowedContexts: ['p2p'],
  emptyTextFallback: '新会话已开始',
  applySession: () => ({ override: null }),
})
