import { describe, expect, it } from 'vitest'
import { agentFormSchema } from '../validation'

describe('agentFormSchema timeoutMinutes', () => {
  const timeoutMinutesSchema = agentFormSchema.shape.timeoutMinutes

  it('accepts the 120 minute upper limit', () => {
    expect(timeoutMinutesSchema.parse(120)).toBe(120)
  })

  it('rejects values above 120 minutes', () => {
    expect(() => timeoutMinutesSchema.parse(121)).toThrow()
  })
})
