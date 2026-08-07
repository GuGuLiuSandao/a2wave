import { Hono } from 'hono'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { asyncQuery } from '../../test/async-query.js'

// ─── Mocks（须在 import 路由模块前 hoist）──────────────────────────────
const settingsStore: Record<string, Record<string, string>> = {}

vi.mock('../../db/client.js', () => ({
  db: {
    select: () => ({
      from: () =>
        asyncQuery({
          where: () => asyncQuery({ get: () => undefined, all: () => [] }),
          all: () => [],
        }),
    }),
    insert: () => ({
      values: (row: { category: string; key: string; value: string }) =>
        asyncQuery({
          run: () => {
            settingsStore[row.category] ??= {}
            settingsStore[row.category][row.key] = row.value
          },
        }),
    }),
    update: () => ({
      set: () => asyncQuery({ where: () => asyncQuery({ run: () => {} }) }),
    }),
    transaction: (fn: () => unknown) => fn(),
  },
  // `db/transaction.js` reads these at module load to pick a backend, and its
  // SQLite branch drives BEGIN/COMMIT on the raw handle. Without a stand-in
  // handle every transactional route throws before its own mocks are consulted.
  dialect: 'sqlite',
  isPostgres: false,
  sqliteDatabase: { inTransaction: false, exec: vi.fn() },
}))

vi.mock('../../db/schema.js', () => ({
  settings: { category: 'category', key: 'key' },
}))

vi.mock('../../lib/audit.js', () => ({ logAudit: vi.fn() }))
vi.mock('../../lib/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}))
vi.mock('../../middleware/auth-middleware.js', () => ({
  requireAdmin: vi.fn((_c: unknown, next: () => Promise<void>) => next()),
  isAdmin: () => true,
}))
vi.mock('../../lib/auth-settings.js', () => ({
  resetAuthSettingsCache: vi.fn(),
  loadAuthSettings: vi.fn(),
  isEmailDomainAllowed: vi.fn(),
}))
vi.mock('../../lib/webhook-notifier.js', () => ({ sendWebhookTest: vi.fn() }))
vi.mock('../../lib/server-url.js', () => ({
  getServerUrl: () => 'https://a2wave.test',
  getSsoCallbackOrigin: () => 'https://a2wave.test',
  isSsoCallbackOriginUsable: () => true,
  clearDetectedServerUrl: vi.fn(),
  isLocalhostOrLoopback: () => false,
  // 这些用例不测按方式覆盖回调 origin：一律视作未填，走 publicBaseUrl 回落。
  normalizeCallbackOriginOverride: () => null,
}))

const mockEncrypt = vi.fn((plain: string) => `enc(${plain})`)
vi.mock('../../lib/secret-box.js', () => ({
  encryptSecret: (plain: string) => mockEncrypt(plain),
}))

vi.mock('../../lib/settings.js', () => ({
  getSettingsVersions: () => ({}),
  isNonAdminReadableSetting: () => true,
  getAllSettings: () => ({ ...settingsStore }),
  getCategorySettings: (category: string) => ({ ...(settingsStore[category] ?? {}) }),
  redactSettingsForViewer: (map: unknown) => map,
  redactCategoryForViewer: (_c: string, entries: unknown) => entries,
  // The write path refreshes the settings cache so a change applies without a
  // restart; stubbed here because the db mock has no real query chain.
  refreshSettingsCache: vi.fn().mockResolvedValue(undefined),
}))

const mockGetOidcEnv = vi.fn<() => unknown>(() => null)
const mockProbeOidcDiscovery = vi.fn()
vi.mock('../../lib/oidc.js', () => ({
  getOidcEnv: () => mockGetOidcEnv(),
  isOidcConfigured: () => mockGetOidcEnv() !== null,
  isOauthChannelConfigured: () => mockGetOidcEnv() !== null,
  oauthChannelAudiences: () => [],
  invalidateOidcEnvCache: () => mockInvalidateOidcEnvCache(),
  probeOidcDiscovery: (...args: unknown[]) => mockProbeOidcDiscovery(...args),
}))

const mockInvalidateOidcEnvCache = vi.fn()
const mockGetSamlEnv = vi.fn<() => unknown>(() => null)
vi.mock('../../lib/saml-config.js', () => ({
  getSamlEnv: () => mockGetSamlEnv(),
  isSamlConfigured: () => mockGetSamlEnv() !== null,
}))

const mockGenerateMetadata = vi.fn(() => '<EntityDescriptor/>')
vi.mock('../../lib/saml.js', () => ({
  getSaml: () => ({ generateServiceProviderMetadata: mockGenerateMetadata }),
}))

const VALID_OIDC_CONFIG = JSON.stringify({
  issuer: 'https://idp.example.com',
  clientId: 'a2wave',
  scopes: '',
})

describe('settings SSO endpoints', () => {
  let app: Hono

  beforeEach(async () => {
    vi.clearAllMocks()
    for (const k of Object.keys(settingsStore)) delete settingsStore[k]
    mockGetOidcEnv.mockReturnValue(null)
    mockGetSamlEnv.mockReturnValue(null)
    const mod = await import('../settings.js')
    app = new Hono()
    app.route('/api/settings', mod.default)
  })

  describe('PATCH / — sso 配置写入', () => {
    it('encrypts sso.oidcClientSecret and never stores the plaintext key', async () => {
      const res = await app.request('/api/settings', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sso: { oidcClientSecret: 's3cret' } }),
      })
      expect(res.status).toBe(200)
      expect(mockEncrypt).toHaveBeenCalledWith('s3cret')
      expect(settingsStore.sso?.oidcClientSecretEnc).toBe('enc(s3cret)')
      expect(settingsStore.sso?.oidcClientSecret).toBeUndefined()
    })

    it('clears the encrypted secret when an empty secret is submitted', async () => {
      await app.request('/api/settings', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sso: { oidcClientSecret: '' } }),
      })
      expect(settingsStore.sso?.oidcClientSecretEnc).toBe('')
      expect(mockEncrypt).not.toHaveBeenCalled()
    })

    it('normalizes and stores a valid sso config JSON', async () => {
      const res = await app.request('/api/settings', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sso: { oidcConfig: VALID_OIDC_CONFIG } }),
      })
      expect(res.status).toBe(200)
      const stored = JSON.parse(settingsStore.sso?.oidcConfig ?? '{}')
      // schema 的 `.default(...)` 归一后把 enabled 与 callbackOrigin 一并写入存储 JSON；
      // callbackOrigin 为空串 = 未覆盖，回落 artifacts.publicBaseUrl。
      expect(stored).toEqual({
        enabled: true,
        issuer: 'https://idp.example.com',
        clientId: 'a2wave',
        scopes: '',
        channelAudiences: [],
        callbackOrigin: '',
      })
      // getOidcEnv 有 1s TTL 记忆化：保存后不显式失效，管理员立刻点「测试连接」
      // 可能仍读到旧配置。
      expect(mockInvalidateOidcEnvCache).toHaveBeenCalled()
    })

    it('rejects a sso config that is not valid JSON', async () => {
      const res = await app.request('/api/settings', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sso: { samlConfig: '{broken' } }),
      })
      expect(res.status).toBe(400)
      expect(((await res.json()) as { error: string }).error).toBe('INVALID_SSO_CONFIG')
      expect(settingsStore.sso?.samlConfig).toBeUndefined()
    })

    it('rejects a sso config that fails schema validation', async () => {
      const res = await app.request('/api/settings', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sso: { oidcConfig: JSON.stringify({ issuer: 'not-a-url' }) } }),
      })
      expect(res.status).toBe(400)
      expect(((await res.json()) as { error: string }).error).toBe('INVALID_SSO_CONFIG')
    })

    it('allows clearing a config with an empty string (fall back to env)', async () => {
      const res = await app.request('/api/settings', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sso: { oidcConfig: '' } }),
      })
      expect(res.status).toBe(200)
      expect(settingsStore.sso?.oidcConfig).toBe('')
    })

    it('accepts lockdown when only OIDC is configured (no static strategy)', async () => {
      mockGetOidcEnv.mockReturnValue({ issuer: 'https://idp.example.com', clientId: 'x' })
      settingsStore.auth = { oauthEnabled: 'true' }
      const res = await app.request('/api/settings', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ auth: { passwordLoginEnabled: 'false' } }),
      })
      expect(res.status).toBe(200)
    })

    it('still refuses lockdown when no SSO method is physically available', async () => {
      settingsStore.auth = { oauthEnabled: 'true' }
      const res = await app.request('/api/settings', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ auth: { passwordLoginEnabled: 'false' } }),
      })
      expect(res.status).toBe(400)
      expect(((await res.json()) as { error: string }).error).toBe('AUTH_LOCKDOWN_REFUSED')
    })
  })

  describe('GET /sso/status', () => {
    it('reports unconfigured methods with registration URLs', async () => {
      const res = await app.request('/api/settings/sso/status')
      expect(res.status).toBe(200)
      const body = (await res.json()) as {
        data: {
          oidc: Record<string, unknown>
          saml: Record<string, unknown>
        }
      }
      expect(body.data.oidc).toMatchObject({
        configured: false,
        redirectUri: 'https://a2wave.test/api/auth/oidc/callback',
      })
      expect(body.data.saml).toMatchObject({
        configured: false,
        acsUrl: 'https://a2wave.test/api/auth/saml/acs',
        metadataUrl: 'https://a2wave.test/api/auth/saml/metadata',
      })
    })

    it('reports effective config with source and secret presence, without key material', async () => {
      mockGetOidcEnv.mockReturnValue({
        issuer: 'https://idp.example.com',
        clientId: 'a2wave',
        clientSecret: 'SECRET_N',
        scopes: 'openid',
        source: 'settings',
      })
      mockGetSamlEnv.mockReturnValue({
        entryPoint: 'https://idp.example.com/sso',
        idpCert: 'CERT_BODY',
        source: 'env',
      })

      const res = await app.request('/api/settings/sso/status')
      const raw = await res.text()
      const body = JSON.parse(raw) as { data: Record<string, Record<string, unknown>> }

      expect(body.data.oidc).toMatchObject({
        configured: true,
        source: 'settings',
        clientSecretSet: true,
      })
      expect(body.data.saml).toMatchObject({
        configured: true,
        source: 'env',
        certPresent: true,
        spEntityId: 'https://a2wave.test/api/auth/saml/metadata',
      })
      // 敏感材料零泄漏
      expect(raw).not.toContain('SECRET_N')
      expect(raw).not.toContain('CERT_BODY')
      expect(raw).not.toContain('shh')
    })

    it('reports configured=true but enabled=false for a disabled method', async () => {
      // 配置物理存在但被停用（enabled=false）：设置页据此展示「已停用」徽标
      mockGetOidcEnv.mockReturnValue({
        issuer: 'https://idp.example.com',
        clientId: 'a2wave',
        scopes: 'openid',
        source: 'settings',
        enabled: false,
      })
      mockGetSamlEnv.mockReturnValue({
        entryPoint: 'https://idp.example.com/sso',
        idpCert: 'CERT',
        source: 'settings',
        enabled: false,
      })
      const res = await app.request('/api/settings/sso/status')
      const body = (await res.json()) as { data: Record<string, Record<string, unknown>> }
      expect(body.data.oidc).toMatchObject({ configured: true, enabled: false })
      expect(body.data.saml).toMatchObject({ configured: true, enabled: false })
    })
  })

  describe('POST /sso/test', () => {
    it('probes OIDC discovery and returns endpoints', async () => {
      mockGetOidcEnv.mockReturnValue({ issuer: 'https://idp.example.com', clientId: 'a2wave' })
      mockProbeOidcDiscovery.mockResolvedValue({
        serverMetadata: () => ({
          issuer: 'https://idp.example.com',
          authorization_endpoint: 'https://idp.example.com/auth',
          token_endpoint: 'https://idp.example.com/token',
          jwks_uri: 'https://idp.example.com/jwks',
        }),
      })
      const res = await app.request('/api/settings/sso/test', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ type: 'oidc' }),
      })
      const body = (await res.json()) as { data: { ok: boolean; detail: { jwksUri: string } } }
      expect(body.data.ok).toBe(true)
      expect(body.data.detail.jwksUri).toBe('https://idp.example.com/jwks')
    })

    it('flags an unregistered redirect_uri via the authorize-endpoint probe', async () => {
      mockGetOidcEnv.mockReturnValue({ issuer: 'https://idp.example.com', clientId: 'a2wave' })
      mockProbeOidcDiscovery.mockResolvedValue({
        serverMetadata: () => ({
          issuer: 'https://idp.example.com',
          authorization_endpoint: 'https://idp.example.com/auth',
          token_endpoint: 'https://idp.example.com/token',
          jwks_uri: 'https://idp.example.com/jwks',
        }),
      })
      // 部分 IdP 形态：redirect_uri 未注册时 authorize 端点直接 400 JSON
      const fetchSpy = vi
        .fn()
        .mockResolvedValue(
          new Response(
            JSON.stringify({ error: 'invalid_grant', error_description: 'redirect_uri is error' }),
            { status: 400 },
          ),
        )
      vi.stubGlobal('fetch', fetchSpy)
      try {
        const res = await app.request('/api/settings/sso/test', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ type: 'oidc' }),
        })
        const body = (await res.json()) as {
          data: {
            ok: boolean
            reason?: string
            reasonContext?: Record<string, unknown>
            detail: Record<string, unknown>
          }
        }
        expect(body.data.ok).toBe(false)
        expect(body.data.reason).toBe('REDIRECT_URI_REJECTED')
        // 文案交给前端 i18n；服务端回结构化上下文，需带上 IdP 应登记的确切地址
        expect(body.data.reasonContext?.redirectUri).toBe(
          'https://a2wave.test/api/auth/oidc/callback',
        )
        expect(body.data.detail.redirectUri).toBe('https://a2wave.test/api/auth/oidc/callback')
        // 探测请求打到 authorize 端点并携带 redirect_uri
        const probeUrl = new URL(fetchSpy.mock.calls[0][0] as URL | string)
        expect(probeUrl.origin + probeUrl.pathname).toBe('https://idp.example.com/auth')
        expect(probeUrl.searchParams.get('redirect_uri')).toBe(
          'https://a2wave.test/api/auth/oidc/callback',
        )
      } finally {
        vi.unstubAllGlobals()
      }
    })

    it('passes the probe (and echoes redirectUri) when the IdP accepts the request', async () => {
      mockGetOidcEnv.mockReturnValue({ issuer: 'https://idp.example.com', clientId: 'a2wave' })
      mockProbeOidcDiscovery.mockResolvedValue({
        serverMetadata: () => ({
          issuer: 'https://idp.example.com',
          authorization_endpoint: 'https://idp.example.com/auth',
          token_endpoint: 'https://idp.example.com/token',
          jwks_uri: 'https://idp.example.com/jwks',
        }),
      })
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(null, { status: 302 })))
      try {
        const res = await app.request('/api/settings/sso/test', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ type: 'oidc' }),
        })
        const body = (await res.json()) as {
          data: { ok: boolean; detail: Record<string, unknown> }
        }
        expect(body.data.ok).toBe(true)
        expect(body.data.detail.redirectUri).toBe('https://a2wave.test/api/auth/oidc/callback')
      } finally {
        vi.unstubAllGlobals()
      }
    })

    it('keeps ok=true when the authorize probe itself is unreachable', async () => {
      mockGetOidcEnv.mockReturnValue({ issuer: 'https://idp.example.com', clientId: 'a2wave' })
      mockProbeOidcDiscovery.mockResolvedValue({
        serverMetadata: () => ({
          issuer: 'https://idp.example.com',
          authorization_endpoint: 'https://idp.example.com/auth',
          jwks_uri: 'https://idp.example.com/jwks',
        }),
      })
      vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('network down')))
      try {
        const res = await app.request('/api/settings/sso/test', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ type: 'oidc' }),
        })
        const body = (await res.json()) as { data: { ok: boolean } }
        // discovery 已通过；探测网络失败不应误报为配置错误
        expect(body.data.ok).toBe(true)
      } finally {
        vi.unstubAllGlobals()
      }
    })

    it('returns ok=false with the error message when discovery fails', async () => {
      mockGetOidcEnv.mockReturnValue({ issuer: 'https://idp.example.com', clientId: 'a2wave' })
      mockProbeOidcDiscovery.mockRejectedValue(new Error('discovery unreachable'))
      const res = await app.request('/api/settings/sso/test', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ type: 'oidc' }),
      })
      const body = (await res.json()) as { data: { ok: boolean; error: string } }
      expect(res.status).toBe(200)
      expect(body.data).toMatchObject({ ok: false, error: 'discovery unreachable' })
    })

    it('validates SAML config by generating SP metadata', async () => {
      mockGetSamlEnv.mockReturnValue({
        entryPoint: 'https://idp.example.com/sso',
        idpCert: 'x',
        source: 'settings',
      })
      const res = await app.request('/api/settings/sso/test', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ type: 'saml' }),
      })
      const body = (await res.json()) as { data: { ok: boolean; detail: Record<string, unknown> } }
      expect(body.data.ok).toBe(true)
      expect(mockGenerateMetadata).toHaveBeenCalled()
      // 回显 IdP 侧需要登记的地址，便于用户照抄注册
      expect(body.data.detail).toMatchObject({
        acsUrl: 'https://a2wave.test/api/auth/saml/acs',
        spEntityId: 'https://a2wave.test/api/auth/saml/metadata',
        metadataUrl: 'https://a2wave.test/api/auth/saml/metadata',
      })
    })

    it('reports unconfigured methods as ok=false', async () => {
      const res = await app.request('/api/settings/sso/test', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ type: 'oidc' }),
      })
      const body = (await res.json()) as { data: { ok: boolean; error: string } }
      expect(body.data.ok).toBe(false)
    })

    it('rejects unknown test types', async () => {
      const res = await app.request('/api/settings/sso/test', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ type: 'ldap' }),
      })
      expect(res.status).toBe(400)
    })
  })
})
