/**
 * 标准 OIDC 登录路由（授权码 + PKCE，openid-client 实现）：
 *   GET /api/auth/oidc/login     → 302 到 IdP authorization_endpoint
 *   GET /api/auth/oidc/callback  → code 换 token（state/nonce/PKCE/id_token 校验由
 *                                  openid-client 完成）、落地 a2wave 会话
 *
 * 流程状态（state / nonce / PKCE verifier / returnTo）经 AUTH_SECRET 签名的短期
 * HS256 JWT 存 HttpOnly cookie（SameSite=Lax，回调是顶层 GET 导航可携带），无
 * 服务端存储，符合单容器部署约束。失败一律 302 回 /login?ssoError=<code>，
 * 由登录页 i18n 呈现。
 */
import { type Context, Hono } from 'hono'
import { deleteCookie, getCookie, setCookie } from 'hono/cookie'
import { SignJWT, jwtVerify } from 'jose'
import * as oidcClient from 'openid-client'
import { env } from '../env.js'
import { isCookieSecure } from '../lib/auth-cookie.js'
import { loadAuthSettings } from '../lib/auth-settings.js'
import { logger } from '../lib/logger.js'
import {
  getOidcConfiguration,
  getOidcEnv,
  isEmailExplicitlyUnverified,
  isEmailExplicitlyVerified,
  oidcClaimsToUserInfo,
} from '../lib/oidc.js'
import { getSsoCallbackOrigin } from '../lib/server-url.js'
import {
  type SsoFlowPurpose,
  completeSsoBind,
  completeSsoLogin,
  completeSsoShareAccess,
  isSafeSharePath,
  loginErrorTarget,
  loopbackOriginFromReferer,
  resolveSessionUserId,
  sanitizeReturnTarget,
  sanitizeReturnTo,
} from '../lib/sso-login.js'

const app = new Hono()

const FLOW_COOKIE = 'a2w_oidc_flow'
const FLOW_TTL_SECONDS = 600

interface FlowState {
  state: string
  nonce: string
  /** PKCE code_verifier */
  cv: string
  /** 登录成功后的站内回跳路径 */
  rt: string
  /** 流用途：login（默认）/ share（分享访客）/ bind（绑定当前用户）。 */
  purpose: SsoFlowPurpose
  /** purpose='bind' 时发起者的用户 id（在 /login 时从会话捕获，签进 cookie 防篡改）。 */
  uid?: string
}

function flowSecret(): Uint8Array {
  return new TextEncoder().encode(`${env.AUTH_SECRET}:oidc-flow`)
}

async function sealFlow(flow: FlowState): Promise<string> {
  return new SignJWT({ ...flow })
    .setProtectedHeader({ alg: 'HS256' })
    .setExpirationTime(`${FLOW_TTL_SECONDS}s`)
    .setIssuedAt()
    .sign(flowSecret())
}

async function openFlow(sealed: string): Promise<FlowState | null> {
  try {
    const { payload } = await jwtVerify(sealed, flowSecret(), { algorithms: ['HS256'] })
    if (
      typeof payload.state !== 'string' ||
      typeof payload.nonce !== 'string' ||
      typeof payload.cv !== 'string'
    ) {
      return null
    }
    const purpose: SsoFlowPurpose =
      payload.purpose === 'share' || payload.purpose === 'bind' ? payload.purpose : 'login'
    return {
      state: payload.state,
      nonce: payload.nonce,
      cv: payload.cv,
      rt: typeof payload.rt === 'string' ? payload.rt : '/',
      purpose,
      ...(typeof payload.uid === 'string' ? { uid: payload.uid } : {}),
    }
  } catch {
    return null
  }
}

/**
 * 回调地址：本方式的 callbackOrigin 覆盖 > publicBaseUrl；都未配（生产）时返回 null，
 * 调用方报 SSO_PUBLIC_URL_NOT_SET。
 *
 * 授权请求与 code 兑换必须传**逐字符相同**的 redirect_uri，两处都经由此函数取值。
 */
async function redirectUri(): Promise<string | null> {
  const origin = await getSsoCallbackOrigin((await getOidcEnv())?.callbackOrigin)
  return origin ? `${origin}/api/auth/oidc/callback` : null
}

/** 失败重定向：dev 双端口下带上发起端回环 origin，否则相对路径（生产不变）。 */
function loginErrorRedirect(c: Context, code: string, origin?: string | null) {
  return c.redirect(loginErrorTarget(code, origin), 302)
}

app.get('/login', async (c) => {
  // dev 双端口跳回：成功与失败重定向都要回到发起端（vite 前端）的回环 origin。
  const devOrigin = loopbackOriginFromReferer(c.req.header('referer'))
  const policy = await loadAuthSettings()
  if (!policy.oauthEnabled) return loginErrorRedirect(c, 'OAUTH_DISABLED_BY_ADMIN', devOrigin)
  const cfg = await getOidcEnv()
  if (!cfg || !cfg.enabled) return loginErrorRedirect(c, 'OAUTH_NOT_CONFIGURED', devOrigin)

  let configuration: oidcClient.Configuration
  try {
    configuration = await getOidcConfiguration()
  } catch (err) {
    logger.error({ err: (err as Error).message }, 'OIDC discovery failed on /oidc/login')
    return loginErrorRedirect(c, 'SSO_DISCOVERY_FAILED', devOrigin)
  }

  // 流用途：login（默认）/ share（分享访客）/ bind（绑定当前登录用户）。
  const purposeRaw = c.req.query('purpose')
  const purpose: SsoFlowPurpose =
    purposeRaw === 'share' || purposeRaw === 'bind' ? purposeRaw : 'login'

  // bind 必须由已登录用户发起：此刻从会话捕获 uid 签进 flow cookie（防篡改）。
  let uid: string | undefined
  if (purpose === 'bind') {
    const sessionUid = await resolveSessionUserId(c)
    if (!sessionUid) return loginErrorRedirect(c, 'BIND_REQUIRES_LOGIN', devOrigin)
    uid = sessionUid
  }

  // share 的回跳必须是站内分享路径（/s/...）；非法则拒绝（不落到任意 returnTo）。
  // login/bind 沿用站内相对路径白名单 + dev 双端口跳回。
  let rt: string
  if (purpose === 'share') {
    const sharePath = c.req.query('returnTo')
    if (!isSafeSharePath(sharePath)) return loginErrorRedirect(c, 'SHARE_BAD_RETURN', devOrigin)
    rt = devOrigin ? `${devOrigin}${sharePath}` : sharePath
  } else {
    const rtPath = sanitizeReturnTo(c.req.query('returnTo'))
    rt = devOrigin ? `${devOrigin}${rtPath}` : rtPath
  }

  const flow: FlowState = {
    state: oidcClient.randomState(),
    nonce: oidcClient.randomNonce(),
    cv: oidcClient.randomPKCECodeVerifier(),
    rt,
    purpose,
    ...(uid ? { uid } : {}),
  }

  const redirect = await redirectUri()
  if (!redirect) return loginErrorRedirect(c, 'SSO_PUBLIC_URL_NOT_SET', devOrigin)

  setCookie(c, FLOW_COOKIE, await sealFlow(flow), {
    httpOnly: true,
    secure: isCookieSecure(),
    sameSite: 'Lax',
    path: '/api/auth/oidc',
    maxAge: FLOW_TTL_SECONDS,
  })

  const authorizationUrl = oidcClient.buildAuthorizationUrl(configuration, {
    redirect_uri: redirect,
    scope: cfg.scopes,
    state: flow.state,
    nonce: flow.nonce,
    code_challenge: await oidcClient.calculatePKCECodeChallenge(flow.cv),
    code_challenge_method: 'S256',
  })
  return c.redirect(authorizationUrl.toString(), 302)
})

app.get('/callback', async (c) => {
  const policy = loadAuthSettings()
  if (!(await policy).oauthEnabled) return loginErrorRedirect(c, 'OAUTH_DISABLED_BY_ADMIN')
  if (!(await getOidcEnv())?.enabled) return loginErrorRedirect(c, 'OAUTH_NOT_CONFIGURED')

  const sealed = getCookie(c, FLOW_COOKIE)
  deleteCookie(c, FLOW_COOKIE, { path: '/api/auth/oidc' })

  const flow = sealed ? await openFlow(sealed) : null
  if (!flow) return loginErrorRedirect(c, 'SSO_FLOW_EXPIRED')

  // dev 双端口跳回：flow.rt 在 /login 阶段已带回环 origin，失败重定向沿用同一 origin。
  const devOrigin = loopbackOriginFromReferer(flow.rt)

  let configuration: oidcClient.Configuration
  try {
    configuration = await getOidcConfiguration()
  } catch (err) {
    logger.error({ err: (err as Error).message }, 'OIDC discovery failed on /oidc/callback')
    return loginErrorRedirect(c, 'SSO_DISCOVERY_FAILED', devOrigin)
  }

  // 回调参数（code/state/error）以注册的 redirect_uri 为基准重建 URL 提交给
  // openid-client——直接用 c.req.url 在反向代理后是内部地址，会导致校验错配。
  const redirect = await redirectUri()
  if (!redirect) return loginErrorRedirect(c, 'SSO_PUBLIC_URL_NOT_SET', devOrigin)
  const currentUrl = new URL(await redirect)
  currentUrl.search = new URL(c.req.url).search

  let tokens: oidcClient.TokenEndpointResponse & oidcClient.TokenEndpointResponseHelpers
  try {
    // authorizationCodeGrant 内部完成：授权响应校验（含 IdP error 参数）、state 比对、
    // code + PKCE verifier 换 token、id_token 验签（iss/aud/exp/签名）与 nonce 比对。
    tokens = await oidcClient.authorizationCodeGrant(configuration, currentUrl, {
      pkceCodeVerifier: flow.cv,
      expectedState: flow.state,
      expectedNonce: flow.nonce,
      idTokenExpected: true,
    })
  } catch (err) {
    logger.warn({ err: (err as Error).message }, 'OIDC authorization code grant failed')
    return loginErrorRedirect(c, 'SSO_TOKEN_EXCHANGE_FAILED', devOrigin)
  }

  const idTokenClaims = tokens.claims()
  if (!idTokenClaims) return loginErrorRedirect(c, 'INVALID_IDAAS_TOKEN', devOrigin)

  let identity: ReturnType<typeof oidcClaimsToUserInfo>
  try {
    identity = oidcClaimsToUserInfo(idTokenClaims, configuration.serverMetadata().issuer)
  } catch (err) {
    logger.warn({ err: (err as Error).message }, 'OIDC id_token claims missing required fields')
    return loginErrorRedirect(c, 'INVALID_IDAAS_TOKEN', devOrigin)
  }

  // 部分 IdP 的 id_token 只带 sub，email/显示名在 userinfo 端点——
  // 缺 email 时用 access_token 回退拉 userinfo 补齐；失败不阻断，落到策略层的
  // IDAAS_TOKEN_MISSING_EMAIL 给出明确错误。
  if (!identity.email && tokens.access_token) {
    try {
      const userInfo = await oidcClient.fetchUserInfo(
        configuration,
        tokens.access_token,
        identity.sub,
      )
      // userinfo 的 email 采信规则（防未验证邮箱被用作跨协议归并键）：
      //   - 一般情况：只要不是显式 email_verified:false 就接受（缺声明视为可用）。
      //   - 但若 id_token 已**明确**把该邮箱判为未验证（isEmailExplicitlyUnverified(raw)），
      //     则 userinfo 不得用「缺声明」把它洗白——此时要求 userinfo 自身显式 email_verified:true。
      // 否则 IdP 只需在 userinfo 省略该声明，就能绕过 id_token 的明确拒绝。
      const ui = userInfo as Record<string, unknown>
      const idTokenRejectedEmail = isEmailExplicitlyUnverified(
        identity.raw as Record<string, unknown>,
      )
      const uiAcceptable = idTokenRejectedEmail
        ? isEmailExplicitlyVerified(ui)
        : !isEmailExplicitlyUnverified(ui)
      if (uiAcceptable && typeof userInfo.email === 'string' && userInfo.email) {
        identity.email = userInfo.email
      }
      if (!identity.username) {
        const extra = userInfo as Record<string, unknown>
        const candidate = [
          userInfo.preferred_username,
          userInfo.name,
          extra.displayname,
          extra.username,
        ].find((v): v is string => typeof v === 'string' && !!v)
        if (candidate) identity.username = candidate
      }
    } catch (err) {
      logger.warn({ err: (err as Error).message }, 'OIDC userinfo fallback failed')
    }
  }

  // 按用途分流：share 只发访客 cookie，bind 绑定到发起者，login 走登录态交换。
  if (flow.purpose === 'share') {
    const shareOutcome = await completeSsoShareAccess(c, identity)
    if (!shareOutcome.ok) return loginErrorRedirect(c, shareOutcome.error, devOrigin)
    // rt 已在 /login 校验为 /s/ 开头（含 dev 回环前缀）。
    return c.redirect(sanitizeReturnTarget(flow.rt), 302)
  }

  if (flow.purpose === 'bind') {
    if (!flow.uid) return loginErrorRedirect(c, 'BIND_REQUIRES_LOGIN', devOrigin)
    // OIDC callback 是 GET 顶层导航：① flow.uid 取自 HttpOnly flow cookie，本已把流绑定到
    // 发起浏览器（攻击者无法把自己的 flow cookie 塞进受害者浏览器）；② Lax 会话 cookie 在
    // 顶层 GET 会被携带，故这里可安全复核当前会话 === flow.uid 作纵深防御。
    // （SAML ACS 是跨站 POST，Lax 会话 cookie 不携带，只能用专用 nonce cookie，见 auth-saml.ts。）
    const sessionUid = await resolveSessionUserId(c)
    if (!sessionUid || sessionUid !== flow.uid) {
      return loginErrorRedirect(c, 'BIND_REQUIRES_LOGIN', devOrigin)
    }
    const bindOutcome = await completeSsoBind(c, identity, flow.uid, 'oidc')
    if (!bindOutcome.ok) return loginErrorRedirect(c, bindOutcome.error, devOrigin)
    return c.redirect(sanitizeReturnTarget(flow.rt), 302)
  }

  const outcome = await completeSsoLogin(c, identity, 'oidc')
  if (!outcome.ok) return loginErrorRedirect(c, outcome.error, devOrigin)

  return c.redirect(sanitizeReturnTarget(flow.rt), 302)
})

export default app
