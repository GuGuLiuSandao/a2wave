import { describe, expect, it } from 'vitest'
import { formatTokens, sumTokenUsage } from '../format-tokens'

describe('sumTokenUsage', () => {
  it('sums all five disjoint token buckets', () => {
    expect(
      sumTokenUsage({ input: 10, output: 5, reasoning: 3, cacheRead: 20, cacheWrite: 2 }),
    ).toBe(40)
  })

  it('treats missing buckets as zero', () => {
    expect(sumTokenUsage({ input: 10, output: 5 })).toBe(15)
  })
})

describe('formatTokens billion range', () => {
  it('promotes rounded values instead of rendering 1000.0M', () => {
    expect(formatTokens(999_950_000)).toBe('1.0B')
    expect(formatTokens(1_500_000_000)).toBe('1.5B')
    expect(formatTokens(2_500_000_000)).toBe('2.5B')
  })

  it('keeps values below the rounding threshold in the million range', () => {
    expect(formatTokens(999_940_000)).toBe('999.9M')
  })
})

describe('formatTokens', () => {
  it('renders missing values as an em dash', () => {
    expect(formatTokens(null)).toBe('—')
    expect(formatTokens(undefined)).toBe('—')
  })
  it('renders values below one thousand without abbreviation', () => {
    expect(formatTokens(0)).toBe('0')
    expect(formatTokens(950)).toBe('950')
  })
  it('uses one decimal place for thousand and million suffixes', () => {
    expect(formatTokens(12345)).toBe('12.3K')
    expect(formatTokens(4560000)).toBe('4.6M')
  })
  it('promotes rounded thousands to the million suffix', () => {
    expect(formatTokens(999)).toBe('999')
    expect(formatTokens(1000)).toBe('1.0K')
    expect(formatTokens(999949)).toBe('999.9K')
    expect(formatTokens(999950)).toBe('1.0M')
    expect(formatTokens(999999)).toBe('1.0M')
    expect(formatTokens(1000000)).toBe('1.0M')
  })
})
