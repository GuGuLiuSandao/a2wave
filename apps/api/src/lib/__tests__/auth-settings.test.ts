import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../settings.js', () => ({
  getCategorySettings: vi.fn(),
}))

import { isEmailDomainAllowed, loadAuthSettings, resetAuthSettingsCache } from '../auth-settings.js'
import { getCategorySettings } from '../settings.js'

describe('auth-settings', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    resetAuthSettingsCache()
  })

  describe('loadAuthSettings', () => {
    it('parses defaults safely when DB returns empty', async () => {
      ;(getCategorySettings as unknown as ReturnType<typeof vi.fn>).mockReturnValue({})
      const cfg = await loadAuthSettings()
      expect(cfg).toEqual({
        oauthEnabled: false,
        allowedEmailDomains: [],
        defaultRole: 'user',
        oauthAutoProvision: true,
        passwordLoginEnabled: true,
      })
    })

    it('parses bool / list / role correctly', async () => {
      ;(getCategorySettings as unknown as ReturnType<typeof vi.fn>).mockReturnValue({
        oauthEnabled: 'true',
        oauthAllowedEmailDomains: 'example.com, example.org,Example.com',
        oauthDefaultRole: 'admin',
        oauthAutoProvision: 'false',
        passwordLoginEnabled: 'false',
      })
      const cfg = await loadAuthSettings()
      expect((await cfg).oauthEnabled).toBe(true)
      // dedup + lowercase
      expect((await cfg).allowedEmailDomains.sort()).toEqual(['example.com', 'example.org'])
      expect((await cfg).defaultRole).toBe('admin')
      expect((await cfg).oauthAutoProvision).toBe(false)
      expect((await cfg).passwordLoginEnabled).toBe(false)
    })

    it('falls back to user when role string is bogus', async () => {
      ;(getCategorySettings as unknown as ReturnType<typeof vi.fn>).mockReturnValue({
        oauthDefaultRole: 'superuser',
      })
      expect((await loadAuthSettings()).defaultRole).toBe('user')
    })

    it('caches subsequent reads within TTL', async () => {
      ;(getCategorySettings as unknown as ReturnType<typeof vi.fn>).mockReturnValue({})
      await loadAuthSettings()
      await loadAuthSettings()
      await loadAuthSettings()
      expect(getCategorySettings).toHaveBeenCalledTimes(1)
    })

    it('reset cache forces a re-read', async () => {
      ;(getCategorySettings as unknown as ReturnType<typeof vi.fn>).mockReturnValue({})
      await loadAuthSettings()
      resetAuthSettingsCache()
      await loadAuthSettings()
      expect(getCategorySettings).toHaveBeenCalledTimes(2)
    })
  })

  describe('isEmailDomainAllowed', () => {
    it('passes everything when allowlist is empty', async () => {
      expect(isEmailDomainAllowed('a@b.com', [])).toBe(true)
    })

    it('matches case-insensitively', async () => {
      expect(isEmailDomainAllowed('Foo@Example.COM', ['example.com'])).toBe(true)
    })

    it('rejects unknown domain', async () => {
      expect(isEmailDomainAllowed('a@evil.com', ['example.com'])).toBe(false)
    })

    it('rejects malformed email (no @)', async () => {
      expect(isEmailDomainAllowed('not-an-email', ['example.com'])).toBe(false)
    })

    it('matches exact suffix only — subdomain is not the same', async () => {
      expect(isEmailDomainAllowed('a@x.example.com', ['example.com'])).toBe(false)
    })
  })
})
