import { Hono } from 'hono'
import { errors as joseErrors } from 'jose'
import { type Mock, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../../db/client.js', () => ({
  db: {
    select: vi.fn(),
    insert: vi.fn(),
    update: vi.fn(),
  },
}))

vi.mock('../../db/schema.js', () => ({
  users: {
    id: 'id',
    username: 'username',
    email: 'email',
    idaasSub: 'idaas_sub',
    isActive: 'is_active',
  },
}))

vi.mock('../../lib/audit.js', () => ({
  logAudit: vi.fn(),
}))

vi.mock('../../lib/setup.js', () => ({
  isSetupRequired: () => false,
}))

vi.mock('../../lib/auth.js', () => ({
  signToken: vi.fn(async () => 'a2w_token_xyz'),
  hashPassword: vi.fn(),
  verifyPassword: vi.fn(),
  validatePassword: vi.fn(() => ({ valid: true })),
  AUTH_COOKIE_NAME: 'a2wave_session',
}))

vi.mock('../../lib/auth-cookie.js', () => ({
  setAuthCookie: vi.fn(),
  clearAuthCookie: vi.fn(),
}))

const mockCreateId = vi.fn((prefix: string) => `${prefix}_test123`)
vi.mock('../../lib/id.js', () => ({
  createId: (prefix: string) => mockCreateId(prefix),
}))

vi.mock('../../lib/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}))

// exchange 的验签走企业 OIDC：mockValidate 即 verifyOidcIdToken 的行为。
const mockValidate = vi.fn()
const mockIsOidcConfigured = vi.fn(() => false)
// getOidcEnv 决定 /oauth/config 的 OAUTH_NOT_CONFIGURED vs DISABLED_BY_ADMIN 分支；
// 默认与 isOidcConfigured 同步：configured=true 时返回 enabled 配置，否则 null。
const mockGetOidcEnv = vi.fn<() => unknown>(() =>
  mockIsOidcConfigured() ? { issuer: 'https://idp.test', clientId: 'x', enabled: true } : null,
)
vi.mock('../../lib/oidc.js', async (importOriginal) => {
  // The real classifier: this route must agree with the OAuth channel on what
  // counts as a token fault, so the test exercises it rather than restating it.
  const actual = await importOriginal<typeof import('../../lib/oidc.js')>()
  return {
    isOidcConfigured: () => mockIsOidcConfigured(),
    getOidcEnv: () => mockGetOidcEnv(),
    verifyOidcIdToken: (...args: unknown[]) => mockValidate(...args),
    isIdpUnavailableError: actual.isIdpUnavailableError,
  }
})

// /oauth/config 用 getSsoCallbackOrigin 判定 OIDC/SAML 回调 origin 可用性；默认可用（非空），
// 使既有用例语义不变（配置齐即可用）。个别用例可覆盖为 null 验证「origin 不可用则不展示」。
const mockGetSsoCallbackOrigin = vi.fn<() => string | null>(() => 'https://a2wave.test')
vi.mock('../../lib/server-url.js', () => ({
  getSsoCallbackOrigin: () => mockGetSsoCallbackOrigin(),
  // 这些用例不测按方式覆盖回调 origin：一律视作未填，走 publicBaseUrl 回落。
  normalizeCallbackOriginOverride: () => null,
}))

const mockIsSamlConfigured = vi.fn(() => false)
const mockGetSamlEnv = vi.fn<() => unknown>(() =>
  mockIsSamlConfigured()
    ? { entryPoint: 'https://idp.test/sso', idpCert: 'x', enabled: true }
    : null,
)
vi.mock('../../lib/saml-config.js', () => ({
  isSamlConfigured: () => mockIsSamlConfigured(),
  getSamlEnv: () => mockGetSamlEnv(),
}))

const mockLoadAuthSettings = vi.fn()
vi.mock('../../lib/auth-settings.js', () => ({
  loadAuthSettings: () => mockLoadAuthSettings(),
  isEmailDomainAllowed: (email: string, allowed: string[]) => {
    if (allowed.length === 0) return true
    const at = email.lastIndexOf('@')
    if (at < 0) return false
    return allowed.includes(email.slice(at + 1).toLowerCase())
  },
  resetAuthSettingsCache: vi.fn(),
}))

import { db } from '../../db/client.js'
import { logAudit } from '../../lib/audit.js'
import { signToken } from '../../lib/auth.js'

import { asyncQuery } from '../../test/async-query.js'

type SelectChain = {
  from: () => { where: () => { get: () => unknown } }
}

function makeSelectGet(returns: unknown[]): SelectChain {
  let i = 0
  return {
    from: () =>
      asyncQuery({
        where: () =>
          asyncQuery({
            get: () => returns[i++ % returns.length],
          }),
      }),
  }
}

function makeInsertChain(): { values: () => { run: () => void } } {
  return { values: () => asyncQuery({ run: () => {} }) }
}

function makeInsertChainWithRuns(runs: Array<() => void>): {
  values: (value: unknown) => { run: () => void }
} {
  return {
    values: () =>
      asyncQuery({
        run: () => {
          const nextRun = runs.shift()
          if (nextRun) nextRun()
        },
      }),
  }
}

function makeUpdateChain(): { set: () => { where: () => { run: () => void } } } {
  return { set: () => asyncQuery({ where: () => asyncQuery({ run: () => {} }) }) }
}

describe('POST /auth/oauth/exchange', () => {
  let app: Hono

  beforeEach(async () => {
    vi.clearAllMocks()
    ;(db.insert as Mock).mockReturnValue(makeInsertChain())
    ;(db.update as Mock).mockReturnValue(makeUpdateChain())
    mockLoadAuthSettings.mockReset()
    mockValidate.mockReset()
    mockIsOidcConfigured.mockReturnValue(true)

    const mod = await import('../auth.js')
    app = new Hono()
    app.route('/api/auth', mod.default)
  })

  it('returns 503 OAUTH_NOT_CONFIGURED when OIDC is not configured', async () => {
    mockIsOidcConfigured.mockReturnValue(false)
    mockLoadAuthSettings.mockReturnValue({
      oauthEnabled: true,
      allowedEmailDomains: [],
      defaultRole: 'user',
      oauthAutoProvision: true,
      passwordLoginEnabled: true,
    })
    const res = await app.request('/api/auth/oauth/exchange', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ idaasToken: 'jwt' }),
    })
    expect(res.status).toBe(503)
    const body = (await res.json()) as { error: string }
    expect(body.error).toBe('OAUTH_NOT_CONFIGURED')
    expect(logAudit).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ action: 'auth.oauth.exchange_failed' }),
    )
  })

  it('returns 503 OAUTH_DISABLED_BY_ADMIN when policy disabled', async () => {
    mockLoadAuthSettings.mockReturnValue({
      oauthEnabled: false,
      allowedEmailDomains: [],
      defaultRole: 'user',
      oauthAutoProvision: true,
      passwordLoginEnabled: true,
    })
    const res = await app.request('/api/auth/oauth/exchange', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ idaasToken: 'jwt' }),
    })
    expect(res.status).toBe(503)
    expect(((await res.json()) as { error: string }).error).toBe('OAUTH_DISABLED_BY_ADMIN')
  })

  it('returns 401 INVALID_IDAAS_TOKEN when validate throws', async () => {
    mockLoadAuthSettings.mockReturnValue({
      oauthEnabled: true,
      allowedEmailDomains: [],
      defaultRole: 'user',
      oauthAutoProvision: true,
      passwordLoginEnabled: true,
    })
    mockValidate.mockRejectedValue(new joseErrors.JWTExpired('token expired', {}))
    const res = await app.request('/api/auth/oauth/exchange', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ idaasToken: 'jwt' }),
    })
    expect(res.status).toBe(401)
    expect(((await res.json()) as { error: string }).error).toBe('INVALID_IDAAS_TOKEN')
  })

  /**
   * The response stays a bare code on purpose — it answers an unauthenticated
   * caller. But the audit entry is the admin's only record of *why* a login was
   * refused, and "INVALID_IDAAS_TOKEN" alone sends them hunting. A misconfigured
   * issuer and an expired token look identical there, which is exactly how a
   * trailing-slash mismatch stayed hidden.
   */
  it('records the verification diagnostic in the audit entry', async () => {
    mockLoadAuthSettings.mockReturnValue({
      oauthEnabled: true,
      allowedEmailDomains: [],
      defaultRole: 'user',
      oauthAutoProvision: true,
      passwordLoginEnabled: true,
    })
    // jose's verbatim wording now that issuer checking is delegated back to it.
    mockValidate.mockRejectedValue(
      new joseErrors.JWTClaimValidationFailed('unexpected "iss" claim value', {}, 'iss'),
    )
    await app.request('/api/auth/oauth/exchange', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ idaasToken: 'jwt' }),
    })

    const entry = vi.mocked(logAudit).mock.calls.at(-1)?.[1] as {
      details?: Record<string, unknown>
    }
    // 响应对未鉴权调用方只回裸 code，审计条目是管理员唯一能看到「为什么被拒」的地方。
    expect(String(entry?.details?.detail)).toContain('"iss" claim')
  })

  it('rejects a token OIDC verification refuses, without naming a settings field', async () => {
    // 验签公钥来自 IdP JWKS（非设置页的输入框），失败时不该把责任指向某个可编辑字段。
    mockLoadAuthSettings.mockReturnValue({
      oauthEnabled: true,
      allowedEmailDomains: [],
      defaultRole: 'user',
      oauthAutoProvision: true,
      passwordLoginEnabled: true,
    })
    mockValidate.mockRejectedValue(new joseErrors.JWSSignatureVerificationFailed())

    const res = await app.request('/api/auth/oauth/exchange', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ idaasToken: 'bad' }),
    })

    expect(res.status).toBe(401)
    expect(((await res.json()) as { error: string }).error).toBe('INVALID_IDAAS_TOKEN')
    const entry = vi.mocked(logAudit).mock.calls.at(-1)?.[1] as {
      details?: Record<string, unknown>
    }
    expect(entry?.details?.field).toBeUndefined()
  })

  /**
   * `a2wave login` is what calls this route. Reporting an IdP outage as
   * INVALID_IDAAS_TOKEN told the user to sign in again — advice that cannot
   * work, and that hides an upstream fault which resolves on its own.
   */
  it('returns a retryable 503 when the IdP is unreachable, not 401', async () => {
    mockLoadAuthSettings.mockReturnValue({
      oauthEnabled: true,
      allowedEmailDomains: [],
      defaultRole: 'user',
      oauthAutoProvision: true,
      passwordLoginEnabled: true,
    })
    // A bare network fault, as undici/openid-client raise for a discovery failure.
    mockValidate.mockRejectedValue(new TypeError('fetch failed'))

    const res = await app.request('/api/auth/oauth/exchange', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ idaasToken: 'whatever' }),
    })

    expect(res.status).toBe(503)
    expect(((await res.json()) as { error: string }).error).toBe('IDP_UNAVAILABLE')
    const entry = vi.mocked(logAudit).mock.calls.at(-1)?.[1] as {
      details?: Record<string, unknown>
    }
    expect(entry?.details?.reason).toBe('IDP_UNAVAILABLE')
    expect(entry?.details?.status).toBe(503)
  })

  it('verifies the submitted token against the enterprise OIDC issuer', async () => {
    mockLoadAuthSettings.mockReturnValue({
      oauthEnabled: true,
      allowedEmailDomains: [],
      defaultRole: 'user',
      oauthAutoProvision: true,
      passwordLoginEnabled: true,
    })
    // 验签成功但缺 email → 走到策略层的 400，证明验签链路确实被调用
    mockValidate.mockResolvedValue({ sub: 'oidc_1', issuer: 'https://idp.test', raw: {} })
    const res = await app.request('/api/auth/oauth/exchange', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ idaasToken: 'oidc-id-token' }),
    })
    expect(res.status).toBe(400)
    expect(((await res.json()) as { error: string }).error).toBe('IDAAS_TOKEN_MISSING_EMAIL')
    expect(mockValidate).toHaveBeenCalledWith('oidc-id-token')
  })

  it('returns 400 IDAAS_TOKEN_MISSING_EMAIL when claims have no email', async () => {
    mockLoadAuthSettings.mockReturnValue({
      oauthEnabled: true,
      allowedEmailDomains: [],
      defaultRole: 'user',
      oauthAutoProvision: true,
      passwordLoginEnabled: true,
    })
    mockValidate.mockResolvedValue({ sub: 'sub_1', issuer: 'https://idaas.test/', raw: {} })
    const res = await app.request('/api/auth/oauth/exchange', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ idaasToken: 'jwt' }),
    })
    expect(res.status).toBe(400)
    expect(((await res.json()) as { error: string }).error).toBe('IDAAS_TOKEN_MISSING_EMAIL')
  })

  it('returns 403 EMAIL_DOMAIN_NOT_ALLOWED when domain not in allowlist', async () => {
    mockLoadAuthSettings.mockReturnValue({
      oauthEnabled: true,
      allowedEmailDomains: ['example.com'],
      defaultRole: 'user',
      oauthAutoProvision: true,
      passwordLoginEnabled: true,
    })
    mockValidate.mockResolvedValue({ sub: 'sub_1', email: 'a@evil.com', issuer: 'x', raw: {} })
    const res = await app.request('/api/auth/oauth/exchange', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ idaasToken: 'jwt' }),
    })
    expect(res.status).toBe(403)
    expect(((await res.json()) as { error: string }).error).toBe('EMAIL_DOMAIN_NOT_ALLOWED')
  })

  it('returns 401 OAUTH_NONCE_MISMATCH when a web nonce is provided but the external JWT has a different nonce', async () => {
    mockLoadAuthSettings.mockReturnValue({
      oauthEnabled: true,
      allowedEmailDomains: [],
      defaultRole: 'user',
      oauthAutoProvision: true,
      passwordLoginEnabled: true,
    })
    mockValidate.mockResolvedValue({
      sub: 'sub_1',
      email: 'a@example.com',
      issuer: 'x',
      raw: { nonce: 'token-nonce' },
    })

    const res = await app.request('/api/auth/oauth/exchange', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ idaasToken: 'jwt', nonce: 'browser-nonce-value' }),
    })

    expect(res.status).toBe(401)
    expect(((await res.json()) as { error: string }).error).toBe('OAUTH_NONCE_MISMATCH')
    expect(db.select).not.toHaveBeenCalled()
  })

  it('returns 403 USER_NOT_PROVISIONED when autoProvision=false and user missing', async () => {
    mockLoadAuthSettings.mockReturnValue({
      oauthEnabled: true,
      allowedEmailDomains: [],
      defaultRole: 'user',
      oauthAutoProvision: false,
      passwordLoginEnabled: true,
    })
    mockValidate.mockResolvedValue({ sub: 'sub_1', email: 'a@example.com', issuer: 'x', raw: {} })
    ;(db.select as Mock).mockReturnValue(makeSelectGet([undefined]))

    const res = await app.request('/api/auth/oauth/exchange', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ idaasToken: 'jwt' }),
    })
    expect(res.status).toBe(403)
    expect(((await res.json()) as { error: string }).error).toBe('USER_NOT_PROVISIONED')
  })

  it('auto-provisions a new user with default role and signs a token', async () => {
    mockLoadAuthSettings.mockReturnValue({
      oauthEnabled: true,
      allowedEmailDomains: [],
      defaultRole: 'user',
      oauthAutoProvision: true,
      passwordLoginEnabled: true,
    })
    mockValidate.mockResolvedValue({
      sub: 'sub_1',
      email: 'NewUser@example.com',
      username: 'newuser',
      issuer: 'x',
      raw: {},
    })
    // 1st: lookup by idaasSub → none
    // 2nd: 跨方式归并的 email lookup → none
    // 3rd: pickUsername loop checks username 'newuser' → none
    // 4th: re-read inserted user
    ;(db.select as Mock).mockReturnValue(
      makeSelectGet([
        undefined, // initial lookup by idaasSub
        undefined, // cross-method email lookup
        undefined, // pickUsername availability check
        {
          id: 'usr_test123',
          username: 'newuser',
          displayName: 'newuser',
          email: 'newuser@example.com',
          idaasSub: 'sub_1',
          role: 'user',
          isActive: true,
        },
      ]),
    )

    const res = await app.request('/api/auth/oauth/exchange', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ idaasToken: 'jwt' }),
    })
    expect(res.status).toBe(200)
    const body = (await res.json()) as {
      data: { token: string; user: { email: string; role: string } }
    }
    expect(body.data.token).toBe('a2w_token_xyz')
    expect(body.data.user.email).toBe('newuser@example.com')
    expect(body.data.user.role).toBe('user')
    expect(signToken).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'usr_test123', role: 'user' }),
    )

    const auditCalls = (logAudit as Mock).mock.calls.map((c) => c[1].action)
    expect(auditCalls).toContain('auth.oauth.user_provisioned')
    expect(auditCalls).toContain('auth.oauth.login')
  })

  it('retries SSO auto-provisioning on unique constraint without using createId as the username suffix', async () => {
    const uniqueErr = new Error('UNIQUE constraint failed: users.username')
    mockLoadAuthSettings.mockReturnValue({
      oauthEnabled: true,
      allowedEmailDomains: [],
      defaultRole: 'user',
      oauthAutoProvision: true,
      passwordLoginEnabled: true,
    })
    mockValidate.mockResolvedValue({
      sub: 'sub_retry',
      email: 'retry@example.com',
      username: 'retry',
      issuer: 'x',
      raw: {},
    })
    ;(db.insert as Mock).mockReturnValue(
      makeInsertChainWithRuns([
        () => {
          throw uniqueErr
        },
        () => {},
      ]),
    )
    ;(db.select as Mock).mockReturnValue(
      makeSelectGet([
        undefined, // initial lookup by idaasSub
        undefined, // cross-method email lookup
        undefined, // first pickUsername
        undefined, // lookup existing by idaasSub after unique failure
        undefined, // retry pickUsername
        {
          id: 'usr_test123',
          username: 'retry_xxxxxx',
          displayName: 'retry',
          email: 'retry@example.com',
          idaasSub: 'sub_retry',
          role: 'user',
          isActive: true,
        },
      ]),
    )

    const res = await app.request('/api/auth/oauth/exchange', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ idaasToken: 'jwt' }),
    })

    expect(res.status).toBe(200)
    // createId should be used for inserted row IDs only, not as entropy for username suffixes.
    expect(mockCreateId).toHaveBeenCalledTimes(2)
  })

  it('does not link an unbound existing password user by email during SSO', async () => {
    mockLoadAuthSettings.mockReturnValue({
      oauthEnabled: true,
      allowedEmailDomains: [],
      defaultRole: 'user',
      oauthAutoProvision: false, // even false; existing user is fine to link
      passwordLoginEnabled: true,
    })
    mockValidate.mockResolvedValue({
      sub: 'sub_2',
      email: 'admin@example.com',
      issuer: 'x',
      raw: {},
    })
    ;(db.select as Mock).mockReturnValue(makeSelectGet([undefined]))

    const res = await app.request('/api/auth/oauth/exchange', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ idaasToken: 'jwt' }),
    })
    expect(res.status).toBe(403)
    expect(((await res.json()) as { error: string }).error).toBe('USER_NOT_PROVISIONED')
    const auditCalls = (logAudit as Mock).mock.calls.map((c) => c[1].action)
    expect(auditCalls).not.toContain('auth.oauth.user_linked')
    expect(signToken).not.toHaveBeenCalled()
  })

  it('returns 403 ACCOUNT_DISABLED for disabled user even with valid SSO', async () => {
    mockLoadAuthSettings.mockReturnValue({
      oauthEnabled: true,
      allowedEmailDomains: [],
      defaultRole: 'user',
      oauthAutoProvision: true,
      passwordLoginEnabled: true,
    })
    mockValidate.mockResolvedValue({
      sub: 'sub_3',
      email: 'banned@example.com',
      issuer: 'x',
      raw: {},
    })
    ;(db.select as Mock).mockReturnValue(
      makeSelectGet([
        {
          id: 'usr_b',
          username: 'banned',
          email: 'banned@example.com',
          idaasSub: 'sub_3',
          role: 'user',
          isActive: false,
        },
      ]),
    )
    const res = await app.request('/api/auth/oauth/exchange', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ idaasToken: 'jwt' }),
    })
    expect(res.status).toBe(403)
    expect(((await res.json()) as { error: string }).error).toBe('ACCOUNT_DISABLED')
  })

  it('returns 400 when body is missing idaasToken', async () => {
    mockLoadAuthSettings.mockReturnValue({
      oauthEnabled: true,
      allowedEmailDomains: [],
      defaultRole: 'user',
      oauthAutoProvision: true,
      passwordLoginEnabled: true,
    })
    const res = await app.request('/api/auth/oauth/exchange', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    })
    expect(res.status).toBe(400)
  })
})

describe('GET /auth/oauth/config', () => {
  let app: Hono

  beforeEach(async () => {
    vi.clearAllMocks()
    mockLoadAuthSettings.mockReset()
    // 各方式默认「未配置」的基线，用例逐个覆写
    mockIsOidcConfigured.mockReturnValue(false)
    mockIsSamlConfigured.mockReturnValue(false)
    const mod = await import('../auth.js')
    app = new Hono()
    app.route('/api/auth', mod.default)
  })

  it('returns enabled=true and lists oidc in methods when OIDC is active', async () => {
    mockIsOidcConfigured.mockReturnValue(true)
    mockLoadAuthSettings.mockReturnValue({
      oauthEnabled: true,
      allowedEmailDomains: [],
      defaultRole: 'user',
      oauthAutoProvision: true,
      passwordLoginEnabled: true,
    })
    const res = await app.request('/api/auth/oauth/config')
    expect(res.status).toBe(200)
    const body = (await res.json()) as {
      data: { enabled: boolean; methods: Array<{ type: string; loginUrl: string }> }
    }
    expect(body.data.enabled).toBe(true)
    expect(body.data.methods).toEqual([{ type: 'oidc', loginUrl: '/api/auth/oidc/login' }])
  })

  // 该端点是公开未鉴权的：登录页只需要知道「有哪些方式、入口在哪」，
  // 任何 issuer / client_id / 密钥材料都不得下发。
  it('never leaks IdP identifiers or key material', async () => {
    mockIsOidcConfigured.mockReturnValue(true)
    mockIsSamlConfigured.mockReturnValue(true)
    mockLoadAuthSettings.mockReturnValue({
      oauthEnabled: true,
      allowedEmailDomains: [],
      defaultRole: 'user',
      oauthAutoProvision: true,
      passwordLoginEnabled: true,
    })
    const raw = await (await app.request('/api/auth/oauth/config')).text()
    expect(raw).not.toContain('https://idp.test')
    expect(raw).not.toContain('clientId')
    mockIsSamlConfigured.mockReturnValue(false)
  })

  it('enables OAuth with both oidc and saml methods', async () => {
    mockIsOidcConfigured.mockReturnValue(true)
    mockIsSamlConfigured.mockReturnValue(true)
    mockLoadAuthSettings.mockReturnValue({
      oauthEnabled: true,
      allowedEmailDomains: [],
      defaultRole: 'user',
      oauthAutoProvision: true,
      passwordLoginEnabled: true,
    })
    const res = await app.request('/api/auth/oauth/config')
    const body = (await res.json()) as {
      data: { enabled: boolean; methods: Array<{ type: string }> }
    }
    expect(body.data.enabled).toBe(true)
    expect(body.data.methods).toEqual([
      { type: 'oidc', loginUrl: '/api/auth/oidc/login' },
      { type: 'saml', loginUrl: '/api/auth/saml/login' },
    ])
    mockIsOidcConfigured.mockReturnValue(false)
    mockIsSamlConfigured.mockReturnValue(false)
  })

  it('omits OIDC/SAML from methods when the callback origin is unavailable (would fail with SSO_PUBLIC_URL_NOT_SET)', async () => {
    // publicBaseUrl 未配 → getSsoCallbackOrigin() 为 null → OIDC/SAML 展示为不可用，
    // 避免登录页把实际会失败的方式呈现给用户。
    mockIsOidcConfigured.mockReturnValue(true)
    mockIsSamlConfigured.mockReturnValue(true)
    mockGetSsoCallbackOrigin.mockReturnValueOnce(null)
    mockLoadAuthSettings.mockReturnValue({
      oauthEnabled: true,
      allowedEmailDomains: [],
      defaultRole: 'user',
      oauthAutoProvision: true,
      passwordLoginEnabled: true,
    })
    const res = await app.request('/api/auth/oauth/config')
    const body = (await res.json()) as { data: { enabled: boolean; reason?: string } }
    // 只有 OIDC/SAML 且 origin 不可用 → 无任何可用方式 → enabled=false
    expect(body.data.enabled).toBe(false)
    mockIsOidcConfigured.mockReturnValue(false)
    mockIsSamlConfigured.mockReturnValue(false)
  })

  it('returns enabled=false reason=OAUTH_NOT_CONFIGURED when nothing is configured', async () => {
    mockLoadAuthSettings.mockReturnValue({
      oauthEnabled: true,
      allowedEmailDomains: [],
      defaultRole: 'user',
      oauthAutoProvision: true,
      passwordLoginEnabled: true,
    })
    const res = await app.request('/api/auth/oauth/config')
    const body = (await res.json()) as { data: { enabled: boolean; reason: string } }
    expect(body.data.enabled).toBe(false)
    expect(body.data.reason).toBe('OAUTH_NOT_CONFIGURED')
  })

  it('returns enabled=false reason=OAUTH_DISABLED_BY_ADMIN when policy off', async () => {
    // 物理配置在（getOidcEnv 非 null），只是总开关关掉 → DISABLED_BY_ADMIN 而非 NOT_CONFIGURED
    mockGetOidcEnv.mockReturnValue({ issuer: 'https://idp.test', clientId: 'x', enabled: true })
    mockLoadAuthSettings.mockReturnValue({
      oauthEnabled: false,
      allowedEmailDomains: [],
      defaultRole: 'user',
      oauthAutoProvision: true,
      passwordLoginEnabled: true,
    })
    const res = await app.request('/api/auth/oauth/config')
    const body = (await res.json()) as { data: { enabled: boolean; reason: string } }
    expect(body.data.enabled).toBe(false)
    expect(body.data.reason).toBe('OAUTH_DISABLED_BY_ADMIN')
  })

  // ── 停用语义：配置齐全但 enabled=false 时该方式不出现在 methods ──────────
  it('omits OIDC from methods when the config is present but disabled', async () => {
    // getOidcEnv 返回配置（物理存在）但 isOidcConfigured=false（停用）→ 不列入 methods
    mockIsOidcConfigured.mockReturnValue(false)
    mockGetOidcEnv.mockReturnValue({ issuer: 'https://idp.test', clientId: 'x', enabled: false })
    mockLoadAuthSettings.mockReturnValue({
      oauthEnabled: true,
      allowedEmailDomains: [],
      defaultRole: 'user',
      oauthAutoProvision: true,
      passwordLoginEnabled: true,
    })
    const res = await app.request('/api/auth/oauth/config')
    const body = (await res.json()) as {
      data: { enabled: boolean; reason?: string; methods?: Array<{ type: string }> }
    }
    expect(body.data.enabled).toBe(false)
    // 配置物理存在 → 停用归类为 DISABLED_BY_ADMIN，而非 NOT_CONFIGURED
    expect(body.data.reason).toBe('OAUTH_DISABLED_BY_ADMIN')
    expect(body.data.methods).toBeUndefined()
    mockGetOidcEnv.mockImplementation(() =>
      mockIsOidcConfigured() ? { issuer: 'https://idp.test', clientId: 'x', enabled: true } : null,
    )
  })

  it('keeps OIDC in methods when another disabled method coexists', async () => {
    // OIDC 启用、SAML 停用（getSamlEnv 有配置但 isSamlConfigured=false）→ 仅列 OIDC
    mockIsOidcConfigured.mockReturnValue(true)
    mockIsSamlConfigured.mockReturnValue(false)
    mockGetSamlEnv.mockReturnValue({
      entryPoint: 'https://idp.test/sso',
      idpCert: 'x',
      enabled: false,
    })
    mockLoadAuthSettings.mockReturnValue({
      oauthEnabled: true,
      allowedEmailDomains: [],
      defaultRole: 'user',
      oauthAutoProvision: true,
      passwordLoginEnabled: true,
    })
    const res = await app.request('/api/auth/oauth/config')
    const body = (await res.json()) as {
      data: { enabled: boolean; methods: Array<{ type: string }> }
    }
    expect(body.data.enabled).toBe(true)
    expect(body.data.methods).toEqual([{ type: 'oidc', loginUrl: '/api/auth/oidc/login' }])
    mockGetSamlEnv.mockImplementation(() =>
      mockIsSamlConfigured()
        ? { entryPoint: 'https://idp.test/sso', idpCert: 'x', enabled: true }
        : null,
    )
  })
})

describe('POST /auth/login (passwordLoginEnabled gate)', () => {
  let app: Hono

  beforeEach(async () => {
    vi.clearAllMocks()
    mockLoadAuthSettings.mockReset()
    const mod = await import('../auth.js')
    app = new Hono()
    app.route('/api/auth', mod.default)
  })

  it('returns 403 PASSWORD_LOGIN_DISABLED when policy is off', async () => {
    mockLoadAuthSettings.mockReturnValue({
      oauthEnabled: true,
      allowedEmailDomains: [],
      defaultRole: 'user',
      oauthAutoProvision: true,
      passwordLoginEnabled: false,
    })
    const res = await app.request('/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'admin', password: 'pwd' }),
    })
    expect(res.status).toBe(403)
    expect(((await res.json()) as { error: string }).error).toBe('PASSWORD_LOGIN_DISABLED')
    expect(logAudit).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ action: 'auth.password.login_disabled_attempted' }),
    )
  })
})
