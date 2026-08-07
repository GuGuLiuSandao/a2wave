import { describe, expect, it } from 'vitest'
import {
  buildOidcConfig,
  buildSamlConfig,
  parseOidcConfig,
  parseSamlConfig,
} from '../sso-config-form'

describe('callbackOrigin field', () => {
  const oidcBase = {
    issuer: 'https://idp.example.com',
    clientId: 'a2wave',
    scopes: '',
    channelAudiences: '',
  }

  it('normalizes a valid origin and strips a trailing slash', () => {
    const built = buildOidcConfig({ ...oidcBase, callbackOrigin: 'http://10.0.0.8:3502/' })
    expect(built.ok).toBe(true)
    if (built.ok) expect(JSON.parse(built.value).callbackOrigin).toBe('http://10.0.0.8:3502')
  })

  it('treats a blank origin as "fall back to publicBaseUrl"', () => {
    const built = buildOidcConfig({ ...oidcBase, callbackOrigin: '   ' })
    expect(built.ok).toBe(true)
    if (built.ok) expect(JSON.parse(built.value).callbackOrigin).toBe('')
  })

  it.each([
    ['a path', 'https://host/auth/callback'],
    ['a query string', 'https://host?tenant=x'],
    ['credentials', 'https://user:pw@host'],
    ['a non-http scheme', 'ftp://host'],
    ['a bare hostname', 'a2wave.example.com'],
  ])('rejects %s', (_label, value) => {
    expect(buildOidcConfig({ ...oidcBase, callbackOrigin: value })).toEqual({
      ok: false,
      error: 'callbackOriginInvalid',
    })
  })

  it('applies the same rule to the SAML panel', () => {
    expect(
      buildSamlConfig({
        entryPoint: 'https://idp/sso',
        idpCert: 'c',
        spEntityId: '',
        callbackOrigin: 'https://host/nested',
      }),
    ).toEqual({ ok: false, error: 'callbackOriginInvalid' })
    expect(
      buildSamlConfig({
        entryPoint: 'https://idp/sso',
        idpCert: 'c',
        spEntityId: '',
        callbackOrigin: 'https://acs.example.com',
      }),
    ).toEqual(expect.objectContaining({ ok: true }))
  })

  it('round-trips through parse so the saved value prefills the form', () => {
    const json = JSON.stringify({
      ...oidcBase,
      callbackOrigin: 'https://sso.corp.example.com',
    })
    expect(parseOidcConfig(json).callbackOrigin).toBe('https://sso.corp.example.com')
  })
})

describe('oidc config form', () => {
  it('parses and round-trips', () => {
    const json = JSON.stringify({
      issuer: 'https://idp.example.com',
      clientId: 'a2wave',
      scopes: 'openid email',
      channelAudiences: '',
    })
    expect(parseOidcConfig(json)).toEqual({
      issuer: 'https://idp.example.com',
      clientId: 'a2wave',
      scopes: 'openid email',
      channelAudiences: '',
      callbackOrigin: '',
    })
    const built = buildOidcConfig(parseOidcConfig(json))
    expect(built.ok).toBe(true)
    if (built.ok)
      expect(JSON.parse(built.value)).toEqual({
        enabled: true,
        issuer: 'https://idp.example.com',
        clientId: 'a2wave',
        scopes: 'openid email',
        channelAudiences: [],
        callbackOrigin: '',
      })
  })

  it('carries the enabled flag through build (default true, explicit false)', () => {
    const form = parseOidcConfig(
      JSON.stringify({ issuer: 'https://idp.example.com', clientId: 'a2wave', scopes: '' }),
    )
    const on = buildOidcConfig(form)
    const off = buildOidcConfig(form, false)
    expect(on.ok && JSON.parse(on.value).enabled).toBe(true)
    expect(off.ok && JSON.parse(off.value).enabled).toBe(false)
  })

  it('round-trips channelAudiences between a comma string and an array', () => {
    const built = buildOidcConfig({
      issuer: 'https://idp.example.com',
      clientId: 'a2wave',
      scopes: '',
      channelAudiences: ' partner-service , , data-platform ',
      callbackOrigin: '',
    })
    expect(built.ok).toBe(true)
    if (!built.ok) return
    // Persisted as a trimmed array with blanks dropped...
    expect(JSON.parse(built.value).channelAudiences).toEqual(['partner-service', 'data-platform'])
    // ...and read back into the single form input.
    expect(parseOidcConfig(built.value).channelAudiences).toBe('partner-service, data-platform')
  })

  it('treats an absent channelAudiences as empty (configs saved before the field existed)', () => {
    const legacy = JSON.stringify({ issuer: 'https://idp.example.com', clientId: 'a2wave' })
    expect(parseOidcConfig(legacy).channelAudiences).toBe('')
  })

  it('rejects missing/non-url issuer and missing clientId', () => {
    expect(
      buildOidcConfig({
        issuer: '',
        clientId: 'x',
        scopes: '',
        channelAudiences: '',
        callbackOrigin: '',
      }),
    ).toEqual({
      ok: false,
      error: 'issuerRequired',
    })
    expect(
      buildOidcConfig({
        issuer: 'not-a-url',
        clientId: 'x',
        scopes: '',
        channelAudiences: '',
        callbackOrigin: '',
      }),
    ).toEqual({
      ok: false,
      error: 'issuerNotUrl',
    })
    expect(
      buildOidcConfig({
        issuer: 'https://idp.example.com',
        clientId: '',
        scopes: '',
        channelAudiences: '',
        callbackOrigin: '',
      }),
    ).toEqual({
      ok: false,
      error: 'clientIdRequired',
    })
  })
})

describe('saml config form', () => {
  it('parses and round-trips', () => {
    const json = JSON.stringify({
      entryPoint: 'https://idp.example.com/sso',
      idpCert: 'CERTBODY',
      spEntityId: 'https://sp/meta',
    })
    expect(parseSamlConfig(json)).toEqual({
      entryPoint: 'https://idp.example.com/sso',
      idpCert: 'CERTBODY',
      spEntityId: 'https://sp/meta',
      callbackOrigin: '',
    })
    const built = buildSamlConfig(parseSamlConfig(json))
    expect(built.ok).toBe(true)
  })

  it('rejects missing/non-url entry point and missing cert', () => {
    expect(
      buildSamlConfig({ entryPoint: '', idpCert: 'c', spEntityId: '', callbackOrigin: '' }),
    ).toEqual({
      ok: false,
      error: 'entryPointRequired',
    })
    expect(
      buildSamlConfig({ entryPoint: 'ftp://x', idpCert: 'c', spEntityId: '', callbackOrigin: '' }),
    ).toEqual({
      ok: false,
      error: 'entryPointNotUrl',
    })
    expect(
      buildSamlConfig({
        entryPoint: 'https://idp/sso',
        idpCert: '  ',
        spEntityId: '',
        callbackOrigin: '',
      }),
    ).toEqual({
      ok: false,
      error: 'certRequired',
    })
  })
})
