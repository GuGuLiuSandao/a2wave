/**
 * Tests for the **real** OAuth-channel verifier (no mock of lib/oidc.js).
 *
 * This path is the whole authentication boundary for `publishAuthType: 'oauth'`, and its
 * consumer's test file mocks it out — so without this file nothing asserts that the audience
 * allowlist is enforced, that an unconfigured channel fails closed, or that a token signed by
 * an unknown key is rejected. A regression in any of those ships green.
 *
 * `openid-client`'s `discovery` is mocked to return metadata pointing at a locally served
 * JWKS, so verification exercises the production jwtVerify/JWKS fetch path without reaching a
 * real IdP. The mock sits at the module boundary rather than on an exported function of
 * lib/oidc.ts: within an ES module, internal calls bind locally, so spying on
 * `getOidcConfiguration`/`getOidcEnv` would not intercept the callers inside the same file.
 */
import { type KeyLike, SignJWT, exportJWK, generateKeyPair } from 'jose'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

const ISSUER = 'https://idp.example.test'
const CLIENT_ID = 'a2wave-web'
const CALLER_AUD = 'partner-service'

const state = vi.hoisted(() => ({
  jwksUri: '',
  discoveryCalls: 0,
  discovery: (..._args: unknown[]): Promise<unknown> => Promise.reject(new Error('not set')),
}))

vi.mock('../sso-settings.js', () => ({
  // Force the env branch of resolveOidcEnv so tests drive config through process.env only.
  readSsoDbConfig: () => null,
  readOidcClientSecret: () => undefined,
}))
vi.mock('../settings.js', () => ({ getCategorySettings: () => ({}) }))
vi.mock('openid-client', () => ({
  discovery: (...args: unknown[]) => state.discovery(...args),
  allowInsecureRequests: Symbol('allowInsecureRequests'),
}))
vi.mock('../logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}))

import {
  isOauthChannelConfigured,
  isOidcConfigured,
  oauthChannelAudiences,
  resetOidcForTests,
  verifyOauthChannelToken,
} from '../oidc.js'

let signingKey: KeyLike
let foreignKey: KeyLike
let jwksBody: string
let server: import('node:http').Server

async function issue(claims: Record<string, unknown>, key: KeyLike = signingKey): Promise<string> {
  return new SignJWT({ sub: 'user-1', email: 'user@example.com', ...claims })
    .setProtectedHeader({ alg: 'RS256', kid: 'k1' })
    .setIssuer(ISSUER)
    .setIssuedAt()
    .setExpirationTime('5m')
    .sign(key)
}

beforeAll(async () => {
  const [pair, foreign] = await Promise.all([
    generateKeyPair('RS256', { extractable: true }),
    generateKeyPair('RS256', { extractable: true }),
  ])
  signingKey = pair.privateKey
  foreignKey = foreign.privateKey
  const jwk = { ...(await exportJWK(pair.publicKey)), kid: 'k1', alg: 'RS256', use: 'sig' }
  jwksBody = JSON.stringify({ keys: [jwk] })

  const { createServer } = await import('node:http')
  server = createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(jwksBody)
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const addr = server.address() as { port: number }
  state.jwksUri = `http://127.0.0.1:${addr.port}/jwks`
})

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()))
})

beforeEach(() => {
  vi.stubEnv('A2WAVE_OIDC_ISSUER', ISSUER)
  vi.stubEnv('A2WAVE_OIDC_CLIENT_ID', CLIENT_ID)
  vi.stubEnv('A2WAVE_OIDC_CHANNEL_AUDIENCES', CALLER_AUD)
  resetOidcForTests()
  state.discoveryCalls = 0
  state.discovery = () => {
    state.discoveryCalls += 1
    return Promise.resolve({
      serverMetadata: () => ({ issuer: ISSUER, jwks_uri: state.jwksUri }),
    })
  }
})

afterEach(() => {
  vi.unstubAllEnvs()
  resetOidcForTests()
})

describe('oauthChannelAudiences', () => {
  it('contains exactly the configured allowlist — clientId is NOT folded in', async () => {
    // Folding clientId in implicitly turned "can sign in to the console" into "can invoke
    // every all_idaas_users Agent", and made the empty-allowlist gate below unreachable.
    expect(await oauthChannelAudiences()).toEqual([CALLER_AUD])
    expect(await oauthChannelAudiences()).not.toContain(CLIENT_ID)
  })

  it('is empty when OIDC is unconfigured', async () => {
    vi.stubEnv('A2WAVE_OIDC_ISSUER', '')
    resetOidcForTests()
    expect(await oauthChannelAudiences()).toEqual([])
  })
})

describe('isOauthChannelConfigured', () => {
  /**
   * The invariant this whole predicate exists for: the `enabled` flag gates the *login*
   * entry point only. An admin disabling OIDC login (to force password-only sign-in, or
   * after moving to SAML) must not 503 every already-published OAuth Agent.
   */
  it('stays true when the OIDC login method is disabled', async () => {
    // The DB branch is the only one carrying `enabled: false` (env config is always enabled),
    // so this case re-mocks readSsoDbConfig for a freshly imported module instance.
    vi.resetModules()
    vi.doMock('../sso-settings.js', () => ({
      readSsoDbConfig: () => ({
        enabled: false,
        issuer: ISSUER,
        clientId: CLIENT_ID,
        scopes: '',
        channelAudiences: [CALLER_AUD],
        callbackOrigin: '',
      }),
      readOidcClientSecret: () => undefined,
    }))
    try {
      const mod = await import('../oidc.js')
      mod.resetOidcForTests()

      expect(await mod.isOidcConfigured()).toBe(false)
      expect(await mod.isOauthChannelConfigured()).toBe(true)
    } finally {
      // In a finally block: if an expectation above fails, leaving the sso-settings mock
      // registered would leak into every later test in this file and turn one real failure
      // into an unrelated cascade.
      vi.doUnmock('../sso-settings.js')
      vi.resetModules()
    }
  })

  it('is false when the audience allowlist is empty (fail closed)', async () => {
    vi.stubEnv('A2WAVE_OIDC_CHANNEL_AUDIENCES', '')
    resetOidcForTests()
    expect(await oauthChannelAudiences()).toEqual([])
    expect(await isOauthChannelConfigured()).toBe(false)
  })

  it('is false when OIDC is not configured at all', async () => {
    vi.stubEnv('A2WAVE_OIDC_ISSUER', '')
    resetOidcForTests()
    expect(await isOauthChannelConfigured()).toBe(false)
    expect(await isOidcConfigured()).toBe(false)
  })
})

describe('verifyOauthChannelToken', () => {
  it('accepts a token whose aud is on the allowlist', async () => {
    const info = await verifyOauthChannelToken(await issue({ aud: CALLER_AUD }))
    expect(info).toMatchObject({ sub: 'user-1', issuer: ISSUER, email: 'user@example.com' })
  })

  it('rejects an a2wave login token unless clientId is explicitly allowlisted', async () => {
    // An id_token minted for a2wave's own login is a console-sign-in credential, not an
    // Agent-invocation grant. Deployments that want that must say so in the allowlist.
    await expect(verifyOauthChannelToken(await issue({ aud: CLIENT_ID }))).rejects.toThrow()
  })

  it('accepts an a2wave login token once clientId is explicitly allowlisted', async () => {
    vi.stubEnv('A2WAVE_OIDC_CHANNEL_AUDIENCES', `${CALLER_AUD},${CLIENT_ID}`)
    resetOidcForTests()
    const info = await verifyOauthChannelToken(await issue({ aud: CLIENT_ID }))
    expect(info.sub).toBe('user-1')
  })

  /**
   * The regression this file exists for. Skipping `aud` entirely — which is what passing
   * `undefined` to jose does — accepts every token the IdP ever signed for any relying
   * party, and `oauthAccessMode='all_idaas_users'` has no second gate behind it.
   */
  it('rejects a token minted for a different relying party at the same IdP', async () => {
    await expect(verifyOauthChannelToken(await issue({ aud: 'some-other-app' }))).rejects.toThrow()
  })

  it('rejects a token with no aud claim', async () => {
    await expect(verifyOauthChannelToken(await issue({}))).rejects.toThrow()
  })

  it('rejects a token signed by a key absent from the IdP JWKS', async () => {
    await expect(
      verifyOauthChannelToken(await issue({ aud: CALLER_AUD }, foreignKey)),
    ).rejects.toThrow()
  })

  it('rejects a token from a different issuer', async () => {
    const token = await new SignJWT({ sub: 'user-1', aud: CALLER_AUD })
      .setProtectedHeader({ alg: 'RS256', kid: 'k1' })
      .setIssuer('https://evil.example.test')
      .setIssuedAt()
      .setExpirationTime('5m')
      .sign(signingKey)
    await expect(verifyOauthChannelToken(token)).rejects.toThrow()
  })

  it('rejects an expired token', async () => {
    const token = await new SignJWT({ sub: 'user-1', aud: CALLER_AUD })
      .setProtectedHeader({ alg: 'RS256', kid: 'k1' })
      .setIssuer(ISSUER)
      .setIssuedAt(Math.floor(Date.now() / 1000) - 7200)
      .setExpirationTime(Math.floor(Date.now() / 1000) - 3600)
      .sign(signingKey)
    await expect(verifyOauthChannelToken(token)).rejects.toThrow()
  })

  it('fails closed before any network call when OIDC is unconfigured', async () => {
    vi.stubEnv('A2WAVE_OIDC_ISSUER', '')
    resetOidcForTests()
    const token = await issue({ aud: CALLER_AUD })
    await expect(verifyOauthChannelToken(token)).rejects.toThrow(/not configured/)
    expect(state.discoveryCalls).toBe(0)
  })
})
