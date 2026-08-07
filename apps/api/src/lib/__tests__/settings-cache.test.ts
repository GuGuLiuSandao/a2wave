import { beforeEach, describe, expect, it } from 'vitest'
import {
  getCachedSettingRows,
  invalidateSettingsCache,
  primeSettingsCache,
} from '../settings-cache.js'

/**
 * Why a cache exists at all.
 *
 * Settings are read synchronously from ~22 modules — URL builders, auth policy,
 * retention windows — most of which are pure formatting logic with no other
 * reason to be async. On PostgreSQL every read would become a `Promise`, and
 * that ripples outward through every one of their callers.
 *
 * The table is tiny, changes only through two write paths, and is already
 * re-read on every request, so holding it in memory costs nothing and keeps the
 * synchronous read API intact. Correctness then rests on exactly one property:
 * a write must invalidate, or readers serve stale config indefinitely.
 */
beforeEach(() => {
  invalidateSettingsCache()
})

describe('settings cache', () => {
  it('serves the rows it was primed with', async () => {
    primeSettingsCache([{ category: 'general', key: 'timeoutMinutes', value: '30' }])

    expect(getCachedSettingRows()).toEqual([
      { category: 'general', key: 'timeoutMinutes', value: '30' },
    ])
  })

  it('reports empty rather than throwing before priming', async () => {
    // Boot order is not fully controllable across the module graph; a read that
    // lands before priming must fall back to defaults, not crash the process.
    expect(getCachedSettingRows()).toEqual([])
  })

  it('drops everything on invalidation so the next prime is authoritative', async () => {
    primeSettingsCache([{ category: 'auth', key: 'passwordLoginEnabled', value: 'true' }])
    invalidateSettingsCache()

    expect(getCachedSettingRows()).toEqual([])
  })

  it('replaces rather than merges on re-prime, so a deleted key disappears', async () => {
    primeSettingsCache([
      { category: 'auth', key: 'a', value: '1' },
      { category: 'auth', key: 'b', value: '2' },
    ])
    primeSettingsCache([{ category: 'auth', key: 'a', value: '1' }])

    // A merge would resurrect 'b' forever — settings would be append-only.
    expect(getCachedSettingRows()).toEqual([{ category: 'auth', key: 'a', value: '1' }])
  })

  it('returns a snapshot callers cannot mutate into the cache', async () => {
    primeSettingsCache([{ category: 'general', key: 'k', value: 'v' }])

    getCachedSettingRows().push({ category: 'evil', key: 'x', value: 'y' })

    expect(getCachedSettingRows()).toHaveLength(1)
  })
})
