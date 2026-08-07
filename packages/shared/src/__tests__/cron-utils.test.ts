import { describe, expect, it } from 'vitest'
import { isSupportedScheduleCron } from '../cron-utils.js'

describe('isSupportedScheduleCron', () => {
  it('accepts supported 5-field schedule cron expressions', () => {
    expect(isSupportedScheduleCron('0 9 * * *')).toBe(true)
    expect(isSupportedScheduleCron('0 7,19 * * *')).toBe(true)
    expect(isSupportedScheduleCron('0 7-23/12 * * *')).toBe(true)
    expect(isSupportedScheduleCron('*/30 * * * *')).toBe(true)
  })

  it('rejects unsupported or non-5-field cron expressions', () => {
    expect(isSupportedScheduleCron('0 7/12 * * *')).toBe(false)
    expect(isSupportedScheduleCron('')).toBe(false)
    expect(isSupportedScheduleCron('0 9 * *')).toBe(false)
    expect(isSupportedScheduleCron('not a cron')).toBe(false)
  })
})
