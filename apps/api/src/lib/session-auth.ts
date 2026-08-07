import { eq } from 'drizzle-orm'
import { db } from '../db/client.js'
import { users } from '../db/schema.js'
import { verifyToken } from './auth.js'

export interface AuthenticatedSessionUser {
  id: string
  role: string
}

/** Validate a session JWT against the current user record and revocation state. */
export async function authenticateSessionToken(
  token: string,
): Promise<AuthenticatedSessionUser | null> {
  try {
    const payload = await verifyToken(token)
    const [user] = await db
      .select({
        id: users.id,
        role: users.role,
        tokenVersion: users.tokenVersion,
        isActive: users.isActive,
      })
      .from(users)
      .where(eq(users.id, payload.sub))
      .limit(1)

    if (!user?.isActive || (payload.tv ?? -1) !== user.tokenVersion) return null
    return { id: user.id, role: user.role }
  } catch {
    return null
  }
}
