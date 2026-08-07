import { describe, expect, it } from 'vitest'
import { sanitizeRequestLogPath } from '../request-log-path.js'

/**
 * Capability-bearing URLs must not survive into the request log.
 *
 * hono's `logger()` derives its path as `url.slice(url.indexOf('/', 8))` — path
 * *plus query string* — and its default printer is `console.log`, which bypasses
 * pino entirely. Pino's `redact` matches structured field names, so it can never
 * scrub a free-text line. The sanitising therefore has to happen before the string
 * is handed to the logger.
 */
describe('sanitizeRequestLogPath', () => {
  it('masks the agent share token, which is a bearer capability on a public route', () => {
    // GET /api/agents/shared/:token needs no auth — logging it verbatim writes a
    // replayable download credential into stdout, twice per request.
    expect(sanitizeRequestLogPath('/api/agents/shared/AbC123-token_value')).toBe(
      '/api/agents/shared/***',
    )
  })

  it('drops the query string, which carries the OIDC authorization code', () => {
    expect(sanitizeRequestLogPath('/api/auth/oidc/callback?code=super-secret&state=xyz')).toBe(
      '/api/auth/oidc/callback',
    )
  })

  it('masks the artifact share id', () => {
    expect(sanitizeRequestLogPath('/s/agt_123/shr_secret')).toBe('/s/agt_123/***')
  })

  it('masks nested paths under an artifact share id', () => {
    expect(sanitizeRequestLogPath('/s/agt_123/shr_secret/raw')).toBe('/s/agt_123/***/raw')
  })

  it('masks the attachment token', () => {
    expect(sanitizeRequestLogPath('/api/attachments/att_secrettoken')).toBe('/api/attachments/***')
  })

  it('leaves an ordinary path untouched', () => {
    expect(sanitizeRequestLogPath('/api/agents/agt_123')).toBe('/api/agents/agt_123')
  })

  it('leaves the share collection route untouched (no token present)', () => {
    expect(sanitizeRequestLogPath('/api/agents/shared')).toBe('/api/agents/shared')
  })

  it('strips the query string on ordinary paths too', () => {
    // Blanket removal: any future capability-bearing query param is covered by
    // default rather than needing to be enumerated after it leaks.
    expect(sanitizeRequestLogPath('/api/runs?page=2')).toBe('/api/runs')
  })

  it('handles a bare path with no query', () => {
    expect(sanitizeRequestLogPath('/')).toBe('/')
  })
})
