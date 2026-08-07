import { describe, expect, it } from 'vitest'
import { runTokenSelect, stepTokenSelect, toTokenTotals } from '../token-stats.js'

describe('toTokenTotals', () => {
  it('maps a missing aggregate row to zero totals', async () => {
    expect(toTokenTotals(undefined)).toEqual({
      input: 0,
      output: 0,
      reasoning: 0,
      cacheRead: 0,
      cacheWrite: 0,
    })
  })

  it('maps each nullable aggregate field to zero independently', async () => {
    expect(
      toTokenTotals({
        input: null,
        output: null,
        reasoning: null,
        cacheRead: null,
        cacheWrite: null,
      }),
    ).toEqual({ input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0 })
  })

  it('preserves available fields while mapping null fields to zero', async () => {
    expect(
      toTokenTotals({ input: 1200, output: 300, reasoning: 75, cacheRead: null, cacheWrite: 800 }),
    ).toEqual({ input: 1200, output: 300, reasoning: 75, cacheRead: 0, cacheWrite: 800 })
  })

  it('normalizes both a real zero and a null aggregate to zero', async () => {
    expect(
      toTokenTotals({ input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0 }),
    ).toEqual({
      input: 0,
      output: 0,
      reasoning: 0,
      cacheRead: 0,
      cacheWrite: 0,
    })
  })
})

describe('runTokenSelect / stepTokenSelect', () => {
  it('builds the five run aggregation fields lazily', async () => {
    const sel = runTokenSelect()
    expect(Object.keys(sel).sort()).toEqual([
      'cacheRead',
      'cacheWrite',
      'input',
      'output',
      'reasoning',
    ])
  })

  it('builds the five step aggregation fields lazily', async () => {
    const sel = stepTokenSelect()
    expect(Object.keys(sel).sort()).toEqual([
      'cacheRead',
      'cacheWrite',
      'input',
      'output',
      'reasoning',
    ])
  })

  it('returns a new selection object for each call', async () => {
    expect(runTokenSelect()).not.toBe(runTokenSelect())
    expect(stepTokenSelect()).not.toBe(stepTokenSelect())
  })
})
