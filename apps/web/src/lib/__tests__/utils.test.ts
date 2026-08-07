import i18n from '@/i18n'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cn, formatRelativeTime } from '../utils'

describe('cn', () => {
  it('merges class names', () => {
    expect(cn('px-2', 'py-1')).toBe('px-2 py-1')
  })

  it('resolves tailwind conflicts', () => {
    expect(cn('px-2', 'px-4')).toBe('px-4')
  })

  it('handles conditional classes', () => {
    expect(cn('base', false && 'hidden', 'extra')).toBe('base extra')
  })
})

describe('formatRelativeTime', () => {
  const at = (now: string, then: string) => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date(now))
    return formatRelativeTime(new Date(then))
  }

  beforeEach(async () => {
    await i18n.changeLanguage('en')
  })

  afterEach(async () => {
    vi.useRealTimers()
    await i18n.changeLanguage('en')
  })

  // Assert literal copy rather than re-deriving it with i18n.t(): comparing the
  // implementation against the same call it makes would pass even if the wrong
  // plural form were selected.
  describe('en', () => {
    it('renders the never copy for null/undefined/invalid input', () => {
      expect(formatRelativeTime(null)).toBe('Never')
      expect(formatRelativeTime(undefined)).toBe('Never')
      expect(formatRelativeTime('not-a-date')).toBe('Never')
    })

    it('renders the just-now copy under a minute', () => {
      expect(at('2025-01-15T12:00:30Z', '2025-01-15T12:00:00Z')).toBe('Just now')
    })

    it('renders minutes', () => {
      expect(at('2025-01-15T12:01:00Z', '2025-01-15T12:00:00Z')).toBe('1 min ago')
      expect(at('2025-01-15T12:05:00Z', '2025-01-15T12:00:00Z')).toBe('5 min ago')
    })

    it('singularises one hour and pluralises the rest', () => {
      expect(at('2025-01-15T13:00:00Z', '2025-01-15T12:00:00Z')).toBe('1 hour ago')
      expect(at('2025-01-15T15:00:00Z', '2025-01-15T12:00:00Z')).toBe('3 hours ago')
    })

    it('singularises one day and pluralises the rest', () => {
      expect(at('2025-01-16T12:00:00Z', '2025-01-15T12:00:00Z')).toBe('1 day ago')
      expect(at('2025-01-17T12:00:00Z', '2025-01-15T12:00:00Z')).toBe('2 days ago')
    })

    it('handles unix timestamps in seconds', () => {
      vi.useFakeTimers()
      vi.setSystemTime(new Date('2025-01-15T12:05:00Z'))
      const ts = Math.floor(new Date('2025-01-15T12:00:00Z').getTime() / 1000)
      expect(formatRelativeTime(ts)).toBe('5 min ago')
    })
  })

  describe('zh', () => {
    beforeEach(async () => {
      await i18n.changeLanguage('zh')
    })

    it('renders the never copy', () => {
      expect(formatRelativeTime(null)).toBe('\u4ece\u672a')
    })

    it('renders the just-now copy under a minute', () => {
      expect(at('2025-01-15T12:00:30Z', '2025-01-15T12:00:00Z')).toBe('\u521a\u521a')
    })

    it('uses one form for any count', () => {
      expect(at('2025-01-15T12:01:00Z', '2025-01-15T12:00:00Z')).toBe('1 \u5206\u949f\u524d')
      expect(at('2025-01-15T13:00:00Z', '2025-01-15T12:00:00Z')).toBe('1 \u5c0f\u65f6\u524d')
      expect(at('2025-01-15T15:00:00Z', '2025-01-15T12:00:00Z')).toBe('3 \u5c0f\u65f6\u524d')
      expect(at('2025-01-16T12:00:00Z', '2025-01-15T12:00:00Z')).toBe('1 \u5929\u524d')
      expect(at('2025-01-17T12:00:00Z', '2025-01-15T12:00:00Z')).toBe('2 \u5929\u524d')
    })
  })
})
