/**
 * Live-loaded auth policy from the `settings.auth` category.
 *
 * Boundary:
 * - Deployment-level config (external IdP issuer/JWK/audiences) lives in env vars and is
 *   loaded by `oauth-config.ts` — it answers "is OAuth physically possible?".
 * - Policy-level toggles (enabled, allowed domains, default role, password login)
 *   live in DB settings and are loaded here — they answer "is OAuth allowed *right now*?".
 *
 * 30-second in-process cache keeps the hot path off SQLite without making admin
 * changes feel stuck. Tests can call `resetAuthSettingsCache()`.
 */
import { getCategorySettings } from './settings.js'

export interface AuthSettings {
  oauthEnabled: boolean
  /** Lower-cased, deduped domains. Empty array = no restriction. */
  allowedEmailDomains: string[]
  /** Falls back to 'user' when the stored value is anything but 'admin'. */
  defaultRole: 'admin' | 'user'
  oauthAutoProvision: boolean
  passwordLoginEnabled: boolean
}

const CACHE_TTL_MS = 30_000
let cached: { value: AuthSettings; expiresAt: number } | null = null

function parseBool(v: string | undefined, fallback: boolean): boolean {
  if (v === undefined) return fallback
  return v === 'true' || v === '1'
}

function parseDomains(raw: string | undefined): string[] {
  if (!raw) return []
  const seen = new Set<string>()
  for (const part of raw.split(',')) {
    const d = part.trim().toLowerCase()
    if (d) seen.add(d)
  }
  return [...seen]
}

function parseRole(v: string | undefined): 'admin' | 'user' {
  return v === 'admin' ? 'admin' : 'user'
}

export async function loadAuthSettings(): Promise<AuthSettings> {
  const now = Date.now()
  if (cached && cached.expiresAt > now) return cached.value

  const raw = getCategorySettings('auth')
  const value: AuthSettings = {
    oauthEnabled: parseBool(raw.oauthEnabled, false),
    allowedEmailDomains: parseDomains(raw.oauthAllowedEmailDomains),
    defaultRole: parseRole(raw.oauthDefaultRole),
    oauthAutoProvision: parseBool(raw.oauthAutoProvision, true),
    passwordLoginEnabled: parseBool(raw.passwordLoginEnabled, true),
  }
  cached = { value, expiresAt: now + CACHE_TTL_MS }
  return value
}

/** Email-domain match: case-insensitive, exact suffix after the `@`. */
export function isEmailDomainAllowed(email: string, allowed: string[]): boolean {
  if (allowed.length === 0) return true
  const at = email.lastIndexOf('@')
  if (at < 0) return false
  const domain = email.slice(at + 1).toLowerCase()
  return allowed.includes(domain)
}

/** Test-only: drop the cache so the next read hits the DB. */
export function resetAuthSettingsCache(): void {
  cached = null
}
