import type { JWTPayload } from 'jose'
import { describe, expect, it } from 'vitest'
import { oidcClaimsToUserInfo } from '../oidc.js'

const ISSUER = 'https://idp.example.com'

describe('oidcClaimsToUserInfo', () => {
  it('maps sub / email / username from claims', async () => {
    const info = oidcClaimsToUserInfo(
      { sub: 'u-1', email: 'alice@example.com', preferred_username: 'alice' } as JWTPayload,
      ISSUER,
    )
    expect(info).toMatchObject({
      sub: 'u-1',
      email: 'alice@example.com',
      username: 'alice',
      issuer: ISSUER,
    })
  })

  it('throws when sub is missing', async () => {
    expect(() => oidcClaimsToUserInfo({ email: 'a@example.com' } as JWTPayload, ISSUER)).toThrow(
      /missing sub/,
    )
  })

  it('keeps email when email_verified is true', async () => {
    const info = oidcClaimsToUserInfo(
      { sub: 'u-1', email: 'alice@example.com', email_verified: true } as JWTPayload,
      ISSUER,
    )
    expect(info.email).toBe('alice@example.com')
  })

  it('drops email when email_verified is explicitly false (boolean)', async () => {
    const info = oidcClaimsToUserInfo(
      { sub: 'u-1', email: 'alice@example.com', email_verified: false } as JWTPayload,
      ISSUER,
    )
    expect(info.email).toBeUndefined()
  })

  it('drops email when email_verified is the string "false"', async () => {
    const info = oidcClaimsToUserInfo(
      { sub: 'u-1', email: 'alice@example.com', email_verified: 'false' } as unknown as JWTPayload,
      ISSUER,
    )
    expect(info.email).toBeUndefined()
  })

  it('keeps email when email_verified claim is absent (IdP does not emit it)', async () => {
    const info = oidcClaimsToUserInfo(
      { sub: 'u-1', email: 'alice@example.com' } as JWTPayload,
      ISSUER,
    )
    expect(info.email).toBe('alice@example.com')
  })
})
