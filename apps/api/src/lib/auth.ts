import { hash, verify } from '@node-rs/argon2'
import { verify as jwtVerify, sign } from 'hono/jwt'
import type { JWTPayload } from 'hono/utils/jwt/types'
import { env } from '../env.js'

/** 密码策略: 至少 8 字符，包含大写、小写、数字 */
export const PASSWORD_POLICY = {
  minLength: 8,
  requireUppercase: true,
  requireLowercase: true,
  requireDigit: true,
}

export function validatePassword(password: string): { valid: boolean; message?: string } {
  if (password.length < PASSWORD_POLICY.minLength) {
    return { valid: false, message: 'PASSWORD_TOO_SHORT' }
  }
  if (PASSWORD_POLICY.requireUppercase && !/[A-Z]/.test(password)) {
    return { valid: false, message: 'PASSWORD_NEED_UPPER' }
  }
  if (PASSWORD_POLICY.requireLowercase && !/[a-z]/.test(password)) {
    return { valid: false, message: 'PASSWORD_NEED_LOWER' }
  }
  if (PASSWORD_POLICY.requireDigit && !/\d/.test(password)) {
    return { valid: false, message: 'PASSWORD_NEED_DIGIT' }
  }
  return { valid: true }
}

export async function hashPassword(plain: string): Promise<string> {
  return hash(plain)
}

export async function verifyPassword(hashed: string, plain: string): Promise<boolean> {
  return verify(hashed, plain)
}

export function getAuthSessionTtlSeconds(): number {
  return env.AUTH_SESSION_TTL_DAYS * 24 * 60 * 60
}

export interface JwtPayload {
  sub: string // userId
  role: string
  /** Token 版本号，与 users.tokenVersion 比对；不一致即视为吊销。 */
  tv: number
  iat: number
  exp: number
}

export interface SignTokenInput {
  id: string
  role: string
  tokenVersion: number
}

export async function signToken(user: SignTokenInput): Promise<string> {
  const now = Math.floor(Date.now() / 1000)
  const payload: JWTPayload = {
    sub: user.id,
    role: user.role,
    tv: user.tokenVersion,
    iat: now,
    exp: now + getAuthSessionTtlSeconds(),
  }
  return sign(payload, env.AUTH_SECRET)
}

export async function verifyToken(token: string): Promise<JwtPayload> {
  const payload = await jwtVerify(token, env.AUTH_SECRET, 'HS256')
  return payload as unknown as JwtPayload
}

export const AUTH_COOKIE_NAME = '__Host-a2wave_session'
export const LEGACY_AUTH_COOKIE_NAME = 'a2wave_session'
