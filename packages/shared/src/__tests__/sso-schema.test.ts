import { describe, expect, it } from 'vitest'
import {
  normalizeSsoCallbackOrigin,
  ssoOidcConfigSchema,
  ssoSamlConfigSchema,
} from '../schemas/sso.js'

const oidcBase = { issuer: 'https://idp.example.com', clientId: 'a2wave' }
const samlBase = { entryPoint: 'https://idp.example.com/sso', idpCert: 'CERTBODY' }

describe('callbackOrigin in the SSO config schemas', () => {
  it('defaults to an empty string, meaning "fall back to publicBaseUrl"', () => {
    expect(ssoOidcConfigSchema.parse(oidcBase).callbackOrigin).toBe('')
    expect(ssoSamlConfigSchema.parse(samlBase).callbackOrigin).toBe('')
  })

  it('accepts a bare origin with an IP and a port', () => {
    const parsed = ssoOidcConfigSchema.parse({
      ...oidcBase,
      callbackOrigin: 'http://10.0.0.8:3502',
    })
    expect(parsed.callbackOrigin).toBe('http://10.0.0.8:3502')
  })

  it('strips a trailing slash so `${origin}/path` never doubles the separator', () => {
    const parsed = ssoOidcConfigSchema.parse({
      ...oidcBase,
      callbackOrigin: 'https://sso.corp.example.com/',
    })
    expect(parsed.callbackOrigin).toBe('https://sso.corp.example.com')
  })

  it.each([
    ['a path', 'https://host/auth/callback'],
    ['a query string', 'https://host?tenant=x'],
    ['a fragment', 'https://host#frag'],
    ['credentials', 'https://user:pw@host'],
    ['a non-http scheme', 'ftp://host'],
    ['a bare hostname', 'a2wave.example.com'],
  ])('rejects %s', (_label, callbackOrigin) => {
    expect(ssoSamlConfigSchema.safeParse({ ...samlBase, callbackOrigin }).success).toBe(false)
  })

  it.each([
    // 曾经用正则实现时，这些值能通过落库校验、界面显示已生效，运行时却被 URL 解析
    // 拒绝而静默回落 publicBaseUrl —— 管理员以为配好了，IdP 收到的却是别的地址。
    ['an out-of-range port', 'https://host:99999'],
    ['a backslash host separator', 'http://host\\evil.com'],
    ['a percent-encoded slash in the host', 'https://host%2f'],
  ])('rejects %s at save time rather than ignoring it at run time', (_label, callbackOrigin) => {
    expect(normalizeSsoCallbackOrigin(callbackOrigin)).toBeNull()
    expect(ssoOidcConfigSchema.safeParse({ ...oidcBase, callbackOrigin }).success).toBe(false)
  })

  it('stores exactly what the runtime will use (schema output === normalizer output)', () => {
    // 落库值与运行时取值必须逐字符相同，否则 IdP 的严格比对会失配。
    for (const raw of [
      'HTTP://Host:8080',
      'https://a2wave.example.com/',
      'http://127.0.0.1:3502',
    ]) {
      const parsed = ssoOidcConfigSchema.parse({ ...oidcBase, callbackOrigin: raw })
      expect(parsed.callbackOrigin).toBe(normalizeSsoCallbackOrigin(raw))
    }
  })

  it('keeps existing configs valid when the field is absent (backward compatible)', () => {
    // 存量库里的 JSON 没有 callbackOrigin —— 读取解析必须照常通过，否则升级即全员登录失效。
    expect(ssoOidcConfigSchema.safeParse(oidcBase).success).toBe(true)
    expect(ssoSamlConfigSchema.safeParse(samlBase).success).toBe(true)
  })
})
