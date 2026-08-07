import type { TokenUsage } from './types.js'

/** Engine error carrying tokens consumed before the execution failed. */
export interface ErrorWithUsage extends Error {
  usage?: TokenUsage
}

/** Attach a usage snapshot to an engine error without changing its identity. */
export function attachUsageToError(error: Error, usage?: TokenUsage): ErrorWithUsage {
  const errorWithUsage = error as ErrorWithUsage
  if (usage) errorWithUsage.usage = usage
  return errorWithUsage
}

/** Read token usage attached to a thrown engine error. */
export function extractUsageFromError(error: unknown): TokenUsage | undefined {
  if (!(error instanceof Error)) return undefined
  const usage = (error as ErrorWithUsage).usage
  return usage && typeof usage === 'object' ? usage : undefined
}

/**
 * Parse token usage from Claude Code / Cursor-style result events.
 * Expected shape: { usage: { input_tokens, output_tokens, cache_read_input_tokens,
 * cache_creation_input_tokens } }. Non-numeric fields are ignored.
 */
export function extractClaudeStyleUsage(data: Record<string, unknown>): TokenUsage | undefined {
  const usage =
    data.usage && typeof data.usage === 'object' && !Array.isArray(data.usage)
      ? (data.usage as Record<string, unknown>)
      : undefined
  const out: TokenUsage = {}
  if (usage) {
    if (typeof usage.input_tokens === 'number') out.inputTokens = usage.input_tokens
    if (typeof usage.output_tokens === 'number') out.outputTokens = usage.output_tokens
    if (typeof usage.cache_read_input_tokens === 'number')
      out.cacheReadTokens = usage.cache_read_input_tokens
    if (typeof usage.cache_creation_input_tokens === 'number')
      out.cacheWriteTokens = usage.cache_creation_input_tokens
  }
  return Object.keys(out).length > 0 ? out : undefined
}

/**
 * Normalize step_finish usage emitted by opencode-stream-parser.
 * Reasoning is reported separately from output by OpenCode; total is redundant.
 *
 * In OpenCode's step_finish shape, input and cache.read are separate fields
 * (Anthropic semantics), so cache reads are not subtracted from input. This
 * intentionally differs from Codex, where cached input is a subset of input.
 * Each step_finish reports one API call rather than a session total, so callers
 * accumulate all steps.
 */
export function mapOpencodeUsage(u?: {
  inputTokens?: number
  outputTokens?: number
  reasoningTokens?: number
  totalTokens?: number
  cacheReadTokens?: number
  cacheWriteTokens?: number
}): TokenUsage | undefined {
  if (!u) return undefined
  const out: TokenUsage = {}
  if (typeof u.inputTokens === 'number') out.inputTokens = u.inputTokens
  if (typeof u.outputTokens === 'number') out.outputTokens = u.outputTokens
  if (typeof u.reasoningTokens === 'number') out.reasoningTokens = u.reasoningTokens
  if (typeof u.cacheReadTokens === 'number') out.cacheReadTokens = u.cacheReadTokens
  if (typeof u.cacheWriteTokens === 'number') out.cacheWriteTokens = u.cacheWriteTokens
  return Object.keys(out).length > 0 ? out : undefined
}

/**
 * Normalize turn_completed usage emitted by codex-stream-parser.
 * OpenAI reports cached_input_tokens as a subset of input_tokens. The platform
 * stores uncached input separately, so cached input is subtracted here.
 */
export function mapCodexUsage(u?: {
  inputTokens?: number
  cachedInputTokens?: number
  outputTokens?: number
}): TokenUsage | undefined {
  if (!u) return undefined
  const out: TokenUsage = {}
  if (typeof u.inputTokens === 'number') {
    out.inputTokens =
      typeof u.cachedInputTokens === 'number'
        ? Math.max(0, u.inputTokens - u.cachedInputTokens)
        : u.inputTokens
  }
  if (typeof u.outputTokens === 'number') out.outputTokens = u.outputTokens
  if (typeof u.cachedInputTokens === 'number') out.cacheReadTokens = u.cachedInputTokens
  return Object.keys(out).length > 0 ? out : undefined
}

const TOKEN_USAGE_FIELDS = [
  'inputTokens',
  'outputTokens',
  'reasoningTokens',
  'cacheReadTokens',
  'cacheWriteTokens',
] as const

/**
 * Accumulate usage field by field across turns or API calls.
 * Missing delta fields remain undefined instead of becoming zero.
 */
export function accumulateUsage(
  target: TokenUsage | undefined,
  delta: TokenUsage,
): TokenUsage | undefined {
  let out = target
  for (const field of TOKEN_USAGE_FIELDS) {
    const value = delta[field]
    if (typeof value !== 'number') continue
    out = out === target ? { ...target } : out
    ;(out as TokenUsage)[field] = (out?.[field] ?? 0) + value
  }
  return out
}
