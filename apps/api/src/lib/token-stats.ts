/**
 * Shared token aggregation SQL and mapping used by run and agent routes.
 */

import { sql } from 'drizzle-orm'
import { runSteps, runs } from '../db/schema.js'
import { jsonExtractNumber } from './json-sql.js'

/**
 * Run totals come from the five cumulative columns on runs.
 * SUM returns NULL for historical rows with no usage; toTokenTotals maps that to zero.
 * Build lazily to avoid dereferencing partial mocked schemas during module import.
 */
export function runTokenSelect() {
  return {
    input: sql<number | null>`SUM(${runs.inputTokens})`,
    output: sql<number | null>`SUM(${runs.outputTokens})`,
    reasoning: sql<number | null>`SUM(${runs.reasoningTokens})`,
    cacheRead: sql<number | null>`SUM(${runs.cacheReadTokens})`,
    cacheWrite: sql<number | null>`SUM(${runs.cacheWriteTokens})`,
  }
}

/**
 * Per-turn totals come from runSteps.output.usage. Each conversation turn has
 * its own row and createdAt timestamp, so today's usage is attributed to when
 * the turn occurred instead of when the parent run was first created.
 */
/**
 * Sum one usage figure across the selected steps.
 *
 * Goes through jsonExtractNumber rather than inline `json_extract` so the same
 * aggregate works on both backends — the two dialects share no JSON syntax.
 */
function sumUsage(field: string) {
  return sql<number | null>`SUM(${jsonExtractNumber(runSteps.output, ['usage', field])})`
}

export function stepTokenSelect() {
  return {
    input: sumUsage('inputTokens'),
    output: sumUsage('outputTokens'),
    reasoning: sumUsage('reasoningTokens'),
    cacheRead: sumUsage('cacheReadTokens'),
    cacheWrite: sumUsage('cacheWriteTokens'),
  }
}

export interface TokenTotals {
  input: number
  output: number
  reasoning: number
  cacheRead: number
  cacheWrite: number
}

export function toTokenTotals(row?: {
  input: number | null
  output: number | null
  reasoning: number | null
  cacheRead: number | null
  cacheWrite: number | null
}): TokenTotals {
  return {
    input: row?.input ?? 0,
    output: row?.output ?? 0,
    reasoning: row?.reasoning ?? 0,
    cacheRead: row?.cacheRead ?? 0,
    cacheWrite: row?.cacheWrite ?? 0,
  }
}
