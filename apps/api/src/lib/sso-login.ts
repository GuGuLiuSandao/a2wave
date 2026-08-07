/**
 * SSO 身份落地公共逻辑：外部 IdP 身份（私有 JWT 直传 / OIDC / SAML）→ a2wave 用户 + 会话。
 *
 * 三条登录链路共用同一套策略：
 *   - POST /auth/oauth/exchange（私有 JWT 直传，Web callback / CLI）
 *   - GET  /auth/oidc/callback（OIDC 授权码 + PKCE）
 *   - POST /auth/saml/acs（SAML 2.0 POST binding）
 *
 * 错误码沿用历史命名（IDAAS_TOKEN_MISSING_EMAIL 等）保持 API 与前端 i18n 兼容，
 * 语义上等同「SSO token」。
 *
 * 身份匹配规则（按序）：
 *   1. `users.idaas_sub` 精确命中 → 登录。
 *   2. 未命中时按 IdP 已验证邮箱归并——**仅限现有用户本身就是 SSO 账号**
 *      （idaas_sub 非空）。同一企业用户经不同协议登录时 sub 形态不同
 *      （JWT 直传 = 邮箱、OIDC/SAML = IdP 用户名），归并让「企业登录」的
 *      多种方式指向同一账号。**不比较 issuer**：同一企业 IdP 三种协议的
 *      issuer 字符串天然不同（JWT = 根地址、OIDC = discovery issuer、
 *      SAML = 断言 entityID），精确匹配会让跨协议归并必然失败；三种方式
 *      均由管理员在设置页配置且逐一验签，属同一信任域。双方 issuer 记入
 *      **登录审计**（AUTH_OAUTH_LOGIN 的 details.matchedBy/boundSub/...）供追溯：
 *      归并不写库，每次登录都会重跑，单记一条会让每次登录都留重复痕迹。
 *      AUTH_OAUTH_USER_LINKED 只留给 bind 流程——那里才真正写库，且只发生一次。
 *   3. 邮箱属于本地密码账号（idaas_sub 为空）→ 拒绝（EMAIL_ALREADY_BOUND）。
 *      本地账号不做 email 自动绑定，否则同名 IdP 账号可继承本地账号角色；
 *      需要绑定走已登录态下的 POST /auth/oauth/bind。
 */
import { createHash, randomBytes } from 'node:crypto'
import { and, eq } from 'drizzle-orm'
import type { Context } from 'hono'
import { getCookie } from 'hono/cookie'
import { db } from '../db/client.js'
import { users } from '../db/schema.js'
import { AUDIT_ACTIONS } from './audit-actions.js'
import { logAudit } from './audit.js'
import { isCookieSecure, setAuthCookie } from './auth-cookie.js'
import { isEmailDomainAllowed, loadAuthSettings } from './auth-settings.js'
import { AUTH_COOKIE_NAME, LEGACY_AUTH_COOKIE_NAME, signToken, verifyToken } from './auth.js'
import { createId } from './id.js'
import { setShareViewerCookie } from './share-viewer-cookie.js'
import { isSsoAccountDisabled } from './user-status.js'

export type UserRow = typeof users.$inferSelect

/** 各协议归一化后的外部身份（JwtUserInfo / SAML profile 的公共子集）。 */
export interface SsoIdentity {
  /** IdP subject（OIDC sub / SAML NameID / 私有 JWT sub），身份匹配唯一键。 */
  sub: string
  email?: string
  /** 显示名（OIDC preferred_username / name、SAML displayName、私有 JWT idpUsername）。 */
  username?: string
  issuer: string
}

export type SsoFlow = 'exchange' | 'oidc' | 'saml'

/**
 * Protocol name persisted to users.idaas_protocol.
 *
 * `exchange` is the CLI / headless path that submits an IdP-issued OIDC id_token
 * directly, so it records as 'oidc' — same protocol, different entry point.
 */
export type SsoProtocol = 'oidc' | 'saml'

const SSO_FLOW_PROTOCOL: Record<SsoFlow, SsoProtocol> = {
  exchange: 'oidc',
  oidc: 'oidc',
  saml: 'saml',
}

/** Map an internal flow name to the persisted / user-visible protocol name. */
export function ssoProtocolForFlow(flow: SsoFlow): SsoProtocol {
  return SSO_FLOW_PROTOCOL[flow]
}

/** 服务端主导（OIDC/SAML）流的用途：登录 / 分享访客 / 绑定当前用户身份。 */
export type SsoFlowPurpose = 'login' | 'share' | 'bind'

/** 校验为站内分享路径（/s/ 开头），挡 open-redirect / 协议相对地址。与前端 isSafeSharePath 对齐。 */
export function isSafeSharePath(p: string | null | undefined): p is string {
  return !!p && p.startsWith('/s/') && !p.startsWith('/s//')
}

export type SsoLoginOutcome =
  | { ok: true; user: UserRow; token: string }
  | { ok: false; error: string; status: 400 | 403 }

/**
 * 登录成功回跳路径白名单：以单个 / 开头的站内路径，挡 open-redirect。
 * 拒绝 `//`（协议相对）与 `/\`（浏览器把反斜杠规范化为 `/`，`/\evil.com` 会变成
 * 协议相对地址 `//evil.com`）；其余非 / 开头（协议地址等）一律回落 /。
 */
export function sanitizeReturnTo(raw: string | undefined | null): string {
  if (!raw) return '/'
  if (!raw.startsWith('/')) return '/'
  // 第二个字符是 / 或 \ 都视为协议相对地址（浏览器会把 \ 规范化为 /）。
  const second = raw[1]
  if (second === '/' || second === '\\') return '/'
  // 前缀检查不够：URL 解析器会剥掉前导控制字符，`/\t/evil.example` 会被解析成
  // `https://evil.example/`——第二个字符是 tab，上面的检查放行，浏览器却当成协议
  // 相对地址。OIDC/SAML 的 returnTo 可由攻击者直接构造（不经过 SPA），受害者走完
  // 正常 SSO 后被 302 到外站，是个"先真登录、后假落地"的钓鱼跳板。
  //
  // 以哨兵 origin 解析，要求结果仍是同源；再拒绝规范化后以 `//` 开头的路径
  // （`/.//evil.com`、`/%2e%2e//evil.com` 经 dot-segment 规范化会变成 `//evil.com`）。
  try {
    const probeOrigin = 'https://a2wave.invalid'
    const resolved = new URL(raw, probeOrigin)
    if (resolved.origin !== probeOrigin) return '/'
    if (resolved.pathname.startsWith('//')) return '/'
    return `${resolved.pathname}${resolved.search}${resolved.hash}`
  } catch {
    return '/'
  }
}

/**
 * dev 双端口跳回：从登录发起请求的 Referer 提取回环 origin。
 * 开发环境 Web(3501) 与 API(3502) 分端口，OIDC/SAML 回调注册在 API 侧，
 * 登录完成后浏览器会留在 API 端口——记下发起端 origin 才能跳回前端。
 * 仅接受 localhost / 127.0.0.1（生产为公网单一 origin，此函数恒返回 null，行为不变）。
 */
export function loopbackOriginFromReferer(referer: string | undefined | null): string | null {
  if (!referer) return null
  try {
    const u = new URL(referer)
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null
    if (u.hostname !== 'localhost' && u.hostname !== '127.0.0.1') return null
    return u.origin
  } catch {
    return null
  }
}

/**
 * SSO 失败重定向目标：dev 双端口下把 ssoError 页跳回发起端（回环 origin），
 * 生产（origin 为 null）保持相对路径。origin 在 /login 阶段取自 referer，
 * callback/ACS 阶段取自回跳目标 rt（发起时已带回环前缀），均经回环白名单校验。
 */
export function loginErrorTarget(code: string, origin?: string | null): string {
  return `${origin ?? ''}/login?ssoError=${encodeURIComponent(code)}`
}

/**
 * 登录完成后的跳转目标白名单：站内相对路径，或回环绝对地址（dev 双端口跳回）。
 * 其余（外部域名、非 http(s) 协议、// 开头）一律回落 /，挡 open-redirect。
 */
export function sanitizeReturnTarget(raw: string | undefined | null): string {
  if (!raw) return '/'
  if (raw.startsWith('/')) return sanitizeReturnTo(raw)
  const origin = loopbackOriginFromReferer(raw)
  return origin ? new URL(raw).href : '/'
}

/**
 * 从请求的会话 cookie / Bearer 解析当前登录用户 id（不经中间件、不 401）。
 * 供 OIDC/SAML 的 bind 流程在 /login 时捕获发起者身份、签进 flow cookie / RelayState。
 * 校验 token 签名 + DB tokenVersion/isActive；任一不过返回 null。
 */
export async function resolveSessionUserId(c: Context): Promise<string | null> {
  const authHeader = c.req.header('Authorization')
  let token: string | undefined
  if (authHeader?.startsWith('Bearer ')) {
    token = authHeader.slice(7)
  } else {
    token = getCookie(c, AUTH_COOKIE_NAME)
    if (!token && !isCookieSecure()) {
      token = getCookie(c, LEGACY_AUTH_COOKIE_NAME)
    }
  }
  if (!token) return null
  try {
    const payload = await verifyToken(token)
    const user = (
      await db
        .select({ id: users.id, tokenVersion: users.tokenVersion, isActive: users.isActive })
        .from(users)
        .where(eq(users.id, payload.sub))
        .limit(1)
    )[0]
    if (!user || !user.isActive) return null
    if ((payload.tv ?? -1) !== user.tokenVersion) return null
    return user.id
  } catch {
    return null
  }
}

/** SHA-256 截前 16 字符，用于失败审计日志中标识邮箱而不留明文。 */
export function hashEmail(email: string): string {
  return createHash('sha256').update(email.toLowerCase()).digest('hex').slice(0, 16)
}

export function isUniqueConstraintError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err)
  return /unique|constraint/i.test(msg)
}

/**
 * 给 username 加后缀直到与现有用户不重名。SSO 邮箱本地部分就是首选 username；
 * 重名时依次尝试 `<local>2`, `<local>3`...，避免冲突 unique 约束。
 */
async function pickUsername(emailLocal: string): Promise<string> {
  const base = emailLocal.replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 32) || 'sso_user'
  for (let i = 1; i <= 50; i++) {
    const candidate = i === 1 ? base : `${base}${i}`
    const exists = (await db.select().from(users).where(eq(users.username, candidate)).limit(1))[0]
    if (!exists) return candidate
  }
  // 极端兜底：给一个全局唯一的 username
  return `${base}_${createId('usr').slice(4, 12)}`
}

function randomUsernameSuffix(): string {
  return randomBytes(4).toString('base64url').slice(0, 6)
}

export async function insertSsoUserWithRetry(
  identity: SsoIdentity,
  email: string,
  policy: ReturnType<typeof loadAuthSettings>,
  protocol: SsoProtocol,
): Promise<UserRow> {
  const local = email.split('@')[0] ?? 'sso_user'
  let lastErr: unknown
  for (let attempt = 0; attempt < 3; attempt++) {
    const username =
      attempt === 0
        ? await pickUsername(local)
        : `${await pickUsername(local)}_${randomUsernameSuffix()}`
    const id = createId('usr')
    const now = new Date()
    try {
      await db.insert(users).values({
        id,
        username,
        displayName: identity.username || local,
        email,
        idaasSub: identity.sub,
        idaasIssuer: identity.issuer,
        idaasProtocol: protocol,
        role: (await policy).defaultRole,
        passwordHash: null,
        isActive: true,
        locale: 'zh',
        createdAt: now,
        updatedAt: now,
      })
      const inserted = (await db.select().from(users).where(eq(users.id, id)).limit(1))[0]
      if (inserted) return inserted
      // 刚插入却查不到属于不可能态，抛错让上层进入重试/兜底而不是返回 undefined。
      throw new Error('inserted SSO user row not found after insert')
    } catch (err) {
      if (!isUniqueConstraintError(err)) throw err
      lastErr = err
      // 竞态兜底：撞的是 (issuer, sub) 复合唯一键，按相同键回查已存在行。
      const existing = (
        await db
          .select()
          .from(users)
          .where(and(eq(users.idaasIssuer, identity.issuer), eq(users.idaasSub, identity.sub)))
          .limit(1)
      )[0]
      if (existing) return existing
    }
  }
  throw lastErr
}

/**
 * 已验证的外部身份 → 本地用户 + a2wave 会话（含 HttpOnly cookie）。
 * 调用方负责协议侧校验（签名 / nonce / state / InResponseTo）；本函数只做
 * 策略（邮箱域名白名单、自动开户、停用检查）与会话签发，成功/失败都写审计。
 */
export async function completeSsoLogin(
  c: Context,
  identity: SsoIdentity,
  flow: SsoFlow,
): Promise<SsoLoginOutcome> {
  const policy = loadAuthSettings()

  if (!identity.email) {
    logAudit(c, {
      action: AUDIT_ACTIONS.AUTH_OAUTH_EXCHANGE_FAILED,
      details: { reason: 'IDAAS_TOKEN_MISSING_EMAIL', status: 400, flow },
    })
    return { ok: false, error: 'IDAAS_TOKEN_MISSING_EMAIL', status: 400 }
  }

  const email = identity.email.toLowerCase()
  const idaasSub = identity.sub

  if (!isEmailDomainAllowed(email, (await policy).allowedEmailDomains)) {
    logAudit(c, {
      action: AUDIT_ACTIONS.AUTH_OAUTH_EXCHANGE_FAILED,
      details: {
        reason: 'EMAIL_DOMAIN_NOT_ALLOWED',
        status: 403,
        emailHash: hashEmail(email),
        flow,
      },
    })
    return { ok: false, error: 'EMAIL_DOMAIN_NOT_ALLOWED', status: 403 }
  }

  // 身份键按 (issuer, sub) 命名空间：不同 IdP 的同名 subject 是不同的人，只在各自 issuer 内
  // 匹配，避免跨 IdP 同 sub 直接命中他人账号。存量 issuer=null 的账号此处查不到，靠下方按
  // email 的跨协议归并路径兜底（等价于换一种登录方式仍归并到同一账号）。
  let user = (
    await db
      .select()
      .from(users)
      .where(and(eq(users.idaasIssuer, identity.issuer), eq(users.idaasSub, idaasSub)))
      .limit(1)
  )[0]

  // 按邮箱跨协议归并时记下证据，随登录审计一并落库（见下方归并分支）。
  let mergeDetails: Record<string, unknown> = {}

  if (!user) {
    // 跨 SSO 方式归并：不同协议/issuer 的 sub 形态不同，按 IdP 已验证邮箱归并到现有 SSO 账号；
    // 本地密码账号（idaasSub 为空）不自动绑定。
    const byEmail = (await db.select().from(users).where(eq(users.email, email)).limit(1))[0]
    if (byEmail) {
      // 本地密码账号（idaasSub 为空）→ 拒绝归并：否则同名 IdP 账号可继承本地账号
      // 角色；需要绑定走已登录态下的 bind 流程。SSO 账号则不比较 issuer（见文件头），
      // 双方 issuer 记入归并审计供追溯。
      if (!byEmail.idaasSub) {
        logAudit(c, {
          action: AUDIT_ACTIONS.AUTH_OAUTH_EXCHANGE_FAILED,
          details: {
            reason: 'EMAIL_ALREADY_BOUND',
            status: 403,
            emailHash: hashEmail(email),
            flow,
          },
        })
        return { ok: false, error: 'EMAIL_ALREADY_BOUND', status: 403 }
      }
      user = byEmail
      // 归并信息并入下方的登录审计，而不是单记一条：归并**不写库**（见文件头
      // 规则 2——三种协议 sub 形态不同，users 每行只存一对 (issuer, sub)，
      // 覆盖会让另一种协议反过来失配），所以这条路径每次登录都会重跑。单记一条
      // 会让每次 SSO 登录都留下重复的「关联」痕迹，也会和 bind 流程里真正一次性
      // 写库的 AUTH_OAUTH_USER_LINKED 混淆。
      mergeDetails = {
        matchedBy: 'email',
        boundIssuer: user.idaasIssuer,
        incomingSub: idaasSub,
        boundSub: user.idaasSub,
      }
    }
  }

  if (!user) {
    if (!(await policy).oauthAutoProvision) {
      logAudit(c, {
        action: AUDIT_ACTIONS.AUTH_OAUTH_EXCHANGE_FAILED,
        details: {
          reason: 'USER_NOT_PROVISIONED',
          status: 403,
          emailHash: hashEmail(email),
          flow,
        },
      })
      return { ok: false, error: 'USER_NOT_PROVISIONED', status: 403 }
    }

    try {
      // Freshly inserted rows already carry the protocol, so the `!idaasProtocol`
      // guard below filters them out; the helper's race fallback may instead return
      // a pre-existing row, which the same guard backfills if it is still NULL.
      user = await insertSsoUserWithRetry(identity, email, policy, ssoProtocolForFlow(flow))
    } catch (err) {
      // 竞态兜底：重试耗尽仍撞唯一索引（多半是 email 被并发占用且无法按 sub 归并），
      // 返回结构化错误而不是让调用方 500。
      if (!isUniqueConstraintError(err)) throw err
      logAudit(c, {
        action: AUDIT_ACTIONS.AUTH_OAUTH_EXCHANGE_FAILED,
        details: {
          reason: 'EMAIL_ALREADY_BOUND',
          status: 403,
          emailHash: hashEmail(email),
          flow,
        },
      })
      return { ok: false, error: 'EMAIL_ALREADY_BOUND', status: 403 }
    }
    logAudit(c, {
      action: AUDIT_ACTIONS.AUTH_OAUTH_USER_PROVISIONED,
      resource: 'user',
      resourceId: user.id,
      userId: user.id,
      details: { email, idaasSub, defaultRole: (await policy).defaultRole, flow },
    })
  }

  if (!user.isActive) {
    logAudit(c, {
      action: AUDIT_ACTIONS.AUTH_OAUTH_EXCHANGE_FAILED,
      userId: user.id,
      details: { reason: 'ACCOUNT_DISABLED', status: 403, flow },
    })
    return { ok: false, error: 'ACCOUNT_DISABLED', status: 403 }
  }

  // Backfill idaas_protocol for rows written before the column existed.
  //
  // Deliberately placed AFTER the isActive gate: a disabled account must not cause a
  // row write at all. Doing it earlier bumped users.updatedAt on every rejected login
  // and mutated state on a path whose only audit entry records a FAILED login.
  //
  // Also covers the email-merge branch. That branch is excluded from *sub* rewrites
  // (the stored sub belongs to another protocol — see the merge comment above), but
  // the protocol is a different field: `flow` is the protocol the user just
  // authenticated with, so recording it is accurate however the row was matched.
  // Without this, a legacy row whose sub predates the current IdP's `sub` claim
  // never matches by (issuer, sub), so it merges by email on EVERY login and stays
  // NULL forever — the badge is stuck on the generic "SSO" glyph.
  //
  // The `!user.idaasProtocol` guard still makes this a one-shot backfill, so an
  // account that later signs in via the other protocol is not relabelled.
  if (!user.idaasProtocol) {
    const protocol = ssoProtocolForFlow(flow)
    await db
      .update(users)
      .set({ idaasProtocol: protocol, updatedAt: new Date() })
      .where(eq(users.id, user.id))
    user = { ...user, idaasProtocol: protocol }
    logAudit(c, {
      action: AUDIT_ACTIONS.AUTH_OAUTH_PROTOCOL_BACKFILLED,
      resource: 'user',
      resourceId: user.id,
      userId: user.id,
      details: { protocol, flow },
    })
  }

  const token = await signToken({ id: user.id, role: user.role, tokenVersion: user.tokenVersion })
  setAuthCookie(c, token)
  logAudit(c, {
    action: AUDIT_ACTIONS.AUTH_OAUTH_LOGIN,
    resource: 'user',
    resourceId: user.id,
    userId: user.id,
    details: {
      email,
      idaasSub,
      flow,
      channel: c.req.header('user-agent')?.includes('a2wave-cli') ? 'cli' : 'web',
      issuer: identity.issuer,
      ...mergeDetails,
    },
  })

  return { ok: true, user, token }
}

export type SsoShareOutcome = { ok: true } | { ok: false; error: string; status: 400 | 403 }

/**
 * 已验证外部身份 → 分享访客 cookie（「SSO 验证即可看」）。
 * 与 completeSsoLogin 的本质区别：**不查、不建、不碰 users 表，也不下发登录态**，
 * 仅校验邮箱域名白名单后放行 accessLevel='authenticated' 分享页。
 * 供 jwt-redirect（/oauth/share-access）与 OIDC/SAML 回调共用同一策略。
 */
export async function completeSsoShareAccess(
  c: Context,
  identity: SsoIdentity,
): Promise<SsoShareOutcome> {
  const policy = loadAuthSettings()
  if (!identity.email) {
    return { ok: false, error: 'IDAAS_TOKEN_MISSING_EMAIL', status: 400 }
  }
  const email = identity.email.toLowerCase()
  if (!isEmailDomainAllowed(email, (await policy).allowedEmailDomains)) {
    logAudit(c, {
      action: AUDIT_ACTIONS.AUTH_SHARE_ACCESS_DENIED,
      details: { reason: 'EMAIL_DOMAIN_NOT_ALLOWED', status: 403, emailHash: hashEmail(email) },
    })
    return { ok: false, error: 'EMAIL_DOMAIN_NOT_ALLOWED', status: 403 }
  }
  // 禁用一个账号必须收回它在平台上的全部访问权，分享页也不例外。访客 cookie 本身
  // 不带身份、签发后两小时内无法吊销，所以只能在签发这一刻拦住；已持有 cookie 的
  // 窗口期由 TTL 收敛。本地没有账号的外部访客不受影响（分享的既有语义）。
  if (await isSsoAccountDisabled({ issuer: identity.issuer, sub: identity.sub, email })) {
    logAudit(c, {
      action: AUDIT_ACTIONS.AUTH_SHARE_ACCESS_DENIED,
      details: { reason: 'ACCOUNT_DISABLED', status: 403, emailHash: hashEmail(email) },
    })
    return { ok: false, error: 'ACCOUNT_DISABLED', status: 403 }
  }
  setShareViewerCookie(c)
  logAudit(c, {
    action: AUDIT_ACTIONS.AUTH_SHARE_ACCESS_GRANTED,
    details: { emailHash: hashEmail(email), idaasSub: identity.sub },
  })
  return { ok: true }
}

export type SsoBindOutcome =
  | { ok: true; email: string }
  | { ok: false; error: string; status: 400 | 403 | 409 }

/**
 * 已验证外部身份 → 绑定到**当前已登录用户**这一行（email/idaasSub/idaasIssuer）。
 * 供 jwt-redirect（/oauth/bind）与 OIDC/SAML 回调共用。
 * 冲突取 A（拒绝不合并）：该 sub/email 已属另一行 → 409。
 */
export async function completeSsoBind(
  c: Context,
  identity: SsoIdentity,
  userId: string,
  protocol: SsoProtocol,
): Promise<SsoBindOutcome> {
  const policy = await loadAuthSettings()
  if (!identity.email) {
    return { ok: false, error: 'IDAAS_TOKEN_MISSING_EMAIL', status: 400 }
  }
  const email = identity.email.toLowerCase()
  const idaasSub = identity.sub
  if (!isEmailDomainAllowed(email, policy.allowedEmailDomains)) {
    return { ok: false, error: 'EMAIL_DOMAIN_NOT_ALLOWED', status: 403 }
  }

  // 冲突检查按 (issuer, sub) 命名空间：只有同一 IdP 的同 sub 才算已被占用，
  // 不同 IdP 的相同 sub 是不同身份，不应误判为冲突。
  const bySub = (
    await db
      .select()
      .from(users)
      .where(and(eq(users.idaasIssuer, identity.issuer), eq(users.idaasSub, idaasSub)))
      .limit(1)
  )[0]
  if (bySub && bySub.id !== userId) {
    return { ok: false, error: 'IDAAS_SUB_ALREADY_BOUND', status: 409 }
  }
  const byEmail = (await db.select().from(users).where(eq(users.email, email)).limit(1))[0]
  if (byEmail && byEmail.id !== userId) {
    return { ok: false, error: 'EMAIL_ALREADY_BOUND', status: 409 }
  }

  try {
    await db
      .update(users)
      .set({
        email,
        idaasSub,
        idaasIssuer: identity.issuer,
        idaasProtocol: protocol,
        updatedAt: new Date(),
      })
      .where(eq(users.id, userId))
  } catch (err) {
    if (isUniqueConstraintError(err)) {
      return { ok: false, error: 'IDAAS_IDENTITY_ALREADY_BOUND', status: 409 }
    }
    throw err
  }

  logAudit(c, {
    action: AUDIT_ACTIONS.AUTH_OAUTH_USER_LINKED,
    resource: 'user',
    resourceId: userId,
    userId,
    details: { email, idaasSub, issuer: identity.issuer },
  })
  return { ok: true, email }
}
