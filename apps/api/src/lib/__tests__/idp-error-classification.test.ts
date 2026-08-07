/**
 * Pins `isIdpUnavailableError()` against errors jose **actually** raises.
 *
 * The first attempt at this classification tested `err instanceof JOSEError` and was verified
 * only against hand-constructed error instances. That missed the single most common IdP outage
 * shape: jose's JWKS fetch layer throws a *bare* `JOSEError` (code `ERR_JOSE_GENERIC`) for any
 * non-200 response, so a 502/503 from the IdP was reported to callers as 401 "Invalid token" —
 * the exact regression the function exists to prevent.
 *
 * So these tests drive real failures through `jwtVerify` + `createRemoteJWKSet` against a local
 * server rather than asserting on synthesized errors. If jose changes which class or code it
 * raises for these cases, this file fails instead of the behaviour silently regressing.
 */
import { type RequestListener, type Server, createServer } from 'node:http'
import { type KeyLike, SignJWT, errors, exportJWK, generateKeyPair, jwtVerify } from 'jose'
import { createRemoteJWKSet } from 'jose'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { isIdpUnavailableError } from '../oidc.js'

const ISSUER = 'https://idp.example.test'
const AUD = 'partner-service'

let signingKey: KeyLike
let foreignKey: KeyLike
let goodJwks: string

async function issue(claims: Record<string, unknown> = {}, key?: KeyLike): Promise<string> {
  return new SignJWT({ sub: 'u-1', aud: AUD, ...claims })
    .setProtectedHeader({ alg: 'RS256', kid: 'k1' })
    .setIssuer(ISSUER)
    .setIssuedAt()
    .setExpirationTime('5m')
    .sign(key ?? signingKey)
}

/** Verify `token` against a JWKS endpoint behaving as `handler`, and return the thrown error. */
async function captureError(
  token: string,
  handler: RequestListener,
  verifyOpts: Record<string, unknown> = {},
): Promise<unknown> {
  const server: Server = createServer(handler)
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address() as { port: number }
  try {
    const jwks = createRemoteJWKSet(new URL(`http://127.0.0.1:${port}/jwks`))
    await jwtVerify(token, jwks, { issuer: ISSUER, audience: [AUD], ...verifyOpts })
    return null
  } catch (err) {
    return err
  } finally {
    server.close()
  }
}

const serveGoodJwks: RequestListener = (_req, res) => {
  res.writeHead(200, { 'content-type': 'application/json' })
  res.end(goodJwks)
}

beforeAll(async () => {
  const [pair, foreign] = await Promise.all([
    generateKeyPair('RS256', { extractable: true }),
    generateKeyPair('RS256', { extractable: true }),
  ])
  signingKey = pair.privateKey
  foreignKey = foreign.privateKey
  goodJwks = JSON.stringify({
    keys: [{ ...(await exportJWK(pair.publicKey)), kid: 'k1', alg: 'RS256', use: 'sig' }],
  })
})

afterAll(() => {})

describe('isIdpUnavailableError — availability faults (503, caller credentials are fine)', () => {
  it('treats a JWKS endpoint returning 503 as unavailable', async () => {
    const err = await captureError(await issue(), (_q, s) => {
      s.writeHead(503)
      s.end('service unavailable')
    })
    // Regression guard: jose raises a bare JOSEError here, which an `instanceof JOSEError`
    // check would have classified as a token fault.
    expect(err).toBeInstanceOf(errors.JOSEError)
    expect(isIdpUnavailableError(err)).toBe(true)
  })

  it('treats a JWKS endpoint returning 404 as unavailable', async () => {
    const err = await captureError(await issue(), (_q, s) => {
      s.writeHead(404)
      s.end('not found')
    })
    expect(isIdpUnavailableError(err)).toBe(true)
  })

  it('treats an HTML/captive-portal body in place of JWKS as unavailable', async () => {
    const err = await captureError(await issue(), (_q, s) => {
      s.writeHead(200, { 'content-type': 'text/html' })
      s.end('<html>sign in to the network</html>')
    })
    expect(isIdpUnavailableError(err)).toBe(true)
  })

  it('treats a JWKS fetch timeout as unavailable', async () => {
    expect(isIdpUnavailableError(new errors.JWKSTimeout())).toBe(true)
  })

  it('treats a bare network failure (undici/openid-client) as unavailable', async () => {
    expect(isIdpUnavailableError(new TypeError('fetch failed'))).toBe(true)
  })

  it('treats our own configuration errors as unavailable, not as a bad token', async () => {
    expect(isIdpUnavailableError(new Error('OIDC is not configured'))).toBe(true)
    expect(isIdpUnavailableError(new Error('OIDC audience allowlist is empty'))).toBe(true)
  })
})

describe('isIdpUnavailableError — token faults (401, attributable to the caller)', () => {
  it('classifies a signature that does not verify as a token fault', async () => {
    const err = await captureError(await issue({}, foreignKey), serveGoodJwks)
    expect(isIdpUnavailableError(err)).toBe(false)
  })

  it('classifies a wrong issuer as a token fault', async () => {
    const token = await new SignJWT({ sub: 'u-1', aud: AUD })
      .setProtectedHeader({ alg: 'RS256', kid: 'k1' })
      .setIssuer('https://evil.example.test')
      .setIssuedAt()
      .setExpirationTime('5m')
      .sign(signingKey)
    const err = await captureError(token, serveGoodJwks)
    expect(isIdpUnavailableError(err)).toBe(false)
  })

  it('classifies an audience outside the allowlist as a token fault', async () => {
    const err = await captureError(await issue({ aud: 'some-other-app' }), serveGoodJwks)
    expect(isIdpUnavailableError(err)).toBe(false)
  })

  it('classifies an expired token as a token fault', async () => {
    const now = Math.floor(Date.now() / 1000)
    const token = await new SignJWT({ sub: 'u-1', aud: AUD })
      .setProtectedHeader({ alg: 'RS256', kid: 'k1' })
      .setIssuer(ISSUER)
      .setIssuedAt(now - 7200)
      .setExpirationTime(now - 3600)
      .sign(signingKey)
    const err = await captureError(token, serveGoodJwks)
    expect(isIdpUnavailableError(err)).toBe(false)
  })

  it('classifies a token whose kid is absent from a well-formed JWKS as a token fault', async () => {
    // The JWKS is served fine; the token just names a key that is not in it.
    const err = await captureError(await issue(), (_q, s) => {
      s.writeHead(200, { 'content-type': 'application/json' })
      s.end('{"keys":[]}')
    })
    expect(err).toBeInstanceOf(errors.JWKSNoMatchingKey)
    expect(isIdpUnavailableError(err)).toBe(false)
  })

  it('classifies a disallowed algorithm as a token fault', async () => {
    const err = await captureError(await issue(), serveGoodJwks, { algorithms: ['ES256'] })
    expect(isIdpUnavailableError(err)).toBe(false)
  })
})

describe('isIdpUnavailableError — defaults', () => {
  it('does not classify a non-Error value as unavailable', async () => {
    expect(isIdpUnavailableError('boom')).toBe(false)
    expect(isIdpUnavailableError(undefined)).toBe(false)
  })

  it('defaults an unrecognised Error to unavailable rather than blaming the caller', async () => {
    // Fail toward "retry later" instead of "your credentials are invalid": the latter sends
    // integrators rotating working tokens.
    expect(isIdpUnavailableError(new Error('something new from a future jose'))).toBe(true)
  })
})
