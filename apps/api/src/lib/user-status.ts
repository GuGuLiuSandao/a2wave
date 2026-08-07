import { and, eq, isNull } from 'drizzle-orm'
import { db } from '../db/client.js'
import { users } from '../db/schema.js'

export interface SsoAccountIdentity {
  /** IdP issuer from the verified token */
  issuer: string
  /** IdP subject from the verified token */
  sub: string
  /** Email claim, when the token carries one */
  email?: string
}

/**
 * Whether the local a2wave account behind a verified SSO identity has been disabled.
 *
 * Callers that authenticate purely against an external IdP (the OAuth gateway) never
 * touch the `users` table, so without this an admin could disable a leaver and still
 * leave their Agent invocation path wide open.
 *
 * Identity matching mirrors `completeSsoLogin`: `(issuer, sub)` first, then email as the
 * cross-protocol merge fallback for accounts provisioned before issuer was recorded.
 *
 * Returns `false` when no local account exists — an external IdP user who was never
 * provisioned here is not "disabled", and access for them is governed by the agent's
 * `oauthAccessMode` instead.
 */
export async function isSsoAccountDisabled(identity: SsoAccountIdentity): Promise<boolean> {
  const byIdentity = (
    await db
      .select({ isActive: users.isActive })
      .from(users)
      .where(and(eq(users.idaasIssuer, identity.issuer), eq(users.idaasSub, identity.sub)))
      .limit(1)
  )[0]
  if (byIdentity) return !byIdentity.isActive

  // Accounts provisioned before idaas_issuer was recorded carry NULL there, and in SQLite
  // NULL never compares equal — so the predicate above misses them entirely. Without this
  // a disabled legacy account could keep invoking Agents whenever the token has no email
  // claim to fall back on (all_idaas_users mode does not require one). Restricted to
  // issuer-IS-NULL rows: a row with a *different* recorded issuer is a different person.
  const byLegacySub = (
    await db
      .select({ isActive: users.isActive })
      .from(users)
      .where(and(isNull(users.idaasIssuer), eq(users.idaasSub, identity.sub)))
      .limit(1)
  )[0]
  if (byLegacySub) return !byLegacySub.isActive

  if (!identity.email) return false

  // Only SSO accounts merge by email; a local password account (idaasSub null) is a
  // different principal and must not be matched by a bare email collision.
  const byEmail = (
    await db
      .select({ isActive: users.isActive, idaasSub: users.idaasSub })
      .from(users)
      .where(eq(users.email, identity.email.toLowerCase()))
      .limit(1)
  )[0]
  if (byEmail?.idaasSub) return !byEmail.isActive

  return false
}
