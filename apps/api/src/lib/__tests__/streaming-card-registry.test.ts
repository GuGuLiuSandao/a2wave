import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../logger.js', () => ({
  logger: { warn: vi.fn(), error: vi.fn(), info: vi.fn() },
}))
import type { FeishuStreamingCard } from '../feishu-card-streaming.js'
import {
  _resetForTesting,
  getStreamingCard,
  registerStreamingCard,
  shouldShowLocalChildOutput,
  shouldShowRemoteChildOutput,
  touchStreamingCard,
  unregisterStreamingCard,
} from '../streaming-card-registry.js'

describe('streaming-card-registry', () => {
  const fakeCard = { updateContent: () => {} } as unknown as FeishuStreamingCard

  beforeEach(() => {
    unregisterStreamingCard('card_1')
    unregisterStreamingCard('card_2')
  })

  it('registers and retrieves a card', async () => {
    registerStreamingCard('card_1', fakeCard)
    expect(getStreamingCard('card_1')).toBe(fakeCard)
  })

  it('returns undefined for unregistered cardId', async () => {
    expect(getStreamingCard('nonexistent')).toBeUndefined()
  })

  it('unregisters a card', async () => {
    registerStreamingCard('card_1', fakeCard)
    unregisterStreamingCard('card_1')
    expect(getStreamingCard('card_1')).toBeUndefined()
  })

  it('handles multiple cards independently', async () => {
    const fakeCard2 = { updateContent: () => {} } as unknown as FeishuStreamingCard
    registerStreamingCard('card_1', fakeCard)
    registerStreamingCard('card_2', fakeCard2)

    expect(getStreamingCard('card_1')).toBe(fakeCard)
    expect(getStreamingCard('card_2')).toBe(fakeCard2)

    unregisterStreamingCard('card_1')
    expect(getStreamingCard('card_1')).toBeUndefined()
    expect(getStreamingCard('card_2')).toBe(fakeCard2)
  })

  describe('showChildOutput switches', () => {
    it('returns true by default', async () => {
      registerStreamingCard('card_1', fakeCard)
      expect(shouldShowLocalChildOutput('card_1')).toBe(true)
      expect(shouldShowRemoteChildOutput('card_1')).toBe(true)
    })

    it('returns true for unregistered cardId', async () => {
      expect(shouldShowLocalChildOutput('nonexistent')).toBe(true)
      expect(shouldShowRemoteChildOutput('nonexistent')).toBe(true)
    })

    it('respects showLocalChildOutput=false', async () => {
      registerStreamingCard('card_1', fakeCard, { showLocalChildOutput: false })
      expect(shouldShowLocalChildOutput('card_1')).toBe(false)
      expect(shouldShowRemoteChildOutput('card_1')).toBe(true)
    })

    it('respects showRemoteChildOutput=false', async () => {
      registerStreamingCard('card_1', fakeCard, { showRemoteChildOutput: false })
      expect(shouldShowLocalChildOutput('card_1')).toBe(true)
      expect(shouldShowRemoteChildOutput('card_1')).toBe(false)
    })

    it('both can be false', async () => {
      registerStreamingCard('card_1', fakeCard, {
        showLocalChildOutput: false,
        showRemoteChildOutput: false,
      })
      expect(shouldShowLocalChildOutput('card_1')).toBe(false)
      expect(shouldShowRemoteChildOutput('card_1')).toBe(false)
    })
  })

  describe('TTL cleanup', () => {
    beforeEach(() => {
      _resetForTesting()
      vi.useFakeTimers()
    })

    afterEach(() => {
      _resetForTesting()
      vi.useRealTimers()
    })

    it('removes expired entries after TTL', async () => {
      registerStreamingCard('card_ttl', fakeCard)
      expect(getStreamingCard('card_ttl')).toBe(fakeCard)

      vi.advanceTimersByTime(130 * 60 * 1000)

      expect(getStreamingCard('card_ttl')).toBeUndefined()
    })

    it('keeps entries throughout the maximum agent run duration', async () => {
      registerStreamingCard('card_fresh', fakeCard)

      vi.advanceTimersByTime(120 * 60 * 1000)

      expect(getStreamingCard('card_fresh')).toBe(fakeCard)
    })

    it('renews the TTL when an active card is touched', async () => {
      registerStreamingCard('card_active', fakeCard)

      vi.advanceTimersByTime(120 * 60 * 1000)
      expect(touchStreamingCard('card_active')).toBe(true)
      expect(getStreamingCard('card_active')).toBe(fakeCard)

      vi.advanceTimersByTime(120 * 60 * 1000)
      expect(getStreamingCard('card_active')).toBe(fakeCard)
    })

    it('does not renew the TTL for a read-only lookup', async () => {
      registerStreamingCard('card_read', fakeCard)

      vi.advanceTimersByTime(120 * 60 * 1000)
      expect(getStreamingCard('card_read')).toBe(fakeCard)

      vi.advanceTimersByTime(10 * 60 * 1000)
      expect(getStreamingCard('card_read')).toBeUndefined()
    })

    it('does not create an entry when touching an unknown card', async () => {
      expect(touchStreamingCard('card_missing')).toBe(false)
      expect(getStreamingCard('card_missing')).toBeUndefined()
    })

    it('logs warning when entry expires', async () => {
      const { logger } = await import('../logger.js')

      registerStreamingCard('card_warn', fakeCard)
      vi.advanceTimersByTime(130 * 60 * 1000)

      expect(logger.warn).toHaveBeenCalledWith(
        { cardId: 'card_warn' },
        'Streaming card registry entry expired (TTL)',
      )
    })
  })
})
