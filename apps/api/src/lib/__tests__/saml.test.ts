import type { Profile } from '@node-saml/node-saml'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mockGetServerUrl = vi.fn<() => string | null>(() => 'https://a2wave.test')
vi.mock('../server-url.js', () => ({
  getServerUrl: () => mockGetServerUrl(),
  getSsoCallbackOrigin: () => mockGetServerUrl(),
}))

// 测试隔离：不读真实 dev DB，DB config 恒空 → getSamlEnv 走 env 兜底路径。
vi.mock('../sso-settings.js', () => ({
  readSsoDbConfig: () => null,
  readOidcClientSecret: () => undefined,
}))

import { getSamlEnv, isSamlConfigured } from '../saml-config.js'
import {
  classifySamlValidationError,
  extractSamlIdentity,
  getSaml,
  resetSamlForTests,
} from '../saml.js'

/** node-saml 接受 PEM 或 base64 体；测试用任意内容的 base64 即可通过构造期校验。 */
const FAKE_IDP_CERT = Buffer.from('fake-idp-cert-material-for-tests').toString('base64')

const ENTRY_POINT = 'https://idp.test/sso/saml'

function stubSamlEnv(overrides: Record<string, string> = {}) {
  vi.stubEnv('A2WAVE_SAML_IDP_ENTRY_POINT', overrides.entryPoint ?? ENTRY_POINT)
  vi.stubEnv('A2WAVE_SAML_IDP_CERT', overrides.idpCert ?? FAKE_IDP_CERT)
  vi.stubEnv('A2WAVE_SAML_SP_ENTITY_ID', overrides.spEntityId ?? '')
}

afterEach(() => {
  vi.unstubAllEnvs()
  resetSamlForTests()
})

describe('getSamlEnv / isSamlConfigured', () => {
  it('returns null when both env vars are absent', async () => {
    vi.stubEnv('A2WAVE_SAML_IDP_ENTRY_POINT', '')
    vi.stubEnv('A2WAVE_SAML_IDP_CERT', '')
    expect(await getSamlEnv()).toBeNull()
    expect(await isSamlConfigured()).toBe(false)
  })

  it('returns null when only the entry point is set', async () => {
    vi.stubEnv('A2WAVE_SAML_IDP_ENTRY_POINT', ENTRY_POINT)
    vi.stubEnv('A2WAVE_SAML_IDP_CERT', '')
    expect(await getSamlEnv()).toBeNull()
  })

  it('returns null when only the IdP cert is set', async () => {
    vi.stubEnv('A2WAVE_SAML_IDP_ENTRY_POINT', '')
    vi.stubEnv('A2WAVE_SAML_IDP_CERT', FAKE_IDP_CERT)
    expect(await getSamlEnv()).toBeNull()
  })

  it('returns the config without spEntityId when it is not set', async () => {
    stubSamlEnv()
    expect(await getSamlEnv()).toEqual({
      entryPoint: ENTRY_POINT,
      idpCert: FAKE_IDP_CERT,
      callbackOrigin: '',
      source: 'env',
      enabled: true,
    })
    expect(await isSamlConfigured()).toBe(true)
  })

  it('includes spEntityId when set', async () => {
    stubSamlEnv({ spEntityId: 'https://sp.example.com/custom-entity' })
    expect(await getSamlEnv()).toEqual({
      entryPoint: ENTRY_POINT,
      idpCert: FAKE_IDP_CERT,
      spEntityId: 'https://sp.example.com/custom-entity',
      callbackOrigin: '',
      source: 'env',
      enabled: true,
    })
  })
})

describe('classifySamlValidationError', () => {
  it('classifies an audience mismatch (the localhost vs 127.0.0.1 trap)', async () => {
    expect(
      classifySamlValidationError(
        'SAML assertion audience mismatch. Expected: http://localhost:3502/api/auth/saml/metadata Received: http://127.0.0.1:3502/api/auth/saml/metadata',
      ),
    ).toBe('SAML_AUDIENCE_MISMATCH')
    expect(classifySamlValidationError('SAML assertion has no AudienceRestriction')).toBe(
      'SAML_AUDIENCE_MISMATCH',
    )
  })

  it('classifies InResponseTo failures as an unsolicited response', async () => {
    expect(classifySamlValidationError('InResponseTo is not valid')).toBe(
      'SAML_RESPONSE_UNSOLICITED',
    )
    expect(classifySamlValidationError('InResponseTo is missing from response')).toBe(
      'SAML_RESPONSE_UNSOLICITED',
    )
  })

  it.each([
    'Invalid signature',
    'Invalid signature: multiple assertions',
    'SAML assertion expired: assertion too old',
    'SAML assertion not yet valid',
  ])('keeps %p on the existing INVALID_IDAAS_TOKEN code', (message) => {
    expect(classifySamlValidationError(message)).toBe('INVALID_IDAAS_TOKEN')
  })

  it('falls back safely when node-saml changes its wording', async () => {
    // 判据是上游英文文案，版本升级可能漂移。匹配不上必须退回原有行为，
    // 而不是让登录以别的方式坏掉。
    expect(classifySamlValidationError('some future unrecognised error')).toBe(
      'INVALID_IDAAS_TOKEN',
    )
    expect(classifySamlValidationError('')).toBe('INVALID_IDAAS_TOKEN')
  })
})

describe('extractSamlIdentity', () => {
  function profile(overrides: Record<string, unknown> = {}): Profile {
    return {
      issuer: 'https://idp.test/issuer',
      nameID: 'user-1',
      nameIDFormat: 'urn:oasis:names:tc:SAML:2.0:nameid-format:persistent',
      ...overrides,
    } as Profile
  }

  it('uses nameID as sub', async () => {
    const identity = extractSamlIdentity(profile(), ENTRY_POINT)
    expect(identity.sub).toBe('user-1')
  })

  it('throws when the profile has no nameID', async () => {
    expect(() => extractSamlIdentity(profile({ nameID: '' }), ENTRY_POINT)).toThrow(/nameID/)
  })

  it('prefers profile.email over nameID and other attributes', async () => {
    const identity = extractSamlIdentity(
      profile({
        email: 'primary@example.com',
        mail: 'mail@example.com',
        nameID: 'nid@example.com',
      }),
      ENTRY_POINT,
    )
    expect(identity.email).toBe('primary@example.com')
  })

  it('falls back to nameID when it looks like an email', async () => {
    const identity = extractSamlIdentity(
      profile({ nameID: 'nid@example.com', mail: 'mail@example.com' }),
      ENTRY_POINT,
    )
    expect(identity.email).toBe('nid@example.com')
  })

  it('does not use a non-email nameID as email and falls back to mail', async () => {
    const identity = extractSamlIdentity(profile({ mail: 'mail@example.com' }), ENTRY_POINT)
    expect(identity.email).toBe('mail@example.com')
  })

  it('falls back to the emailAddress attribute', async () => {
    const identity = extractSamlIdentity(profile({ emailAddress: 'ea@example.com' }), ENTRY_POINT)
    expect(identity.email).toBe('ea@example.com')
  })

  it('falls back to the LDAP mail OID attribute', async () => {
    const identity = extractSamlIdentity(
      profile({ 'urn:oid:0.9.2342.19200300.100.1.3': 'oid@example.com' }),
      ENTRY_POINT,
    )
    expect(identity.email).toBe('oid@example.com')
  })

  it('falls back to the WS-Fed emailaddress claim', async () => {
    const identity = extractSamlIdentity(
      profile({
        'http://schemas.xmlsoap.org/ws/2005/05/identity/claims/emailaddress': 'ws@example.com',
      }),
      ENTRY_POINT,
    )
    expect(identity.email).toBe('ws@example.com')
  })

  it('accepts array-valued attributes and takes the first entry', async () => {
    const identity = extractSamlIdentity(
      profile({ mail: ['arr@example.com', 'second@example.com'] }),
      ENTRY_POINT,
    )
    expect(identity.email).toBe('arr@example.com')
  })

  it('leaves email undefined when nothing matches', async () => {
    const identity = extractSamlIdentity(profile(), ENTRY_POINT)
    expect(identity.email).toBeUndefined()
  })

  it('prefers displayName for the username', async () => {
    const identity = extractSamlIdentity(
      profile({ displayName: 'Alice Liddell', cn: 'alice', givenName: 'Alice' }),
      ENTRY_POINT,
    )
    expect(identity.username).toBe('Alice Liddell')
  })

  it('falls back to cn and then givenName for the username', async () => {
    expect(
      extractSamlIdentity(profile({ cn: 'alice', givenName: 'Alice' }), ENTRY_POINT).username,
    ).toBe('alice')
    expect(extractSamlIdentity(profile({ givenName: 'Alice' }), ENTRY_POINT).username).toBe('Alice')
    expect(extractSamlIdentity(profile(), ENTRY_POINT).username).toBeUndefined()
  })

  it('uses profile.issuer and falls back to the given issuer when missing', async () => {
    expect(extractSamlIdentity(profile(), ENTRY_POINT).issuer).toBe('https://idp.test/issuer')
    expect(extractSamlIdentity(profile({ issuer: '' }), ENTRY_POINT).issuer).toBe(ENTRY_POINT)
  })
})

describe('getSaml', () => {
  beforeEach(() => {
    resetSamlForTests()
    mockGetServerUrl.mockReturnValue('https://a2wave.test')
  })

  it('throws when SAML is not configured', async () => {
    vi.stubEnv('A2WAVE_SAML_IDP_ENTRY_POINT', '')
    vi.stubEnv('A2WAVE_SAML_IDP_CERT', '')
    await expect(getSaml()).rejects.toThrow(/not configured/i)
  })

  it('builds the SP with callbackUrl / issuer / audience derived from the server URL', async () => {
    stubSamlEnv()
    const saml = await getSaml()
    expect((await saml).options.entryPoint).toBe(ENTRY_POINT)
    expect((await saml).options.callbackUrl).toBe('https://a2wave.test/api/auth/saml/acs')
    expect((await saml).options.issuer).toBe('https://a2wave.test/api/auth/saml/metadata')
    expect((await saml).options.audience).toBe('https://a2wave.test/api/auth/saml/metadata')
    expect((await saml).options.wantAssertionsSigned).toBe(true)
    expect((await saml).options.validateInResponseTo).toBe('always')
  })

  it('uses A2WAVE_SAML_SP_ENTITY_ID for issuer and audience when set', async () => {
    stubSamlEnv({ spEntityId: 'https://sp.example.com/custom-entity' })
    const saml = await getSaml()
    expect((await saml).options.issuer).toBe('https://sp.example.com/custom-entity')
    expect((await saml).options.audience).toBe('https://sp.example.com/custom-entity')
  })

  it('caches the instance until resetSamlForTests or serverUrl change', async () => {
    stubSamlEnv()
    const first = await getSaml()
    expect(await getSaml()).toBe(first)

    mockGetServerUrl.mockReturnValue('https://other.test')
    const second = await getSaml()
    expect(second).not.toBe(first)
    expect((await second).options.callbackUrl).toBe('https://other.test/api/auth/saml/acs')

    resetSamlForTests()
    expect(await getSaml()).not.toBe(second)
  })
})
