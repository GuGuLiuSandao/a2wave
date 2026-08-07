import { homedir } from 'node:os'
import { join } from 'node:path'

/**
 * SSO token cache path resolution.
 *
 *   1. env A2WAVE_OAUTH_CACHE_PATH (non-empty after trim) — explicit, highest priority
 *   2. default ~/.a2wave/oauth.json
 *
 * The CLI owns exactly one cache file and never probes for caches written by
 * other tools: a published CLI that goes looking for another platform's
 * credential file reads every user's disk for a token that is none of its
 * business. Point A2WAVE_OAUTH_CACHE_PATH at another file to share one
 * deliberately.
 */
export const DEFAULT_TOKEN_CACHE = join(homedir(), '.a2wave', 'oauth.json')

export interface TokenCachePathOptions {
  /** Test injection: default cache path (defaults to ~/.a2wave/oauth.json) */
  defaultPath?: string
}

export function resolveTokenCachePath(opts: TokenCachePathOptions = {}): string {
  const fromEnv = process.env.A2WAVE_OAUTH_CACHE_PATH?.trim()
  if (fromEnv) return fromEnv

  return opts.defaultPath ?? DEFAULT_TOKEN_CACHE
}
