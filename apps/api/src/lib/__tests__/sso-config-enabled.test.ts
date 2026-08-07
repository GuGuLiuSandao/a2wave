import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * 停用语义：isOidcConfigured() / isSamlConfigured() 现在含义为「配置齐全**且已启用**」。
 * DB 配置带 enabled=false 时，即便字段齐全也应视为未生效（返回 false）。
 */

const mockReadSsoDbConfig = vi.fn<() => unknown>(() => null)
vi.mock('../sso-settings.js', () => ({
  readSsoDbConfig: (...args: unknown[]) => mockReadSsoDbConfig(...(args as [])),
  readOidcClientSecret: () => undefined,
}))

vi.mock('../logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}))

import { getOidcEnv, isOidcConfigured, resetOidcForTests } from '../oidc.js'
import { getSamlEnv, isSamlConfigured } from '../saml-config.js'

const OIDC_ENV_KEYS = ['A2WAVE_OIDC_ISSUER', 'A2WAVE_OIDC_CLIENT_ID', 'A2WAVE_OIDC_SCOPES'] as const
const SAML_ENV_KEYS = ['A2WAVE_SAML_IDP_ENTRY_POINT', 'A2WAVE_SAML_IDP_CERT'] as const
const ORIGINAL_ENV: Record<string, string | undefined> = {}

beforeEach(() => {
  for (const k of [...OIDC_ENV_KEYS, ...SAML_ENV_KEYS]) {
    ORIGINAL_ENV[k] = process.env[k]
    delete process.env[k]
  }
  mockReadSsoDbConfig.mockReturnValue(null)
  // getOidcEnv memoizes on the raw settings.sso rows; these tests swap the config through a
  // mock of readSsoDbConfig instead, so the key never changes and the cache must be cleared.
  resetOidcForTests()
})

afterEach(() => {
  for (const k of [...OIDC_ENV_KEYS, ...SAML_ENV_KEYS]) {
    if (ORIGINAL_ENV[k] === undefined) delete process.env[k]
    else process.env[k] = ORIGINAL_ENV[k]
  }
})

describe('isOidcConfigured (enabled gate)', () => {
  it('is true when the DB config is complete and enabled', async () => {
    mockReadSsoDbConfig.mockReturnValue({
      issuer: 'https://idp.example.com',
      clientId: 'a2wave',
      scopes: '',
      enabled: true,
    })
    expect(await isOidcConfigured()).toBe(true)
    expect((await getOidcEnv())?.enabled).toBe(true)
  })

  it('is false when the DB config is complete but disabled (enabled=false)', async () => {
    mockReadSsoDbConfig.mockReturnValue({
      issuer: 'https://idp.example.com',
      clientId: 'a2wave',
      scopes: '',
      enabled: false,
    })
    // 配置仍返回（供设置页展示），但不生效
    expect(await getOidcEnv()).not.toBeNull()
    expect((await getOidcEnv())?.enabled).toBe(false)
    expect(await isOidcConfigured()).toBe(false)
  })

  it('is false when nothing is configured (null)', async () => {
    expect(await getOidcEnv()).toBeNull()
    expect(await isOidcConfigured()).toBe(false)
  })
})

describe('getOidcEnv scopes 归一化（OIDC 规范要求 scope 必须含 openid）', () => {
  it('DB 配置的 scopes 缺 openid 时自动补上（管理员误填不应导致 IdP 拒绝）', async () => {
    mockReadSsoDbConfig.mockReturnValue({
      issuer: 'https://idp.example.com',
      clientId: 'a2wave',
      scopes: 'admin',
      enabled: true,
    })
    expect((await getOidcEnv())?.scopes).toBe('openid admin')
  })

  it('已含 openid 时原样保留', async () => {
    mockReadSsoDbConfig.mockReturnValue({
      issuer: 'https://idp.example.com',
      clientId: 'a2wave',
      scopes: 'openid profile email',
      enabled: true,
    })
    expect((await getOidcEnv())?.scopes).toBe('openid profile email')
  })

  it('空 scopes 回落默认 openid profile email', async () => {
    mockReadSsoDbConfig.mockReturnValue({
      issuer: 'https://idp.example.com',
      clientId: 'a2wave',
      scopes: '  ',
      enabled: true,
    })
    expect((await getOidcEnv())?.scopes).toBe('openid profile email')
  })

  it('env 兜底配置同样归一化', async () => {
    process.env.A2WAVE_OIDC_ISSUER = 'https://idp.example.com'
    process.env.A2WAVE_OIDC_CLIENT_ID = 'a2wave'
    process.env.A2WAVE_OIDC_SCOPES = 'profile email'
    expect((await getOidcEnv())?.scopes).toBe('openid profile email')
  })
})

describe('isSamlConfigured (enabled gate)', () => {
  it('is true when the DB config is complete and enabled', async () => {
    mockReadSsoDbConfig.mockReturnValue({
      entryPoint: 'https://idp.example.com/sso',
      idpCert: 'CERT',
      spEntityId: '',
      enabled: true,
    })
    expect(await isSamlConfigured()).toBe(true)
    expect((await getSamlEnv())?.enabled).toBe(true)
  })

  it('is false when the DB config is complete but disabled (enabled=false)', async () => {
    mockReadSsoDbConfig.mockReturnValue({
      entryPoint: 'https://idp.example.com/sso',
      idpCert: 'CERT',
      spEntityId: '',
      enabled: false,
    })
    expect(await getSamlEnv()).not.toBeNull()
    expect((await getSamlEnv())?.enabled).toBe(false)
    expect(await isSamlConfigured()).toBe(false)
  })

  it('is false when nothing is configured (null)', async () => {
    expect(await getSamlEnv()).toBeNull()
    expect(await isSamlConfigured()).toBe(false)
  })
})
