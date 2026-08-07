import { Hono } from 'hono'
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../../env.js', () => ({
  env: { AUTH_SECRET: 'test-secret-with-sufficient-entropy-for-tests-1234' },
}))

vi.mock('../../lib/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}))

vi.mock('../../lib/server-url.js', () => ({
  getServerUrl: () => 'https://a2wave.test',
  getSsoCallbackOrigin: () => 'https://a2wave.test',
}))

vi.mock('../../lib/auth-cookie.js', () => ({
  isCookieSecure: () => false,
}))

const mockLoadAuthSettings = vi.fn()
vi.mock('../../lib/auth-settings.js', () => ({
  loadAuthSettings: () => mockLoadAuthSettings(),
}))

const mockGetOidcEnv = vi.fn()
const mockGetOidcConfiguration = vi.fn()
const isEmailExplicitlyUnverified = (p: Record<string, unknown>) =>
  p.email_verified === false || p.email_verified === 'false'
const isEmailExplicitlyVerified = (p: Record<string, unknown>) =>
  p.email_verified === true || p.email_verified === 'true'
vi.mock('../../lib/oidc.js', () => ({
  getOidcEnv: () => mockGetOidcEnv(),
  getOidcConfiguration: () => mockGetOidcConfiguration(),
  isEmailExplicitlyUnverified: (p: Record<string, unknown>) => isEmailExplicitlyUnverified(p),
  isEmailExplicitlyVerified: (p: Record<string, unknown>) => isEmailExplicitlyVerified(p),
  oidcClaimsToUserInfo: (payload: Record<string, unknown>, issuer: string) => {
    if (typeof payload.sub !== 'string' || !payload.sub) {
      throw new Error('oidc id_token missing sub claim')
    }
    // 与源码一致：id_token 明确 email_verified:false 时丢弃 email
    const email = isEmailExplicitlyUnverified(payload) ? undefined : payload.email
    return { sub: payload.sub, email, issuer, raw: payload }
  },
}))

const mockBuildAuthorizationUrl = vi.fn()
const mockAuthorizationCodeGrant = vi.fn()
const mockFetchUserInfo = vi.fn()
vi.mock('openid-client', async (importOriginal) => ({
  ...(await importOriginal<typeof import('openid-client')>()),
  buildAuthorizationUrl: (...args: unknown[]) => mockBuildAuthorizationUrl(...args),
  authorizationCodeGrant: (...args: unknown[]) => mockAuthorizationCodeGrant(...args),
  fetchUserInfo: (...args: unknown[]) => mockFetchUserInfo(...args),
}))

const mockCompleteSsoLogin = vi.fn()
const mockCompleteSsoShareAccess = vi.fn()
const mockCompleteSsoBind = vi.fn()
const mockResolveSessionUserId = vi.fn()
vi.mock('../../lib/sso-login.js', () => {
  const sanitizeReturnTo = (raw: string | undefined | null) => {
    if (!raw || !raw.startsWith('/')) return '/'
    const second = raw[1]
    if (second === '/' || second === '\\') return '/'
    return raw
  }
  const loopbackOriginFromReferer = (referer: string | undefined | null) => {
    if (!referer) return null
    try {
      const u = new URL(referer)
      const ok =
        (u.protocol === 'http:' || u.protocol === 'https:') &&
        (u.hostname === 'localhost' || u.hostname === '127.0.0.1')
      return ok ? u.origin : null
    } catch {
      return null
    }
  }
  return {
    completeSsoLogin: (...args: unknown[]) => mockCompleteSsoLogin(...args),
    completeSsoShareAccess: (...args: unknown[]) => mockCompleteSsoShareAccess(...args),
    completeSsoBind: (...args: unknown[]) => mockCompleteSsoBind(...args),
    resolveSessionUserId: (...args: unknown[]) => mockResolveSessionUserId(...args),
    isSafeSharePath: (p: string | null | undefined): p is string =>
      !!p && p.startsWith('/s/') && !p.startsWith('/s//'),
    sanitizeReturnTo,
    loopbackOriginFromReferer,
    loginErrorTarget: (code: string, origin?: string | null) =>
      `${origin ?? ''}/login?ssoError=${encodeURIComponent(code)}`,
    sanitizeReturnTarget: (raw: string | undefined | null) => {
      if (!raw) return '/'
      if (raw.startsWith('/')) return sanitizeReturnTo(raw)
      return loopbackOriginFromReferer(raw) ? new URL(raw).href : '/'
    },
  }
})

const ENABLED_POLICY = {
  oauthEnabled: true,
  allowedEmailDomains: [],
  defaultRole: 'user',
  oauthAutoProvision: true,
  passwordLoginEnabled: true,
}

const OIDC_ENV = {
  issuer: 'https://idp.test',
  clientId: 'a2wave-client',
  scopes: 'openid profile email',
  source: 'settings' as const,
  enabled: true,
}

const FAKE_CONFIGURATION = { serverMetadata: () => ({ issuer: 'https://idp.test' }) }

function extractFlowCookie(res: Response): string {
  const setCookie = res.headers.get('set-cookie') ?? ''
  const match = setCookie.match(/a2w_oidc_flow=([^;]+)/)
  expect(match, `flow cookie should be set, got: ${setCookie}`).toBeTruthy()
  return `a2w_oidc_flow=${match?.[1]}`
}

describe('OIDC login routes', () => {
  let app: Hono

  beforeEach(async () => {
    vi.clearAllMocks()
    mockLoadAuthSettings.mockReturnValue(ENABLED_POLICY)
    mockGetOidcEnv.mockReturnValue(OIDC_ENV)
    mockGetOidcConfiguration.mockResolvedValue(FAKE_CONFIGURATION)
    mockBuildAuthorizationUrl.mockImplementation(
      (_config: unknown, params: Record<string, string>) => {
        const url = new URL('https://idp.test/authorize')
        for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v)
        return url
      },
    )
    const mod = await import('../auth-oidc.js')
    app = new Hono()
    app.route('/api/auth/oidc', mod.default)
  })

  describe('GET /login', () => {
    it('redirects with OAUTH_DISABLED_BY_ADMIN when policy is off', async () => {
      mockLoadAuthSettings.mockReturnValue({ ...ENABLED_POLICY, oauthEnabled: false })
      const res = await app.request('/api/auth/oidc/login')
      expect(res.status).toBe(302)
      expect(res.headers.get('location')).toBe('/login?ssoError=OAUTH_DISABLED_BY_ADMIN')
    })

    it('redirects with OAUTH_NOT_CONFIGURED when OIDC env is missing', async () => {
      mockGetOidcEnv.mockReturnValue(null)
      const res = await app.request('/api/auth/oidc/login')
      expect(res.headers.get('location')).toBe('/login?ssoError=OAUTH_NOT_CONFIGURED')
    })

    it('redirects with SSO_DISCOVERY_FAILED when discovery throws', async () => {
      mockGetOidcConfiguration.mockRejectedValue(new Error('boom'))
      const res = await app.request('/api/auth/oidc/login')
      expect(res.headers.get('location')).toBe('/login?ssoError=SSO_DISCOVERY_FAILED')
    })

    it('login-stage errors redirect back to the loopback origin (dev two-port)', async () => {
      // dev 双端口：错误页也必须跳回前端端口，否则落在 API 端口变 Not Found
      mockGetOidcConfiguration.mockRejectedValue(new Error('boom'))
      const res = await app.request('/api/auth/oidc/login', {
        headers: { referer: 'http://127.0.0.1:3501/login' },
      })
      expect(res.headers.get('location')).toBe(
        'http://127.0.0.1:3501/login?ssoError=SSO_DISCOVERY_FAILED',
      )
    })

    it('302s to the authorization endpoint with PKCE and sets the flow cookie', async () => {
      const res = await app.request('/api/auth/oidc/login?returnTo=/agents')
      expect(res.status).toBe(302)

      const location = new URL(res.headers.get('location') ?? '')
      expect(location.origin + location.pathname).toBe('https://idp.test/authorize')
      expect(location.searchParams.get('redirect_uri')).toBe(
        'https://a2wave.test/api/auth/oidc/callback',
      )
      expect(location.searchParams.get('scope')).toBe('openid profile email')
      expect(location.searchParams.get('code_challenge_method')).toBe('S256')
      expect(location.searchParams.get('code_challenge')).toBeTruthy()
      expect(location.searchParams.get('state')).toBeTruthy()
      expect(location.searchParams.get('nonce')).toBeTruthy()

      const setCookie = res.headers.get('set-cookie') ?? ''
      expect(setCookie).toContain('a2w_oidc_flow=')
      expect(setCookie).toContain('HttpOnly')
      expect(setCookie).toContain('Path=/api/auth/oidc')
    })
  })

  describe('GET /callback', () => {
    async function startLogin(returnTo = '/') {
      const res = await app.request(`/api/auth/oidc/login?returnTo=${encodeURIComponent(returnTo)}`)
      const location = new URL(res.headers.get('location') ?? '')
      return {
        cookie: extractFlowCookie(res),
        state: location.searchParams.get('state') ?? '',
      }
    }

    it('redirects with SSO_FLOW_EXPIRED when the flow cookie is missing', async () => {
      const res = await app.request('/api/auth/oidc/callback?code=abc&state=xyz')
      expect(res.headers.get('location')).toBe('/login?ssoError=SSO_FLOW_EXPIRED')
    })

    it('completes login and redirects to the sanitized returnTo', async () => {
      const { cookie, state } = await startLogin('/agents')
      mockAuthorizationCodeGrant.mockResolvedValue({
        claims: () => ({ sub: 'user-1', email: 'alice@example.com' }),
      })
      mockCompleteSsoLogin.mockResolvedValue({ ok: true, user: { id: 'usr_1' }, token: 't' })

      const res = await app.request(`/api/auth/oidc/callback?code=abc&state=${state}`, {
        headers: { cookie },
      })

      expect(res.status).toBe(302)
      expect(res.headers.get('location')).toBe('/agents')
      // completeSsoLogin 拿到归一化身份，flow 标记为 oidc
      expect(mockCompleteSsoLogin).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ sub: 'user-1', email: 'alice@example.com' }),
        'oidc',
      )
      // code 校验交给 openid-client：state/nonce/PKCE verifier 悉数传入
      const checks = mockAuthorizationCodeGrant.mock.calls[0][2] as Record<string, unknown>
      expect(checks.expectedState).toBe(state)
      expect(typeof checks.pkceCodeVerifier).toBe('string')
      expect(typeof checks.expectedNonce).toBe('string')
      expect(checks.idTokenExpected).toBe(true)
      // currentUrl 以注册的 redirect_uri 为基准重建（防反向代理内部地址错配）
      const currentUrl = mockAuthorizationCodeGrant.mock.calls[0][1] as URL
      expect(currentUrl.origin + currentUrl.pathname).toBe(
        'https://a2wave.test/api/auth/oidc/callback',
      )
      expect(currentUrl.searchParams.get('code')).toBe('abc')
    })

    it('redirects back to the loopback origin the login started from (dev two-port)', async () => {
      // 登录从 vite 前端（127.0.0.1:3501）发起：Referer 为回环 origin
      const loginRes = await app.request('/api/auth/oidc/login?returnTo=/agents', {
        headers: { referer: 'http://127.0.0.1:3501/login' },
      })
      const cookie = extractFlowCookie(loginRes)
      const state = new URL(loginRes.headers.get('location') ?? '').searchParams.get('state') ?? ''

      mockAuthorizationCodeGrant.mockResolvedValue({
        claims: () => ({ sub: 'user-1', email: 'alice@example.com' }),
      })
      mockCompleteSsoLogin.mockResolvedValue({ ok: true, user: { id: 'usr_1' }, token: 't' })

      const res = await app.request(`/api/auth/oidc/callback?code=abc&state=${state}`, {
        headers: { cookie },
      })
      expect(res.headers.get('location')).toBe('http://127.0.0.1:3501/agents')
    })

    it('ignores a non-loopback referer origin (production unchanged)', async () => {
      const loginRes = await app.request('/api/auth/oidc/login?returnTo=/agents', {
        headers: { referer: 'https://a2wave.example.com/login' },
      })
      const cookie = extractFlowCookie(loginRes)
      const state = new URL(loginRes.headers.get('location') ?? '').searchParams.get('state') ?? ''

      mockAuthorizationCodeGrant.mockResolvedValue({ claims: () => ({ sub: 'user-1' }) })
      mockCompleteSsoLogin.mockResolvedValue({ ok: true, user: { id: 'usr_1' }, token: 't' })

      const res = await app.request(`/api/auth/oidc/callback?code=abc&state=${state}`, {
        headers: { cookie },
      })
      expect(res.headers.get('location')).toBe('/agents')
    })

    it('falls back to / when returnTo is an external URL', async () => {
      const { cookie, state } = await startLogin('https://evil.example.com/phish')
      mockAuthorizationCodeGrant.mockResolvedValue({ claims: () => ({ sub: 'u' }) })
      mockCompleteSsoLogin.mockResolvedValue({ ok: true, user: { id: 'usr_1' }, token: 't' })

      const res = await app.request(`/api/auth/oidc/callback?code=abc&state=${state}`, {
        headers: { cookie },
      })
      expect(res.headers.get('location')).toBe('/')
    })

    async function startFlow(query: string) {
      const res = await app.request(`/api/auth/oidc/login?${query}`)
      const loc = res.headers.get('location') ?? ''
      if (!loc.startsWith('http') && !loc.includes('state=')) {
        // 早退（如 BIND_REQUIRES_LOGIN / SHARE_BAD_RETURN）：无 flow cookie/state
        return { cookie: '', state: '', location: loc }
      }
      const url = new URL(loc)
      return {
        cookie: extractFlowCookie(res),
        state: url.searchParams.get('state') ?? '',
        location: loc,
      }
    }

    it('purpose=share callback grants share access (no login) and redirects to /s/ path', async () => {
      const { cookie, state } = await startFlow('purpose=share&returnTo=/s/abc')
      mockAuthorizationCodeGrant.mockResolvedValue({
        claims: () => ({ sub: 'u', email: 'a@example.com' }),
      })
      mockCompleteSsoShareAccess.mockReturnValue({ ok: true })

      const res = await app.request(`/api/auth/oidc/callback?code=abc&state=${state}`, {
        headers: { cookie },
      })
      expect(mockCompleteSsoShareAccess).toHaveBeenCalled()
      expect(mockCompleteSsoLogin).not.toHaveBeenCalled()
      expect(res.headers.get('location')).toBe('/s/abc')
    })

    it('purpose=share rejects a non-/s/ returnTo at /login', async () => {
      const { location } = await startFlow('purpose=share&returnTo=/agents')
      expect(location).toBe('/login?ssoError=SHARE_BAD_RETURN')
    })

    it('purpose=bind captures the session uid and binds on callback', async () => {
      mockResolveSessionUserId.mockResolvedValue('usr_me')
      const { cookie, state } = await startFlow('purpose=bind&returnTo=/agents/x')
      mockAuthorizationCodeGrant.mockResolvedValue({
        claims: () => ({ sub: 'u', email: 'a@example.com' }),
      })
      mockCompleteSsoBind.mockReturnValue({ ok: true })

      const res = await app.request(`/api/auth/oidc/callback?code=abc&state=${state}`, {
        headers: { cookie },
      })
      // The 4th arg records WHICH protocol bound the identity.
      expect(mockCompleteSsoBind).toHaveBeenCalledWith(
        expect.anything(),
        expect.anything(),
        'usr_me',
        'oidc',
      )
      expect(mockCompleteSsoLogin).not.toHaveBeenCalled()
      expect(res.headers.get('location')).toBe('/agents/x')
    })

    it('purpose=bind without a session redirects with BIND_REQUIRES_LOGIN', async () => {
      mockResolveSessionUserId.mockResolvedValue(null)
      const { location } = await startFlow('purpose=bind&returnTo=/agents/x')
      expect(location).toBe('/login?ssoError=BIND_REQUIRES_LOGIN')
    })

    it('purpose=bind rejects on callback when the current session no longer matches flow.uid', async () => {
      // /login 时会话为 usr_me（进 flow cookie）；回调阶段会话已切换/失效 → 拒绝绑定。
      mockResolveSessionUserId.mockResolvedValueOnce('usr_me')
      const { cookie, state } = await startFlow('purpose=bind&returnTo=/agents/x')
      mockAuthorizationCodeGrant.mockResolvedValue({
        claims: () => ({ sub: 'u', email: 'a@example.com' }),
      })
      mockResolveSessionUserId.mockResolvedValue('usr_other')

      const res = await app.request(`/api/auth/oidc/callback?code=abc&state=${state}`, {
        headers: { cookie },
      })
      expect(mockCompleteSsoBind).not.toHaveBeenCalled()
      expect(res.headers.get('location')).toBe('/login?ssoError=BIND_REQUIRES_LOGIN')
    })

    it('redirects with SSO_TOKEN_EXCHANGE_FAILED when the code grant fails', async () => {
      const { cookie, state } = await startLogin()
      mockAuthorizationCodeGrant.mockRejectedValue(new Error('invalid_grant'))

      const res = await app.request(`/api/auth/oidc/callback?code=abc&state=${state}`, {
        headers: { cookie },
      })
      expect(res.headers.get('location')).toBe('/login?ssoError=SSO_TOKEN_EXCHANGE_FAILED')
      expect(mockCompleteSsoLogin).not.toHaveBeenCalled()
    })

    it('callback-stage errors redirect back to the loopback origin (dev two-port)', async () => {
      // 登录从 vite 前端发起，回调阶段策略失败：错误页同样要跳回前端端口
      const loginRes = await app.request('/api/auth/oidc/login?returnTo=/agents', {
        headers: { referer: 'http://127.0.0.1:3501/login' },
      })
      const cookie = extractFlowCookie(loginRes)
      const state = new URL(loginRes.headers.get('location') ?? '').searchParams.get('state') ?? ''

      mockAuthorizationCodeGrant.mockResolvedValue({
        claims: () => ({ sub: 'u', email: 'a@example.com' }),
      })
      mockCompleteSsoLogin.mockResolvedValue({
        ok: false,
        error: 'EMAIL_ALREADY_BOUND',
        status: 403,
      })

      const res = await app.request(`/api/auth/oidc/callback?code=abc&state=${state}`, {
        headers: { cookie },
      })
      expect(res.headers.get('location')).toBe(
        'http://127.0.0.1:3501/login?ssoError=EMAIL_ALREADY_BOUND',
      )
    })

    it('surfaces completeSsoLogin policy failures via ssoError', async () => {
      const { cookie, state } = await startLogin()
      mockAuthorizationCodeGrant.mockResolvedValue({
        claims: () => ({ sub: 'u', email: 'a@evil.com' }),
      })
      mockCompleteSsoLogin.mockResolvedValue({
        ok: false,
        error: 'EMAIL_DOMAIN_NOT_ALLOWED',
        status: 403,
      })

      const res = await app.request(`/api/auth/oidc/callback?code=abc&state=${state}`, {
        headers: { cookie },
      })
      expect(res.headers.get('location')).toBe('/login?ssoError=EMAIL_DOMAIN_NOT_ALLOWED')
    })

    it('falls back to the userinfo endpoint when the id_token lacks an email claim', async () => {
      const { cookie, state } = await startLogin('/agents')
      // 部分 IdP 形态：id_token 只有 sub，email 在 userinfo 端点
      mockAuthorizationCodeGrant.mockResolvedValue({
        access_token: 'at_123',
        claims: () => ({ sub: 'johndoe' }),
      })
      mockFetchUserInfo.mockResolvedValue({
        sub: 'johndoe',
        email: 'johndoe@example.com',
        displayname: 'John Doe',
      })
      mockCompleteSsoLogin.mockResolvedValue({ ok: true, user: { id: 'usr_1' }, token: 't' })

      const res = await app.request(`/api/auth/oidc/callback?code=abc&state=${state}`, {
        headers: { cookie },
      })

      expect(res.headers.get('location')).toBe('/agents')
      expect(mockFetchUserInfo).toHaveBeenCalledWith(FAKE_CONFIGURATION, 'at_123', 'johndoe')
      expect(mockCompleteSsoLogin).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ sub: 'johndoe', email: 'johndoe@example.com' }),
        'oidc',
      )
    })

    it('ignores an unverified userinfo email (email_verified:false) → falls to missing-email policy error', async () => {
      const { cookie, state } = await startLogin()
      mockAuthorizationCodeGrant.mockResolvedValue({
        access_token: 'at_123',
        claims: () => ({ sub: 'unverified' }),
      })
      // userinfo 回了 email，但 email_verified:false → 不得用作归并键
      mockFetchUserInfo.mockResolvedValue({
        sub: 'unverified',
        email: 'victim@example.com',
        email_verified: false,
      })
      mockCompleteSsoLogin.mockResolvedValue({
        ok: false,
        error: 'IDAAS_TOKEN_MISSING_EMAIL',
        status: 400,
      })

      const res = await app.request(`/api/auth/oidc/callback?code=abc&state=${state}`, {
        headers: { cookie },
      })
      expect(res.headers.get('location')).toBe('/login?ssoError=IDAAS_TOKEN_MISSING_EMAIL')
      expect(mockCompleteSsoLogin).toHaveBeenCalledWith(
        expect.anything(),
        expect.not.objectContaining({ email: 'victim@example.com' }),
        'oidc',
      )
    })

    it('does not let a userinfo email WITHOUT email_verified whitewash an id_token that explicitly rejected it', async () => {
      const { cookie, state } = await startLogin()
      // id_token 明确 email_verified:false（email 被 oidcClaimsToUserInfo 丢弃）
      mockAuthorizationCodeGrant.mockResolvedValue({
        access_token: 'at_123',
        claims: () => ({ sub: 'washed', email: 'victim@example.com', email_verified: false }),
      })
      // userinfo 回同一 email 但省略 email_verified → 不得据此重新接受（否则绕过 id_token 拒绝）
      mockFetchUserInfo.mockResolvedValue({ sub: 'washed', email: 'victim@example.com' })
      mockCompleteSsoLogin.mockResolvedValue({
        ok: false,
        error: 'IDAAS_TOKEN_MISSING_EMAIL',
        status: 400,
      })

      const res = await app.request(`/api/auth/oidc/callback?code=abc&state=${state}`, {
        headers: { cookie },
      })
      expect(res.headers.get('location')).toBe('/login?ssoError=IDAAS_TOKEN_MISSING_EMAIL')
      expect(mockCompleteSsoLogin).toHaveBeenCalledWith(
        expect.anything(),
        expect.not.objectContaining({ email: 'victim@example.com' }),
        'oidc',
      )
    })

    it('accepts a userinfo email when userinfo EXPLICITLY re-verifies it after an id_token rejection', async () => {
      const { cookie, state } = await startLogin()
      mockAuthorizationCodeGrant.mockResolvedValue({
        access_token: 'at_123',
        claims: () => ({ sub: 'recheck', email: 'alice@example.com', email_verified: false }),
      })
      // userinfo 显式 email_verified:true → 采信（IdP 在 userinfo 侧重新背书）
      mockFetchUserInfo.mockResolvedValue({
        sub: 'recheck',
        email: 'alice@example.com',
        email_verified: true,
      })
      mockCompleteSsoLogin.mockResolvedValue({ ok: true, user: { id: 'usr_1' }, token: 't' })

      const res = await app.request(`/api/auth/oidc/callback?code=abc&state=${state}`, {
        headers: { cookie },
      })
      expect(mockCompleteSsoLogin).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ email: 'alice@example.com' }),
        'oidc',
      )
    })

    it('proceeds to the policy error when userinfo also lacks email', async () => {
      const { cookie, state } = await startLogin()
      mockAuthorizationCodeGrant.mockResolvedValue({
        access_token: 'at_123',
        claims: () => ({ sub: 'noemail' }),
      })
      mockFetchUserInfo.mockResolvedValue({ sub: 'noemail' })
      mockCompleteSsoLogin.mockResolvedValue({
        ok: false,
        error: 'IDAAS_TOKEN_MISSING_EMAIL',
        status: 400,
      })

      const res = await app.request(`/api/auth/oidc/callback?code=abc&state=${state}`, {
        headers: { cookie },
      })
      expect(res.headers.get('location')).toBe('/login?ssoError=IDAAS_TOKEN_MISSING_EMAIL')
    })

    it('degrades gracefully when the userinfo request itself fails', async () => {
      const { cookie, state } = await startLogin()
      mockAuthorizationCodeGrant.mockResolvedValue({
        access_token: 'at_123',
        claims: () => ({ sub: 'ufail' }),
      })
      mockFetchUserInfo.mockRejectedValue(new Error('userinfo 500'))
      mockCompleteSsoLogin.mockResolvedValue({
        ok: false,
        error: 'IDAAS_TOKEN_MISSING_EMAIL',
        status: 400,
      })

      const res = await app.request(`/api/auth/oidc/callback?code=abc&state=${state}`, {
        headers: { cookie },
      })
      // userinfo 失败不 500，落到缺 email 的策略错误
      expect(res.headers.get('location')).toBe('/login?ssoError=IDAAS_TOKEN_MISSING_EMAIL')
    })

    it('redirects with INVALID_IDAAS_TOKEN when the id_token has no claims', async () => {
      const { cookie, state } = await startLogin()
      mockAuthorizationCodeGrant.mockResolvedValue({ claims: () => undefined })

      const res = await app.request(`/api/auth/oidc/callback?code=abc&state=${state}`, {
        headers: { cookie },
      })
      expect(res.headers.get('location')).toBe('/login?ssoError=INVALID_IDAAS_TOKEN')
    })

    it('clears the flow cookie on the callback response', async () => {
      const { cookie, state } = await startLogin()
      mockAuthorizationCodeGrant.mockResolvedValue({ claims: () => ({ sub: 'u' }) })
      mockCompleteSsoLogin.mockResolvedValue({ ok: true, user: { id: 'usr_1' }, token: 't' })

      const res = await app.request(`/api/auth/oidc/callback?code=abc&state=${state}`, {
        headers: { cookie },
      })
      expect(res.headers.get('set-cookie') ?? '').toMatch(/a2w_oidc_flow=;/)
    })
  })
})
