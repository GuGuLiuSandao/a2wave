import { afterEach, describe, expect, it, vi } from 'vitest'
import { createShareToken, validateShareToken } from '../agent-share.js'

describe('agent-share', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('creates a token that validates successfully', async () => {
    const token = createShareToken('agt_test123')
    expect(token).toBeTruthy()
    expect(typeof token).toBe('string')
    expect(token.length).toBeGreaterThan(10)

    const agentId = validateShareToken(token)
    expect(agentId).toBe('agt_test123')
  })

  it('returns null for invalid token', async () => {
    const result = validateShareToken('nonexistent-token')
    expect(result).toBeNull()
  })

  it('returns null for expired token', async () => {
    const token = createShareToken('agt_expired')

    // Fast-forward time past 24h
    vi.useFakeTimers()
    vi.setSystemTime(Date.now() + 25 * 60 * 60 * 1000) // 25 hours later

    const result = validateShareToken(token)
    expect(result).toBeNull()

    vi.useRealTimers()
  })

  it('creates unique tokens for same agent', async () => {
    const token1 = createShareToken('agt_same')
    const token2 = createShareToken('agt_same')
    expect(token1).not.toBe(token2)

    // Both should still be valid
    expect(validateShareToken(token1)).toBe('agt_same')
    expect(validateShareToken(token2)).toBe('agt_same')
  })
})
