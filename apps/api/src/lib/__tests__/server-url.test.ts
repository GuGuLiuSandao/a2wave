import { beforeEach, describe, expect, it, vi } from 'vitest'

const mockGetSetting = vi.hoisted(() => vi.fn())
const mockEnv: { PORT: number; NODE_ENV: string } = { PORT: 3502, NODE_ENV: 'test' }

vi.mock('../settings.js', () => ({
  getSetting: mockGetSetting,
}))

vi.mock('../../env.js', () => ({
  env: mockEnv,
}))

const {
  __resetDetectedForTesting,
  detectServerUrl,
  getArtifactDownloadUrl,
  getPublicOrigin,
  getServerUrl,
  getSsoCallbackOrigin,
  isSsoCallbackOriginUsable,
} = await import('../server-url.js')

const header =
  (map: Record<string, string>) =>
  (name: string): string | null =>
    map[name] ?? null

describe('server-url', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    __resetDetectedForTesting()
    mockGetSetting.mockReturnValue('')
    mockEnv.NODE_ENV = 'test'
  })

  describe('getServerUrl', () => {
    it('returns publicBaseUrl when configured (trailing slash removed)', async () => {
      mockGetSetting.mockReturnValue('https://a2wave.example.com/')
      expect(await getServerUrl()).toBe('https://a2wave.example.com')
    })

    it('returns publicBaseUrl when configured without trailing slash', async () => {
      mockGetSetting.mockReturnValue('https://a2wave.example.com')
      expect(await getServerUrl()).toBe('https://a2wave.example.com')
    })

    it('falls back to localhost when publicBaseUrl empty and no headers', async () => {
      mockGetSetting.mockReturnValue('')
      expect(await getServerUrl()).toBe('http://localhost:3502')
    })

    it('ignores publicBaseUrl when not http(s)', async () => {
      mockGetSetting.mockReturnValue('ftp://files.example.com')
      expect(await getServerUrl()).toBe('http://localhost:3502')
    })

    it('ignores publicBaseUrl when localhost or 127.0.0.1', async () => {
      mockGetSetting.mockReturnValue('http://localhost:3502')
      expect(await getServerUrl()).toBe('http://localhost:3502')
      mockGetSetting.mockReturnValue('http://127.0.0.1:3502')
      expect(await getServerUrl()).toBe('http://localhost:3502')
    })

    it('ignores publicBaseUrl when empty/whitespace', async () => {
      mockGetSetting.mockReturnValue('   ')
      expect(await getServerUrl()).toBe('http://localhost:3502')
    })
  })

  describe('getArtifactDownloadUrl', () => {
    it('joins base and path with exactly one slash', async () => {
      mockGetSetting.mockReturnValue('https://a2wave.example.com')
      expect(await getArtifactDownloadUrl('art_1')).toBe(
        'https://a2wave.example.com/api/artifacts/art_1/download',
      )
    })

    it('handles base with trailing slash without double slash', async () => {
      mockGetSetting.mockReturnValue('https://a2wave.example.com/')
      expect(await getArtifactDownloadUrl('art_x')).toBe(
        'https://a2wave.example.com/api/artifacts/art_x/download',
      )
    })
  })

  describe('detectServerUrl + getServerUrl fallback', () => {
    it('uses detected URL from headers when publicBaseUrl empty', async () => {
      mockGetSetting.mockReturnValue('')
      detectServerUrl({
        get: header({ 'x-forwarded-proto': 'https', 'x-forwarded-host': 'a2wave.example.com' }),
      })
      expect(await getServerUrl()).toBe('https://a2wave.example.com')
    })

    it('does NOT seed cache from a loopback Host without x-forwarded-host (docker healthcheck)', async () => {
      // Docker HEALTHCHECK curls http://localhost:3502/api/health first; that request must not
      // pin the callback origin to localhost, otherwise OIDC redirect_uri / SAML ACS break.
      mockGetSetting.mockReturnValue('')
      detectServerUrl({ get: header({ host: 'localhost:3502' }) })
      // A later real request from the Ingress should still be captured.
      detectServerUrl({
        get: header({ 'x-forwarded-proto': 'https', 'x-forwarded-host': 'a2wave.example.com' }),
      })
      expect(await getServerUrl()).toBe('https://a2wave.example.com')
    })

    it('does NOT seed cache from a 127.0.0.1 Host without forwarded header', async () => {
      mockGetSetting.mockReturnValue('')
      detectServerUrl({ get: header({ host: '127.0.0.1:3502' }) })
      expect(await getServerUrl()).toBe('http://localhost:3502')
    })

    it('still trusts a forwarded loopback host (explicit proxy config)', async () => {
      // If an operator's proxy explicitly forwards a loopback host, honor it — the guard only
      // targets the bare healthcheck (Host set, no x-forwarded-host).
      mockGetSetting.mockReturnValue('')
      detectServerUrl({ get: header({ 'x-forwarded-host': '127.0.0.1:8080' }) })
      expect(await getServerUrl()).toBe('http://127.0.0.1:8080')
    })
  })

  describe('getPublicOrigin (SSO-safe origin)', () => {
    it('returns the explicit publicBaseUrl (trailing slash trimmed)', async () => {
      mockGetSetting.mockReturnValue('https://a2wave.example.com/')
      expect(await getPublicOrigin()).toBe('https://a2wave.example.com')
    })

    it('returns null when publicBaseUrl is empty', async () => {
      mockGetSetting.mockReturnValue('')
      expect(await getPublicOrigin()).toBeNull()
    })

    it('returns null when publicBaseUrl is localhost/loopback', async () => {
      mockGetSetting.mockReturnValue('http://localhost:3502')
      expect(await getPublicOrigin()).toBeNull()
    })

    it('returns null when publicBaseUrl is not http(s)', async () => {
      mockGetSetting.mockReturnValue('ftp://x.example.com')
      expect(await getPublicOrigin()).toBeNull()
    })

    it('NEVER uses the request-header detected value (anti Host-poisoning)', async () => {
      // Even after a (would-be malicious) header seeds the detected URL, getPublicOrigin ignores it.
      mockGetSetting.mockReturnValue('')
      detectServerUrl({ get: header({ 'x-forwarded-host': 'evil.example.com' }) })
      expect(await getPublicOrigin()).toBeNull()
    })

    it('rejects a publicBaseUrl with a query string (would break the callback path)', async () => {
      // https://host?tenant=x → callback 拼接后 pathname 塌成 /，回调实际失效。
      mockGetSetting.mockReturnValue('https://host.example.com?tenant=x')
      expect(await getPublicOrigin()).toBeNull()
    })

    it('rejects a publicBaseUrl with a fragment', async () => {
      mockGetSetting.mockReturnValue('https://host.example.com#frag')
      expect(await getPublicOrigin()).toBeNull()
    })

    it('rejects a publicBaseUrl with embedded credentials', async () => {
      mockGetSetting.mockReturnValue('https://user:pass@host.example.com')
      expect(await getPublicOrigin()).toBeNull()
    })

    it('rejects a publicBaseUrl with a non-root path', async () => {
      mockGetSetting.mockReturnValue('https://host.example.com/app')
      expect(await getPublicOrigin()).toBeNull()
    })

    it('accepts a bare origin and normalizes to origin (no trailing slash)', async () => {
      mockGetSetting.mockReturnValue('https://host.example.com/')
      expect(await getPublicOrigin()).toBe('https://host.example.com')
    })
  })

  describe('getSsoCallbackOrigin', () => {
    it('returns the explicit publicBaseUrl when set', async () => {
      mockGetSetting.mockReturnValue('https://a2wave.example.com')
      expect(await getSsoCallbackOrigin()).toBe('https://a2wave.example.com')
    })

    it('falls back to localhost in non-production when publicBaseUrl is unset', async () => {
      mockEnv.NODE_ENV = 'test'
      mockGetSetting.mockReturnValue('')
      expect(await getSsoCallbackOrigin()).toBe('http://localhost:3502')
    })

    it('returns null in production when publicBaseUrl is unset (forces explicit config)', async () => {
      mockEnv.NODE_ENV = 'production'
      mockGetSetting.mockReturnValue('')
      expect(await getSsoCallbackOrigin()).toBeNull()
    })

    it('in production ignores a poisoned detected host and still returns null', async () => {
      mockEnv.NODE_ENV = 'production'
      mockGetSetting.mockReturnValue('')
      detectServerUrl({ get: header({ host: 'evil.example.com' }) })
      expect(await getSsoCallbackOrigin()).toBeNull()
    })

    it('prefers a per-method override over publicBaseUrl', async () => {
      mockGetSetting.mockReturnValue('https://a2wave.example.com')
      expect(await getSsoCallbackOrigin('http://10.0.0.8:3502')).toBe('http://10.0.0.8:3502')
    })

    it('satisfies production on its own when publicBaseUrl is unset', async () => {
      mockEnv.NODE_ENV = 'production'
      mockGetSetting.mockReturnValue('')
      expect(await getSsoCallbackOrigin('https://sso.corp.example.com')).toBe(
        'https://sso.corp.example.com',
      )
    })

    it('allows a loopback override (internal IdP / local debugging)', async () => {
      mockEnv.NODE_ENV = 'production'
      mockGetSetting.mockReturnValue('')
      expect(await getSsoCallbackOrigin('http://127.0.0.1:3502')).toBe('http://127.0.0.1:3502')
    })

    it('normalizes a trailing slash so `${origin}/path` never doubles the separator', async () => {
      expect(await getSsoCallbackOrigin('https://sso.corp.example.com/')).toBe(
        'https://sso.corp.example.com',
      )
    })

    it.each(['', '   ', 'not-a-url', 'ftp://host', 'https://host/nested', 'https://host?a=b'])(
      'ignores the unusable override %p and falls back to publicBaseUrl',
      async (override) => {
        mockGetSetting.mockReturnValue('https://a2wave.example.com')
        expect(await getSsoCallbackOrigin(override)).toBe('https://a2wave.example.com')
      },
    )
  })

  describe('isSsoCallbackOriginUsable (lockdown gate)', () => {
    it('true for a valid explicit origin regardless of env', async () => {
      mockEnv.NODE_ENV = 'production'
      expect(isSsoCallbackOriginUsable('https://a2wave.example.com')).toBe(true)
    })

    it('non-production: unset/invalid candidate is still usable (localhost fallback)', async () => {
      mockEnv.NODE_ENV = 'test'
      expect(isSsoCallbackOriginUsable('')).toBe(true)
      expect(isSsoCallbackOriginUsable(null)).toBe(true)
    })

    it('production: empty candidate is NOT usable', async () => {
      mockEnv.NODE_ENV = 'production'
      expect(isSsoCallbackOriginUsable('')).toBe(false)
    })

    it('production: a query-string URL is NOT usable (callback path would break)', async () => {
      mockEnv.NODE_ENV = 'production'
      expect(isSsoCallbackOriginUsable('https://host.example.com?tenant=x')).toBe(false)
    })

    it('production: a localhost candidate is NOT usable', async () => {
      mockEnv.NODE_ENV = 'production'
      expect(isSsoCallbackOriginUsable('http://localhost:3502')).toBe(false)
    })
  })
})
