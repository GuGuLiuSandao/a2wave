/**
 * Fills the gaps that settings.test.ts doesn't reach: POST /webhook/test
 * and the auth-lockdown safety gate in PATCH /.
 */
import { Hono } from 'hono'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const dbSelect = vi.fn()
const dbUpdate = vi.fn()
const dbInsert = vi.fn()
vi.mock('../../db/client.js', () => {
  const db = {
    select: (...a: unknown[]) => dbSelect(...a),
    update: (...a: unknown[]) => dbUpdate(...a),
    insert: (...a: unknown[]) => dbInsert(...a),
    // Hands the callback a transaction handle, as the real driver does — the
    // route issues its statements on `tx`, not on the outer `db`.
    transaction: (fn: (tx: unknown) => unknown) => fn(db),
  }
  return { db }
})

vi.mock('../../db/schema.js', () => ({
  settings: { category: 'settings.category', key: 'settings.key' },
}))

vi.mock('../../lib/audit-actions.js', () => ({
  AUDIT_ACTIONS: {
    SETTINGS_UPDATE: 'settings.update',
    SETTINGS_AUTH_UPDATED: 'settings.auth.updated',
  },
}))

vi.mock('../../lib/audit.js', () => ({ logAudit: vi.fn() }))

const resetAuthSettingsCacheMock = vi.fn()
vi.mock('../../lib/auth-settings.js', () => ({
  resetAuthSettingsCache: () => resetAuthSettingsCacheMock(),
}))

const isLocalhostMock = vi.fn((_u?: unknown) => false)
const clearDetectedServerUrlMock = vi.fn()
const isSsoCallbackOriginUsableMock = vi.fn((_u?: unknown) => true)
vi.mock('../../lib/server-url.js', () => ({
  clearDetectedServerUrl: () => clearDetectedServerUrlMock(),
  isLocalhostOrLoopback: (u: string) => isLocalhostMock(u),
  isSsoCallbackOriginUsable: (u: string | null | undefined) => isSsoCallbackOriginUsableMock(u),
  getServerUrl: () => 'https://a2wave.test',
  getSsoCallbackOrigin: () => 'https://a2wave.test',
  // 这些用例不测按方式覆盖回调 origin：一律视作未填，走 publicBaseUrl 回落。
  normalizeCallbackOriginOverride: () => null,
}))

const isOidcConfiguredMock = vi.fn(() => false)
const oauthChannelAudiencesMock = vi.fn<() => string[]>(() => [])
const getOidcEnvMock = vi.fn<() => unknown>(() => null)
const isSamlConfiguredMock = vi.fn(() => false)
vi.mock('../../lib/oidc.js', () => ({
  isOidcConfigured: () => isOidcConfiguredMock(),
  getOidcEnv: () => getOidcEnvMock(),
  // /oauth-env/status reports the **channel**, which is independent of the login toggle.
  oauthChannelAudiences: () => oauthChannelAudiencesMock(),
  invalidateOidcEnvCache: vi.fn(),
  isOauthChannelConfigured: () => !!getOidcEnvMock() && oauthChannelAudiencesMock().length > 0,
  probeOidcDiscovery: vi.fn(),
}))
vi.mock('../../lib/saml-config.js', () => ({
  isSamlConfigured: () => isSamlConfiguredMock(),
  getSamlEnv: vi.fn(() => null),
}))

const getAllSettingsMock = vi.fn().mockReturnValue({})
const getCategorySettingsMock = vi.fn()
vi.mock('../../lib/settings.js', () => ({
  getSettingsVersions: () => ({}),
  isNonAdminReadableSetting: () => true,
  getAllSettings: () => getAllSettingsMock(),
  getCategorySettings: (cat: string) => getCategorySettingsMock(cat),
  // The write path refreshes the settings cache so a change applies without a
  // restart; stubbed here because the db mock has no real query chain.
  refreshSettingsCache: vi.fn().mockResolvedValue(undefined),
}))

const { assertSafePublicUrlMock, FakeUnsafeUrlError } = vi.hoisted(() => {
  class FakeUnsafeUrlError extends Error {
    reason: string
    constructor(reason: string, msg: string) {
      super(msg)
      this.reason = reason
    }
  }
  return { assertSafePublicUrlMock: vi.fn(), FakeUnsafeUrlError }
})
vi.mock('../../lib/url-safety.js', () => ({
  UnsafeUrlError: FakeUnsafeUrlError,
  assertSafePublicUrl: (u: string) => assertSafePublicUrlMock(u),
}))

const sendWebhookTestMock = vi.fn()
vi.mock('../../lib/webhook-notifier.js', () => ({
  sendWebhookTest: (url: string, t: string) => sendWebhookTestMock(url, t),
}))

vi.mock('../../middleware/auth-middleware.js', () => ({
  requireAdmin: async (_c: unknown, next: () => Promise<void>) => {
    await next()
  },
}))

const updateSettingsInputMock = vi.hoisted(() => ({
  SSO_CONFIG_SCHEMAS: {
    oidcConfig: { safeParse: (data: unknown) => ({ success: true, data }) },
    samlConfig: { safeParse: (data: unknown) => ({ success: true, data }) },
  },
  updateSettingsInput: {
    safeParse: (body: unknown) => ({ success: true, data: body as Record<string, unknown> }),
  },
}))
vi.mock('@a2wave/shared', () => updateSettingsInputMock)

import settingsApp from '../settings.js'

import { asyncQuery } from '../../test/async-query.js'

type ErrorBody = {
  error?: string
  reason?: string
}

beforeEach(() => {
  dbSelect.mockReset()
  dbUpdate.mockReset().mockImplementation(() => ({
    set: () => ({ where: () => asyncQuery({ run: vi.fn() }) }),
  }))
  dbInsert.mockReset().mockImplementation(() => ({
    values: () => asyncQuery({ run: vi.fn() }),
  }))
  resetAuthSettingsCacheMock.mockReset()
  isLocalhostMock.mockReset().mockReturnValue(false)
  clearDetectedServerUrlMock.mockReset()
  getAllSettingsMock.mockReset().mockReturnValue({})
  getCategorySettingsMock.mockReset()
  assertSafePublicUrlMock.mockReset()
  sendWebhookTestMock.mockReset()
  isOidcConfiguredMock.mockReset().mockReturnValue(false)
  getOidcEnvMock.mockReset().mockReturnValue(null)
  oauthChannelAudiencesMock.mockReset().mockReturnValue([])
  isSamlConfiguredMock.mockReset().mockReturnValue(false)
  isSsoCallbackOriginUsableMock.mockReset().mockReturnValue(true)
})

afterEach(() => {
  vi.restoreAllMocks()
})

function buildApp() {
  return new Hono().route('/settings', settingsApp)
}

describe('POST /settings/webhook/test', () => {
  function post(body: unknown) {
    return buildApp().request('/settings/webhook/test', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    })
  }

  it('returns 400 when url is missing', async () => {
    const res = await post({})
    expect(res.status).toBe(400)
    expect(((await res.json()) as ErrorBody).error).toBe('url is required')
  })

  it('returns 400 when assertSafePublicUrl throws UnsafeUrlError', async () => {
    assertSafePublicUrlMock.mockImplementation(() => {
      throw new FakeUnsafeUrlError('PRIVATE_HOST', 'private host blocked')
    })
    const res = await post({ url: 'http://internal.local/x' })
    expect(res.status).toBe(400)
    const body = (await res.json()) as ErrorBody
    expect(body).toMatchObject({ error: 'WEBHOOK_URL_BLOCKED', reason: 'PRIVATE_HOST' })
  })

  it('returns 500 when a non-UnsafeUrl error propagates', async () => {
    assertSafePublicUrlMock.mockImplementation(() => {
      throw new Error('boom')
    })
    const res = await post({ url: 'https://ok.example/x' })
    expect(res.status).toBe(500)
  })

  it('defaults webhookType to feishu and forwards to sendWebhookTest', async () => {
    sendWebhookTestMock.mockResolvedValue({ ok: true })
    const res = await post({ url: 'https://ok.example/x' })
    expect(res.status).toBe(200)
    expect(sendWebhookTestMock).toHaveBeenCalledWith('https://ok.example/x', 'feishu')
  })

  it('respects type="custom" override', async () => {
    sendWebhookTestMock.mockResolvedValue({ ok: true })
    await post({ url: 'https://ok.example/x', type: 'custom' })
    expect(sendWebhookTestMock).toHaveBeenCalledWith('https://ok.example/x', 'custom')
  })
})

describe('GET /settings/oauth-env/status', () => {
  it('reports the OAuth channel as ready when enterprise OIDC is configured', async () => {
    isOidcConfiguredMock.mockReturnValue(true)
    oauthChannelAudiencesMock.mockReturnValue(['a2wave'])
    getOidcEnvMock.mockReturnValue({
      issuer: 'https://idp.example.com/',
      clientId: 'a2wave',
      clientSecret: 'never-leaks',
      source: 'settings',
    })

    const res = await buildApp().request('/settings/oauth-env/status')
    expect(res.status).toBe(200)
    const raw = await res.text()
    expect(JSON.parse(raw).data).toMatchObject({
      configured: true,
      issuer: 'https://idp.example.com/',
      source: 'settings',
      missing: [],
    })
    // 该端点对任意登录用户开放，绝不能回任何凭据材料
    expect(raw).not.toContain('never-leaks')
  })

  /**
   * `configured` and `missing` must come from the same source. Deriving one from "enabled"
   * and the other from "present" made a configured-but-disabled method report
   * {configured:false, missing:[]}, which the publish tab renders as "config unusable" —
   * pointing the admin at the wrong problem.
   */
  it('reports the channel as unavailable, not broken, when the audience list is empty', async () => {
    getOidcEnvMock.mockReturnValue({ issuer: 'https://idp.example.com/', clientId: 'a2wave' })
    oauthChannelAudiencesMock.mockReturnValue([])

    const res = await buildApp().request('/settings/oauth-env/status')
    const body = (await res.json()) as { data: { configured: boolean; missing: string[] } }
    expect(body.data.configured).toBe(false)
    expect(body.data.missing).toEqual(['A2WAVE_OIDC_CHANNEL_AUDIENCES'])
  })

  it('reports the missing OIDC env vars when nothing is configured', async () => {
    const res = await buildApp().request('/settings/oauth-env/status')
    const body = (await res.json()) as { data: { configured: boolean; missing: string[] } }
    expect(body.data.configured).toBe(false)
    expect(body.data.missing).toContain('A2WAVE_OIDC_ISSUER')
  })
})

describe('PATCH /settings — auth lockdown safety gate', () => {
  function patch(body: unknown) {
    return buildApp().request('/settings', {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    })
  }

  beforeEach(() => {
    dbSelect.mockImplementation(() => ({
      from: () => ({ where: () => asyncQuery({ get: () => undefined }) }),
    }))
  })

  it('refuses disabling password login when OAuth is not enabled', async () => {
    getCategorySettingsMock.mockReturnValue({ oauthEnabled: 'false', passwordLoginEnabled: 'true' })
    const res = await patch({ auth: { passwordLoginEnabled: 'false' } })
    expect(res.status).toBe(400)
    expect(((await res.json()) as ErrorBody).error).toBe('AUTH_LOCKDOWN_REFUSED')
  })

  it('refuses disabling password login when OAuth is physically unavailable', async () => {
    getCategorySettingsMock.mockReturnValue({ oauthEnabled: 'true', passwordLoginEnabled: 'true' })
    const res = await patch({ auth: { passwordLoginEnabled: 'false' } })
    expect(res.status).toBe(400)
    expect(((await res.json()) as ErrorBody).error).toBe('AUTH_LOCKDOWN_REFUSED')
  })

  it('allows disabling password login when OIDC login is active', async () => {
    getCategorySettingsMock.mockReturnValue({ oauthEnabled: 'true', passwordLoginEnabled: 'true' })
    isOidcConfiguredMock.mockReturnValue(true)
    const res = await patch({ auth: { passwordLoginEnabled: 'false' } })
    expect(res.status).toBe(200)
    expect(resetAuthSettingsCacheMock).toHaveBeenCalled()
  })

  it('refuses lockdown when the same patch disables the only active SSO method', async () => {
    getCategorySettingsMock.mockReturnValue({ oauthEnabled: 'true', passwordLoginEnabled: 'true' })
    isOidcConfiguredMock.mockReturnValue(true)

    const res = await patch({
      auth: { passwordLoginEnabled: 'false' },
      sso: {
        oidcConfig: JSON.stringify({
          enabled: false,
          issuer: 'https://idp.example.com',
          clientId: 'a2wave',
        }),
      },
    })

    expect(res.status).toBe(400)
    expect(((await res.json()) as ErrorBody).error).toBe('AUTH_LOCKDOWN_REFUSED')
  })

  it('refuses SSO-only patch that disables the last SSO method while password login is already off', async () => {
    // 设置页 SSO 开关只发 { sso: ... }，不带 auth 段。密码登录早已关闭时，关掉仅剩的
    // SSO 方式必须仍触发防锁死闸——否则全员被锁在登录页外。
    getCategorySettingsMock.mockReturnValue({ oauthEnabled: 'true', passwordLoginEnabled: 'false' })
    isOidcConfiguredMock.mockReturnValue(true)
    isSamlConfiguredMock.mockReturnValue(false)

    const res = await patch({
      sso: {
        oidcConfig: JSON.stringify({
          enabled: false,
          issuer: 'https://idp.example.com',
          clientId: 'a2wave',
        }),
      },
    })

    expect(res.status).toBe(400)
    expect(((await res.json()) as ErrorBody).error).toBe('AUTH_LOCKDOWN_REFUSED')
  })

  it('allows SSO-only patch that keeps at least one SSO method active while password login is off', async () => {
    getCategorySettingsMock.mockReturnValue({ oauthEnabled: 'true', passwordLoginEnabled: 'false' })
    isOidcConfiguredMock.mockReturnValue(true)
    isSamlConfiguredMock.mockReturnValue(false)

    const res = await patch({
      sso: {
        oidcConfig: JSON.stringify({
          enabled: true,
          issuer: 'https://idp.example.com',
          clientId: 'a2wave',
        }),
      },
    })

    expect(res.status).toBe(200)
  })

  it('refuses disabling password login when only OIDC exists but the callback origin is unavailable', async () => {
    // OIDC 配齐但 publicBaseUrl 未配（回调 origin 不可用）→ OIDC 实际登录必失败，
    // 门禁不得放行关闭密码登录。
    getCategorySettingsMock.mockImplementation((cat: string) =>
      cat === 'artifacts'
        ? { publicBaseUrl: '' }
        : { oauthEnabled: 'true', passwordLoginEnabled: 'true' },
    )
    isOidcConfiguredMock.mockReturnValue(true)
    isSamlConfiguredMock.mockReturnValue(false)
    isSsoCallbackOriginUsableMock.mockReturnValue(false) // publicBaseUrl 空 + 生产

    const res = await patch({ auth: { passwordLoginEnabled: 'false' } })
    expect(res.status).toBe(400)
    expect(((await res.json()) as ErrorBody).error).toBe('AUTH_LOCKDOWN_REFUSED')
  })

  it('allows disabling password login when OIDC exists AND the callback origin is available', async () => {
    getCategorySettingsMock.mockImplementation((cat: string) =>
      cat === 'artifacts'
        ? { publicBaseUrl: 'https://a2wave.example.com' }
        : { oauthEnabled: 'true', passwordLoginEnabled: 'true' },
    )
    isOidcConfiguredMock.mockReturnValue(true)
    isSamlConfiguredMock.mockReturnValue(false)
    isSsoCallbackOriginUsableMock.mockReturnValue(true)

    const res = await patch({ auth: { passwordLoginEnabled: 'false' } })
    expect(res.status).toBe(200)
  })

  it('refuses an artifacts-only patch that clears publicBaseUrl when OIDC is the last login path and password login is off', async () => {
    // 缺口：清空 publicBaseUrl 走 artifacts 段，密码登录已关时会让 OIDC 回调失效 → 全员锁死。
    // 门禁入口必须覆盖 artifacts.publicBaseUrl 变更。
    getCategorySettingsMock.mockImplementation((cat: string) =>
      cat === 'artifacts'
        ? { publicBaseUrl: 'https://a2wave.example.com' } // 现存值（合并前）
        : { oauthEnabled: 'true', passwordLoginEnabled: 'false' },
    )
    isOidcConfiguredMock.mockReturnValue(true)
    isSamlConfiguredMock.mockReturnValue(false)
    // 合并后 publicBaseUrl 为空（patch 清空）→ 回调 origin 不可用
    isSsoCallbackOriginUsableMock.mockImplementation((u: unknown) => !!u && u !== '')

    const res = await patch({ artifacts: { publicBaseUrl: '' } })
    expect(res.status).toBe(400)
    expect(((await res.json()) as ErrorBody).error).toBe('AUTH_LOCKDOWN_REFUSED')
  })
})
