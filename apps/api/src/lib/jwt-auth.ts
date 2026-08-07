/**
 * Normalized identity extracted from a verified enterprise-SSO token.
 *
 * Verification itself lives in `lib/oidc.ts` (OIDC discovery + JWKS). This module only owns
 * the shape that both the login flow and the OAuth publish channel hand downstream, so the
 * gateway middleware and `run-channel.ts` share one identity type rather than two.
 */
import type { JWTPayload } from 'jose'

export interface JwtUserInfo {
  /** IdP subject. Always present — verification rejects a token without it. */
  sub: string
  /**
   * Stable per-user id: `user_id` / `uid` when the IdP emits one, otherwise `sub`.
   *
   * This deliberately no longer mirrors mcp-auth's `udAccountUuid || sub || user_id || uid`
   * ordering. That ordering belonged to the static-JWK IDaaS strategy, which is gone, and
   * standard OIDC providers do not emit `udAccountUuid`. `oidcClaimsToUserInfo` in
   * lib/oidc.ts is the only producer — keep this doc aligned with it, not with mcp-auth.
   */
  userId?: string
  email?: string
  /**
   * The `email` claim when the IdP explicitly marked it `email_verified: false`.
   *
   * Kept out of `email` because that field is the cross-protocol account merge key, and an
   * unverified address is user-selectable. It is still recorded so revocation can match a
   * local row by it: "not trustworthy enough to assert who you are" and "good enough to check
   * whether you have been disabled" are different bars, and the latter only ever tightens.
   */
  unverifiedEmail?: string
  /** `mobile`, falling back to the standard OIDC `phone_number`. */
  mobile?: string
  /** `preferred_username` → `name` → `idpUsername`, matching oidcClaimsToUserInfo. */
  username?: string
  tenantId?: string
  unionId?: string
  issuer: string
  raw: JWTPayload
}
