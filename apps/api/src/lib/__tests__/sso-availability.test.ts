import { describe, expect, it } from 'vitest'
import { computeSsoAvailability } from '../sso-availability.js'

const base = {
  callbackOriginAvailable: true,
  oidcConfigured: false,
  samlConfigured: false,
}

describe('computeSsoAvailability', () => {
  it('nothing configured → nothing active', async () => {
    expect(computeSsoAvailability(base)).toEqual({
      oidc: false,
      saml: false,
      anyActive: false,
    })
  })

  it('OIDC configured + callback origin available → oidc active', async () => {
    const r = computeSsoAvailability({ ...base, oidcConfigured: true })
    expect(r.oidc).toBe(true)
    expect(r.anyActive).toBe(true)
  })

  it('OIDC configured but NO callback origin → oidc NOT active (would fail with SSO_PUBLIC_URL_NOT_SET)', async () => {
    const r = computeSsoAvailability({
      ...base,
      oidcConfigured: true,
      callbackOriginAvailable: false,
    })
    expect(r.oidc).toBe(false)
    expect(r.anyActive).toBe(false)
  })

  it('SAML configured but NO callback origin → saml NOT active', async () => {
    const r = computeSsoAvailability({
      ...base,
      samlConfigured: true,
      callbackOriginAvailable: false,
    })
    expect(r.saml).toBe(false)
    expect(r.anyActive).toBe(false)
  })

  it('OIDC + SAML both configured but no origin → both inactive', async () => {
    const r = computeSsoAvailability({
      callbackOriginAvailable: false,
      oidcConfigured: true,
      samlConfigured: true,
    })
    expect(r).toEqual({ oidc: false, saml: false, anyActive: false })
  })
})
