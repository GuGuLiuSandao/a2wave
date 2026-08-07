import { randomBytes, timingSafeEqual } from 'node:crypto'

export const INTERNAL_ADMIN_TOKEN_ENV = 'A2WAVE_INTERNAL_ADMIN_TOKEN'
export const INTERNAL_ADMIN_TOKEN_HEADER = 'x-a2wave-internal-admin-token'

// Generated once per API process. It is intentionally not written to
// process.env, SQLite or logs; only the seeded platform-admin MCP receives it.
const internalAdminToken = randomBytes(32).toString('base64url')

export function getInternalAdminToken(): string {
  return internalAdminToken
}

export function verifyInternalAdminToken(candidate: string | undefined): boolean {
  if (!candidate) return false
  const actual = Buffer.from(internalAdminToken)
  const provided = Buffer.from(candidate)
  return actual.length === provided.length && timingSafeEqual(actual, provided)
}
