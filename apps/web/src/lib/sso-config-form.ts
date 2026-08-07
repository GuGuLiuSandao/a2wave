/**
 * SSO 登录方式配置的表单值 ⇄ 后端 JSON 字符串互转（纯函数，供 SsoMethodsCard 复用）。
 *
 * 后端契约：settings.sso.{oidcConfig,samlConfig} 存 JSON 字符串，
 * 空串 = 清除配置（回落 env）。schema 见 packages/shared/src/schemas/sso.ts。
 * client_secret 走独立的 oidcClientSecret 明文键（服务端加密），不在这里处理。
 *
 * 回调 origin 的校验直接用 shared 的 normalizeSsoCallbackOrigin —— 与后端 schema
 * 同一份实现，避免「前端放行、后端拒绝」或反之的裂缝。
 */
import { normalizeSsoCallbackOrigin } from '@a2wave/shared'

export type BuildResult<T> = { ok: true; value: T } | { ok: false; error: string }

// ─────────────────────────────────────────────────────────────
// 标准 OIDC（授权码 + PKCE）
// ─────────────────────────────────────────────────────────────
export interface OidcFormValues {
  issuer: string
  clientId: string
  scopes: string
  /** OAuth 发布渠道接受的 aud，逗号分隔（表单里是一个输入框，落库是数组）。 */
  channelAudiences: string
  callbackOrigin: string
}

export const EMPTY_OIDC_FORM: OidcFormValues = {
  issuer: '',
  clientId: '',
  scopes: '',
  channelAudiences: '',
  callbackOrigin: '',
}

export function parseOidcConfig(json: string | undefined): OidcFormValues {
  if (!json?.trim()) return { ...EMPTY_OIDC_FORM }
  try {
    const o = JSON.parse(json) as Record<string, unknown>
    return {
      issuer: typeof o.issuer === 'string' ? o.issuer : '',
      clientId: typeof o.clientId === 'string' ? o.clientId : '',
      scopes: typeof o.scopes === 'string' ? o.scopes : '',
      channelAudiences: Array.isArray(o.channelAudiences)
        ? o.channelAudiences.filter((a): a is string => typeof a === 'string').join(', ')
        : '',
      callbackOrigin: typeof o.callbackOrigin === 'string' ? o.callbackOrigin : '',
    }
  } catch {
    return { ...EMPTY_OIDC_FORM }
  }
}

export function buildOidcConfig(v: OidcFormValues, enabled = true): BuildResult<string> {
  if (!v.issuer.trim()) return { ok: false, error: 'issuerRequired' }
  if (!isHttpUrl(v.issuer.trim())) return { ok: false, error: 'issuerNotUrl' }
  if (!v.clientId.trim()) return { ok: false, error: 'clientIdRequired' }
  const callbackOrigin = normalizeSsoCallbackOrigin(v.callbackOrigin)
  if (callbackOrigin === null) return { ok: false, error: 'callbackOriginInvalid' }
  return {
    ok: true,
    value: JSON.stringify({
      enabled,
      issuer: v.issuer.trim(),
      clientId: v.clientId.trim(),
      scopes: v.scopes.trim(),
      channelAudiences: v.channelAudiences
        .split(',')
        .map((a) => a.trim())
        .filter(Boolean),
      callbackOrigin,
    }),
  }
}

// ─────────────────────────────────────────────────────────────
// SAML 2.0
// ─────────────────────────────────────────────────────────────
export interface SamlFormValues {
  entryPoint: string
  idpCert: string
  spEntityId: string
  callbackOrigin: string
}

export const EMPTY_SAML_FORM: SamlFormValues = {
  entryPoint: '',
  idpCert: '',
  spEntityId: '',
  callbackOrigin: '',
}

export function parseSamlConfig(json: string | undefined): SamlFormValues {
  if (!json?.trim()) return { ...EMPTY_SAML_FORM }
  try {
    const o = JSON.parse(json) as Record<string, unknown>
    return {
      entryPoint: typeof o.entryPoint === 'string' ? o.entryPoint : '',
      idpCert: typeof o.idpCert === 'string' ? o.idpCert : '',
      spEntityId: typeof o.spEntityId === 'string' ? o.spEntityId : '',
      callbackOrigin: typeof o.callbackOrigin === 'string' ? o.callbackOrigin : '',
    }
  } catch {
    return { ...EMPTY_SAML_FORM }
  }
}

export function buildSamlConfig(v: SamlFormValues, enabled = true): BuildResult<string> {
  if (!v.entryPoint.trim()) return { ok: false, error: 'entryPointRequired' }
  if (!isHttpUrl(v.entryPoint.trim())) return { ok: false, error: 'entryPointNotUrl' }
  if (!v.idpCert.trim()) return { ok: false, error: 'certRequired' }
  const callbackOrigin = normalizeSsoCallbackOrigin(v.callbackOrigin)
  if (callbackOrigin === null) return { ok: false, error: 'callbackOriginInvalid' }
  return {
    ok: true,
    value: JSON.stringify({
      enabled,
      entryPoint: v.entryPoint.trim(),
      idpCert: v.idpCert.trim(),
      spEntityId: v.spEntityId.trim(),
      callbackOrigin,
    }),
  }
}

function isHttpUrl(s: string): boolean {
  try {
    const u = new URL(s)
    return u.protocol === 'http:' || u.protocol === 'https:'
  } catch {
    return false
  }
}
