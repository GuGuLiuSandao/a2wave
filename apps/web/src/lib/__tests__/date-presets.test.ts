import dayjs from 'dayjs'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DATE_PRESETS_WITH_ALL, getPresetDateRange } from '../date-presets'

describe('getPresetDateRange', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-07-29T15:30:00.000Z'))
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('spans whole days so a range never clips today’s entries', () => {
    const { start, end } = getPresetDateRange('1d')
    // Truncating to "now" would hide anything logged later today.
    expect(dayjs(start).isSame(dayjs().subtract(1, 'day').startOf('day'))).toBe(true)
    expect(dayjs(end).isSame(dayjs().endOf('day'))).toBe(true)
  })

  it.each([
    ['7d', 7],
    ['30d', 30],
  ] as const)('resolves %s to a %i-day window', (preset, days) => {
    const { start } = getPresetDateRange(preset)
    expect(dayjs(start).isSame(dayjs().subtract(days, 'day').startOf('day'))).toBe(true)
  })

  it('returns no bounds for "all" and "custom"', () => {
    // "all" means unfiltered; "custom" means the user supplies the dates.
    expect(getPresetDateRange('all')).toEqual({})
    expect(getPresetDateRange('custom')).toEqual({})
  })

  it('offers "all" first so the default reads as unfiltered', () => {
    expect(DATE_PRESETS_WITH_ALL[0].value).toBe('all')
  })
})
