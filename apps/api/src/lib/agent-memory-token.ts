import { randomBytes } from 'node:crypto'

export const TOKEN_TTL_MS = 6 * 60 * 60 * 1000
const TOKEN_CLEANUP_INTERVAL_MS = 10 * 60 * 1000
const MAX_TOKEN_STORE_SIZE = 10_000

export type RuntimeMemoryAction = 'topics:list' | 'topics:read' | 'search' | 'explicit:write'

export const RUNTIME_MEMORY_READ_ACTIONS: RuntimeMemoryAction[] = [
  'topics:list',
  'topics:read',
  'search',
]

const CHINESE_MEMORY_NEGATION = '(?:不要|不必|无需|无须|不用|请勿|禁止|别|甭)'

function stripQuotedMemoryInstructions(prompt: string): string {
  return prompt
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/`[^`\n]*`/g, ' ')
    .replace(/[“「『][^”」』\n]*[”」』]/g, ' ')
    .replace(/(["'])(?:\\.|(?!\1)[^\\\n])*\1/g, ' ')
    .replace(/^\s*>.*$/gm, ' ')
    .replace(/^\s*\[(?:user|assistant|system|tool)(?:-[^\]]+)?\]:.*$/gim, ' ')
}

/**
 * Direct writes are a separate capability from background extraction. Keep this
 * intentionally conservative: ambiguous durable statements are left to the
 * background extractor instead of being treated as write commands.
 */
export function isExplicitMemoryMutationRequest(prompt: string): boolean {
  const normalized = stripQuotedMemoryInstructions(prompt.normalize('NFKC')).trim().toLowerCase()
  if (!normalized) return false

  const excludesDirectWrite = [
    new RegExp(`${CHINESE_MEMORY_NEGATION}.{0,16}(?:记住|记忆|保存|存储|写入|记录|持久化)`),
    /(?:只需|仅需|只要).{0,12}(?:确认|理解|回答)/,
    /(?:你|是否|有没有|还).{0,8}记住(?:了|吗|没)/,
    /\b(?:do|did|can)\s+you\s+remember\b/,
    /\b(?:do not|don't|dont|no need to|please do not)\b.{0,32}\b(?:remember|save|store|write|record)\b/,
    /\b(?:only|just)\s+(?:acknowledge|confirm|understand|reply)\b/,
  ]
  if (excludesDirectWrite.some((pattern) => pattern.test(normalized))) return false

  const explicitMutation = [
    /(?:请|务必|帮我|麻烦)?\s*记住(?:这|那|以下|上述|：|:|\s)/,
    /(?:请|帮我|麻烦)?\s*(?:把|将)?.{0,40}记(?:到|入|进)(?:长期)?记忆/,
    /(?:请|帮我|麻烦)?\s*(?:把|将)?.{0,40}(?:保存|存储|写入|加入|添加)(?:到|至|进|入)?(?:长期)?记忆/,
    /(?:请|务必|帮我|麻烦)?\s*(?:把|将).{0,24}(?:长期(?:规则|知识|偏好)|固定规则).{0,24}(?:保存|存储|写入|加入|添加|记录)/,
    /(?:请|务必|帮我|麻烦)?\s*(?:把|将).{0,40}(?:保存|存储|写入|加入|添加|记录)(?:到|至|进|入).{0,16}主题/,
    /(?:请|务必|帮我|麻烦)?\s*(?:把|将).{0,40}记录(?:为|成)(?:一条)?(?:长期|固定)(?:规则|知识|偏好)/,
    /(?:请|务必|帮我|麻烦)?\s*(?:把|将).{0,40}(?:规则|知识|偏好|记忆|内容).{0,24}持久化/,
    /(?:请|帮我|麻烦)?\s*(?:更新|修改|更正|覆盖).{0,24}(?:长期)?记忆/,
    /(?:请|帮我|麻烦)?\s*(?:忘记|删除|移除|清除).{0,32}(?:记忆|记住的内容|这条|那条)/,
    /(?:从今以后|以后)(?:请|务必)?(?:都|始终|一律|总是)?\s*(?:按|使用|采用|遵循)/,
    /\b(?:please\s+)?remember(?:\s+(?:this|that|the following)|\s*[:])/,
    /\b(?:save|store|write|add|record)\b.{0,40}\b(?:to|in|into)\s+(?:long[- ]term\s+)?memory\b/,
    /\b(?:update|change|correct|overwrite)\b.{0,32}\bmemory\b/,
    /\b(?:forget|delete|remove|clear)\b.{0,40}\b(?:from\s+)?memory\b/,
    /\bfrom now on\b.{0,24}\b(?:always|please|use|follow)\b/,
  ]
  return explicitMutation.some((pattern) => pattern.test(normalized))
}

/**
 * Detect a user boundary that forbids this Run from being persisted into the
 * Agent's memory files. Run/audit records remain the system of record.
 */
export function isMemoryPersistenceOptOutRequest(prompt: string): boolean {
  const normalized = stripQuotedMemoryInstructions(prompt.normalize('NFKC')).trim().toLowerCase()
  if (!normalized) return false

  const explicitOptOut = [
    new RegExp(`${CHINESE_MEMORY_NEGATION}.{0,24}(?:长期保存|长期留存|持久化)`),
    new RegExp(
      `${CHINESE_MEMORY_NEGATION}.{0,24}(?:保存|存储|写入|加入|添加|记录|修改|变更|更新|更改).{0,16}(?:长期)?记忆`,
    ),
    new RegExp(
      `${CHINESE_MEMORY_NEGATION}[^，。；;！？!?\\n]{0,24}(?:记住|记(?:到|入|进)[^，。；;！？!?\\n]{0,16}(?:长期)?记忆)`,
    ),
    new RegExp(
      `(?:本次|这次|临时|一次性|只用于当前任务|仅用于当前任务|仅当前).{0,32}${CHINESE_MEMORY_NEGATION}.{0,24}(?:保存|留存|持久化|记忆)`,
    ),
    /\b(?:do not|don't|dont|never|no need to)\b.{0,40}\b(?:persist|remember|save|store|write|record)\b.{0,24}\b(?:memory|long[- ]term)\b/,
    /\b(?:temporary|this run only|current task only)\b.{0,40}\b(?:do not|don't|dont|never)\b.{0,32}\b(?:persist|remember|save|store)\b/,
  ]
  return explicitOptOut.some((pattern) => pattern.test(normalized))
}

export function runtimeMemoryActionsForPrompt(prompt: string): RuntimeMemoryAction[] {
  return isExplicitMemoryMutationRequest(prompt)
    ? [...RUNTIME_MEMORY_READ_ACTIONS, 'explicit:write']
    : [...RUNTIME_MEMORY_READ_ACTIONS]
}

export interface RuntimeMemoryTokenClaims {
  agentId: string
  runStepId: string
  bundleVersion: string
  allowedActions: RuntimeMemoryAction[]
  maxTopicReads: number
  maxTopicTokens: number
  issuedAt: number
  expiresAt: number
}

interface TokenEntry extends RuntimeMemoryTokenClaims {
  topicReads: number
  topicTokens: number
}

const tokenStore = new Map<string, TokenEntry>()

function createToken(): string {
  return randomBytes(32).toString('base64url')
}

export function clearExpiredAgentTokens(now = Date.now()): number {
  let deleted = 0
  for (const [token, entry] of tokenStore.entries()) {
    if (now > entry.expiresAt) {
      tokenStore.delete(token)
      deleted++
    }
  }
  return deleted
}

function enforceTokenStoreLimit(): void {
  if (tokenStore.size <= MAX_TOKEN_STORE_SIZE) return

  const overflow = tokenStore.size - MAX_TOKEN_STORE_SIZE
  const oldestTokens = [...tokenStore.entries()]
    .sort(([, a], [, b]) => a.expiresAt - b.expiresAt || a.issuedAt - b.issuedAt)
    .slice(0, overflow)

  for (const [token] of oldestTokens) {
    tokenStore.delete(token)
  }
}

export function registerAgentToken(
  agentId: string,
  options?: Partial<
    Pick<
      RuntimeMemoryTokenClaims,
      'runStepId' | 'bundleVersion' | 'allowedActions' | 'maxTopicReads' | 'maxTopicTokens'
    >
  >,
): string {
  const now = Date.now()
  clearExpiredAgentTokens(now)
  const token = createToken()
  tokenStore.set(token, {
    agentId,
    runStepId: options?.runStepId ?? `memory_${randomBytes(8).toString('hex')}`,
    bundleVersion: options?.bundleVersion ?? 'memory-v2',
    allowedActions: options?.allowedActions ?? [...RUNTIME_MEMORY_READ_ACTIONS],
    maxTopicReads: options?.maxTopicReads ?? 3,
    maxTopicTokens: options?.maxTopicTokens ?? 4000,
    issuedAt: now,
    expiresAt: now + TOKEN_TTL_MS,
    topicReads: 0,
    topicTokens: 0,
  })
  enforceTokenStoreLimit()
  return token
}

export function validateAgentToken(token: string): string | null {
  const entry = tokenStore.get(token)
  if (!entry) return null
  if (Date.now() > entry.expiresAt) {
    tokenStore.delete(token)
    return null
  }
  return entry.agentId
}

export function getRuntimeMemoryTokenClaims(token: string): RuntimeMemoryTokenClaims | null {
  if (!validateAgentToken(token)) return null
  const entry = tokenStore.get(token)
  if (!entry) return null
  return {
    agentId: entry.agentId,
    runStepId: entry.runStepId,
    bundleVersion: entry.bundleVersion,
    allowedActions: [...entry.allowedActions],
    maxTopicReads: entry.maxTopicReads,
    maxTopicTokens: entry.maxTopicTokens,
    issuedAt: entry.issuedAt,
    expiresAt: entry.expiresAt,
  }
}

export function agentTokenAllows(token: string, action: RuntimeMemoryAction): boolean {
  const claims = getRuntimeMemoryTokenClaims(token)
  return claims?.allowedActions.includes(action) ?? false
}

export function consumeAgentTopicRead(
  token: string,
  topicTokens: number,
): {
  ok: boolean
  reason?: 'token_invalid' | 'action_forbidden' | 'read_limit' | 'token_limit'
  remainingReads: number
  remainingTokens: number
} {
  const entry = tokenStore.get(token)
  if (!entry || Date.now() > entry.expiresAt) {
    if (entry) tokenStore.delete(token)
    return { ok: false, reason: 'token_invalid', remainingReads: 0, remainingTokens: 0 }
  }
  if (!entry.allowedActions.includes('topics:read')) {
    return {
      ok: false,
      reason: 'action_forbidden',
      remainingReads: Math.max(0, entry.maxTopicReads - entry.topicReads),
      remainingTokens: Math.max(0, entry.maxTopicTokens - entry.topicTokens),
    }
  }
  if (entry.topicReads + 1 > entry.maxTopicReads) {
    return {
      ok: false,
      reason: 'read_limit',
      remainingReads: 0,
      remainingTokens: Math.max(0, entry.maxTopicTokens - entry.topicTokens),
    }
  }
  if (entry.topicTokens + topicTokens > entry.maxTopicTokens) {
    return {
      ok: false,
      reason: 'token_limit',
      remainingReads: Math.max(0, entry.maxTopicReads - entry.topicReads),
      remainingTokens: Math.max(0, entry.maxTopicTokens - entry.topicTokens),
    }
  }

  entry.topicReads++
  entry.topicTokens += topicTokens
  return {
    ok: true,
    remainingReads: entry.maxTopicReads - entry.topicReads,
    remainingTokens: entry.maxTopicTokens - entry.topicTokens,
  }
}

export function revokeAgentToken(token: string): void {
  tokenStore.delete(token)
}

export function revokeAgentTokensForAgent(agentId: string): number {
  let deleted = 0
  for (const [token, entry] of tokenStore.entries()) {
    if (entry.agentId === agentId) {
      tokenStore.delete(token)
      deleted++
    }
  }
  return deleted
}

export function clearAgentTokenStoreForTest(): void {
  tokenStore.clear()
}

export function getAgentTokenStoreSizeForTest(): number {
  return tokenStore.size
}

const cleanupTimer = setInterval(() => {
  clearExpiredAgentTokens()
}, TOKEN_CLEANUP_INTERVAL_MS)

cleanupTimer.unref?.()
