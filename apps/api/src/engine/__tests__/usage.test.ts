import { describe, expect, it } from 'vitest'
import {
  accumulateUsage,
  extractClaudeStyleUsage,
  mapCodexUsage,
  mapOpencodeUsage,
} from '../usage.js'

describe('extractClaudeStyleUsage', () => {
  it('extracts complete usage', async () => {
    expect(
      extractClaudeStyleUsage({
        type: 'result',
        subtype: 'success',
        usage: {
          input_tokens: 4,
          output_tokens: 520,
          cache_read_input_tokens: 14000,
          cache_creation_input_tokens: 2200,
        },
      }),
    ).toEqual({
      inputTokens: 4,
      outputTokens: 520,
      cacheReadTokens: 14000,
      cacheWriteTokens: 2200,
    })
  })

  it('returns undefined when usage is absent', async () => {
    expect(extractClaudeStyleUsage({ type: 'result', subtype: 'success' })).toBeUndefined()
  })

  it('ignores non-numeric fields', async () => {
    expect(extractClaudeStyleUsage({ usage: { input_tokens: '4', output_tokens: 10 } })).toEqual({
      outputTokens: 10,
    })
  })
})

describe('mapOpencodeUsage', () => {
  it('maps input, output, reasoning, and cache fields without using redundant total', async () => {
    expect(
      mapOpencodeUsage({
        inputTokens: 90,
        outputTokens: 10,
        reasoningTokens: 3,
        totalTokens: 100,
        cacheReadTokens: 5,
        cacheWriteTokens: 2,
      }),
    ).toEqual({
      inputTokens: 90,
      outputTokens: 10,
      reasoningTokens: 3,
      cacheReadTokens: 5,
      cacheWriteTokens: 2,
    })
  })

  it('returns undefined for missing or empty usage', async () => {
    expect(mapOpencodeUsage(undefined)).toBeUndefined()
    expect(mapOpencodeUsage({})).toBeUndefined()
  })

  it('preserves reasoning when it is the only reported usage field', async () => {
    expect(mapOpencodeUsage({ reasoningTokens: 3, totalTokens: 100 })).toEqual({
      reasoningTokens: 3,
    })
  })
})

describe('mapCodexUsage', () => {
  it('subtracts cached input when normalizing OpenAI usage', async () => {
    expect(mapCodexUsage({ inputTokens: 100, cachedInputTokens: 80, outputTokens: 20 })).toEqual({
      inputTokens: 20,
      cacheReadTokens: 80,
      outputTokens: 20,
    })
  })

  it('clamps uncached input to zero when cached input is unexpectedly larger', async () => {
    expect(mapCodexUsage({ inputTokens: 50, cachedInputTokens: 80 })).toEqual({
      inputTokens: 0,
      cacheReadTokens: 80,
    })
  })

  it('preserves input when cached input is absent', async () => {
    expect(mapCodexUsage({ inputTokens: 100, outputTokens: 20 })).toEqual({
      inputTokens: 100,
      outputTokens: 20,
    })
  })

  it('returns undefined for missing or empty usage', async () => {
    expect(mapCodexUsage(undefined)).toBeUndefined()
    expect(mapCodexUsage({})).toBeUndefined()
  })
})

describe('accumulateUsage', () => {
  it('adds each field and initializes from the first delta', async () => {
    const round1 = accumulateUsage(undefined, { inputTokens: 100, outputTokens: 10 })
    expect(round1).toEqual({ inputTokens: 100, outputTokens: 10 })
    const round2 = accumulateUsage(round1, {
      inputTokens: 40,
      outputTokens: 6,
      reasoningTokens: 4,
      cacheReadTokens: 50,
    })
    expect(round2).toEqual({
      inputTokens: 140,
      outputTokens: 16,
      reasoningTokens: 4,
      cacheReadTokens: 50,
    })
  })

  it('keeps fields omitted by every delta undefined', async () => {
    const acc = accumulateUsage({ inputTokens: 10 }, { outputTokens: 5 })
    expect(acc).toEqual({ inputTokens: 10, outputTokens: 5 })
    expect(acc?.cacheReadTokens).toBeUndefined()
  })

  it('returns the original total for an empty delta', async () => {
    expect(accumulateUsage({ inputTokens: 10 }, {})).toEqual({ inputTokens: 10 })
    expect(accumulateUsage(undefined, {})).toBeUndefined()
  })
})
