import { describe, expect, it } from 'vitest'
import { cronToPreset, presetToCron } from '../cron-utils'

describe('presetToCron', () => {
  it('generates daily cron', () => {
    expect(presetToCron('daily', '09:30')).toBe('30 9 * * *')
  })

  it('generates weekly cron with weekday', () => {
    expect(presetToCron('weekly', '08:00', 3)).toBe('0 8 * * 3')
  })

  it('defaults weekday to 1 (Monday)', () => {
    expect(presetToCron('weekly', '14:15')).toBe('15 14 * * 1')
  })

  it('generates monthly cron with day', () => {
    expect(presetToCron('monthly', '06:00', undefined, 15)).toBe('0 6 15 * *')
  })

  it('defaults monthDay to 1', () => {
    expect(presetToCron('monthly', '23:59')).toBe('59 23 1 * *')
  })

  it('handles empty string time gracefully', () => {
    expect(presetToCron('daily', '')).toBe('0 0 * * *')
  })

  it('handles undefined-like time gracefully', () => {
    expect(presetToCron('daily', undefined as unknown as string)).toBe('0 0 * * *')
  })

  it('handles malformed time with single segment', () => {
    expect(presetToCron('daily', '9')).toBe('0 9 * * *')
  })
})

describe('cronToPreset', () => {
  it('parses daily cron', () => {
    expect(cronToPreset('30 9 * * *')).toEqual({
      preset: 'daily',
      time: '09:30',
    })
  })

  it('parses weekly cron', () => {
    expect(cronToPreset('0 8 * * 3')).toEqual({
      preset: 'weekly',
      time: '08:00',
      weekday: 3,
    })
  })

  it('parses monthly cron', () => {
    expect(cronToPreset('0 6 15 * *')).toEqual({
      preset: 'monthly',
      time: '06:00',
      monthDay: 15,
    })
  })

  it('returns null for complex cron', () => {
    expect(cronToPreset('*/5 * * * *')).toBeNull()
  })

  it('returns null for cron with month restriction', () => {
    expect(cronToPreset('0 9 1 3 *')).toBeNull()
  })

  it('returns null for invalid field count', () => {
    expect(cronToPreset('0 9 * *')).toBeNull()
  })
})
