import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { DEFAULT_TOKEN_CACHE, resolveTokenCachePath } from '../token-cache.js'

describe('resolveTokenCachePath', () => {
  let dir: string
  let defaultPath: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'a2wave-token-cache-'))
    defaultPath = join(dir, 'a2wave', 'oauth.json')
    delete process.env.A2WAVE_OAUTH_CACHE_PATH
  })

  afterEach(() => {
    delete process.env.A2WAVE_OAUTH_CACHE_PATH
    rmSync(dir, { recursive: true, force: true })
  })

  it('env A2WAVE_OAUTH_CACHE_PATH wins over the default', () => {
    process.env.A2WAVE_OAUTH_CACHE_PATH = '/custom/cache.json'
    expect(resolveTokenCachePath({ defaultPath })).toBe('/custom/cache.json')
  })

  it('blank env value is ignored', () => {
    process.env.A2WAVE_OAUTH_CACHE_PATH = '   '
    expect(resolveTokenCachePath({ defaultPath })).toBe(defaultPath)
  })

  it('uses the default when the env var is unset', () => {
    expect(resolveTokenCachePath({ defaultPath })).toBe(defaultPath)
  })

  // Regression: the CLI used to probe ~/.atlas-ai-gateway-oauth.json and prefer
  // it when present. A published CLI must not go looking for another platform's
  // credential file, so an existing file at that path must change nothing.
  it('never probes a third-party credential cache in the home directory', () => {
    const foreignCache = join(dir, '.atlas-ai-gateway-oauth.json')
    writeFileSync(foreignCache, JSON.stringify({ id_token: 'foreign-jwt' }))
    expect(resolveTokenCachePath({ defaultPath })).toBe(defaultPath)
  })

  it('exports a homedir-based constant for the default resolution', () => {
    expect(DEFAULT_TOKEN_CACHE).toBe(join(homedir(), '.a2wave', 'oauth.json'))
  })
})
