/**
 * 「SSO 验证即可看」分享访客 cookie。
 *
 * 与 a2wave 登录态（a2wave_session）彻底分离：这张 cookie 只证明「持有者通过了
 * SSO 身份 + 邮箱域名校验」，不对应任何 a2wave 用户行（不查、不建 users 表）。
 * 专门放行 accessLevel='authenticated' 的分享页。
 *
 * 设计：
 * - 作用域 path=/s，一次 SSO 覆盖所有 authenticated 分享（authenticated 级别的门是
 *   统一的「是不是验证过的公司身份」，与具体 share 无关；password 级别才按 share 区分）。
 * - 值自带过期戳并参与 HMAC 签名：泄漏的 cookie 在 exp 之后即便浏览器还没丢也失效，
 *   服务端不需要任何额外状态。
 * - HttpOnly + 按部署决定 Secure + SameSite=Lax；分享页本身是 opaque-origin sandbox，
 *   document.cookie 读不到，杜绝 XSS 偷取。
 */
import { createHmac, timingSafeEqual } from 'node:crypto'
import type { Context } from 'hono'
import { getCookie, setCookie } from 'hono/cookie'
import { env } from '../env.js'
import { isCookieSecure } from './auth-cookie.js'

export const SHARE_VIEWER_COOKIE_NAME = 'a2w_share_viewer'

/** 访客态有效期：2 小时。够看完产物，又不至于把「验证过的访客」态留太久。 */
const SHARE_VIEWER_TTL_SECONDS = 2 * 60 * 60

/** 对过期戳做 HMAC 签名（base64url）。exp 同时作为签名输入，改 exp 必然改签名。 */
function signExpiry(exp: number): string {
  return createHmac('sha256', env.AUTH_SECRET).update(`shareview:${exp}`).digest('base64url')
}

/** 下发访客 cookie（作用域 /s，值形如 `<exp>.<hmac>`）。 */
export function setShareViewerCookie(c: Context): void {
  const exp = Math.floor(Date.now() / 1000) + SHARE_VIEWER_TTL_SECONDS
  setCookie(c, SHARE_VIEWER_COOKIE_NAME, `${exp}.${signExpiry(exp)}`, {
    httpOnly: true,
    secure: isCookieSecure(),
    sameSite: 'Lax',
    path: '/s',
    maxAge: SHARE_VIEWER_TTL_SECONDS,
  })
}

/** 校验请求是否携带未过期且签名有效的访客 cookie。 */
export function isShareViewerAuthed(c: Context): boolean {
  const raw = getCookie(c, SHARE_VIEWER_COOKIE_NAME)
  if (!raw) return false
  const dot = raw.indexOf('.')
  if (dot <= 0) return false
  const exp = Number(raw.slice(0, dot))
  if (!Number.isInteger(exp) || exp <= Math.floor(Date.now() / 1000)) return false
  const sig = Buffer.from(raw.slice(dot + 1))
  const expected = Buffer.from(signExpiry(exp))
  return sig.length === expected.length && timingSafeEqual(sig, expected)
}
