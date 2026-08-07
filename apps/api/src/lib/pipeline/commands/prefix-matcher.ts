/**
 * 命令前缀仲裁——把消息原文匹配到一个具体 CommandPlugin。
 *
 * 算法（与旧 `commands/plugin.ts` 的 `tryMatchPrefix` 行为等价）：
 *   1. trim 行首空白（trailing 不动）
 *   2. 按 command plugin 注册顺序遍历候选
 *   3. 单个 plugin 内：把 plugin.prefixes 过滤掉空字符串、按长度倒序
 *   4. 逐个 startsWith；命中后再做 word-boundary 检查（前缀后必须是 EOS 或空白）
 *   5. 首个通过 word-boundary 的命中胜出，返回 { plugin, rest }
 *
 * 不引入"全局最长前缀"：word-boundary 已经天然区分 `/foo` vs `/foobar`
 * （后者 `b` 不是空白会被拒绝）。两个 command 真发生前缀冲突或 CJK 粘连
 * 前缀时再考虑全局最长——本期 ASCII 单命令场景下不需要。
 *
 * 不读 channelConfig：channel disable / prefix override / legacy
 * newSessionPrefixes 整套已删除，命令前缀就是 plugin.prefixes 本身。
 */

import type { CommandPlugin } from './types.js'

export interface PrefixMatchResult {
  plugin: CommandPlugin
  rest: string
}

export function matchByLongestPrefix(
  rawText: string | undefined,
  candidates: readonly CommandPlugin[],
): PrefixMatchResult | null {
  const trimmed = (rawText ?? '').trimStart()
  if (trimmed.length === 0) return null

  for (const plugin of candidates) {
    const ordered = [...plugin.prefixes]
      .filter((p) => p.length > 0)
      .sort((a, b) => b.length - a.length)
    for (const prefix of ordered) {
      if (!trimmed.startsWith(prefix)) continue
      const after = trimmed.slice(prefix.length)
      // Word boundary：前缀之后必须是字符串结尾或紧跟空白字符。
      // 否则 "/newer" 之类会误命中 "/new"。
      if (after.length > 0 && !/^\s/.test(after)) continue
      return { plugin, rest: after.trimStart() }
    }
  }
  return null
}
