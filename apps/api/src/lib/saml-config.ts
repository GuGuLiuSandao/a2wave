/**
 * SAML 2.0 SP 配置解析（轻量入口，供 /auth/oauth/config 与 SAML 路由共用）。
 *
 * 配置真源：DB（settings.sso.samlConfig，设置页可编辑）> env 兜底：
 *   A2WAVE_SAML_IDP_ENTRY_POINT  IdP 的 SSO 入口（HTTP-Redirect binding 地址）
 *   A2WAVE_SAML_IDP_CERT         IdP 签名证书（PEM，或去掉头尾行的 base64 体）
 *   A2WAVE_SAML_SP_ENTITY_ID     可选；SP entityId，默认 {serverUrl}/api/auth/saml/metadata
 *
 * 完整 SP 实现见 lib/saml.ts 与 routes/auth-saml.ts。
 */
import type { SsoConfigSource } from '@a2wave/shared'
import { readSsoDbConfig } from './sso-settings.js'

export interface SamlEnvConfig {
  entryPoint: string
  idpCert: string
  spEntityId?: string
  /** 回调 origin 覆盖（设置页填写）；空 = 回落 publicBaseUrl。env 兜底不支持覆盖。 */
  callbackOrigin: string
  /** 配置生效来源：settings（DB，设置页可编辑）或 env（部署环境变量兜底）。 */
  source: SsoConfigSource
  /** 是否启用（DB 配置可停用；env 兜底恒为 true）。生效判断由调用方结合此值。 */
  enabled: boolean
}

/**
 * SAML 配置解析：DB > env 兜底。返回配置**不代表已启用**——enabled=false 时
 * 配置仍返回（供设置页展示），是否生效由调用方查 enabled；便捷判断用 (await isSamlConfigured())。
 */
export async function getSamlEnv(): Promise<SamlEnvConfig | null> {
  const db = await readSsoDbConfig('samlConfig')
  if (db) {
    const spEntityId = db.spEntityId.trim()
    return {
      entryPoint: db.entryPoint,
      idpCert: db.idpCert,
      ...(spEntityId ? { spEntityId } : {}),
      callbackOrigin: db.callbackOrigin,
      source: 'settings',
      enabled: db.enabled,
    }
  }

  const entryPoint = (process.env.A2WAVE_SAML_IDP_ENTRY_POINT ?? '').trim()
  const idpCert = (process.env.A2WAVE_SAML_IDP_CERT ?? '').trim()
  if (!entryPoint || !idpCert) return null
  const spEntityId = (process.env.A2WAVE_SAML_SP_ENTITY_ID ?? '').trim()
  return {
    entryPoint,
    idpCert,
    ...(spEntityId ? { spEntityId } : {}),
    callbackOrigin: '',
    source: 'env',
    enabled: true,
  }
}

/** SAML 是否**生效**（配置齐全且已启用）——登录端点/验签的 gate。 */
export async function isSamlConfigured(): Promise<boolean> {
  return (await getSamlEnv())?.enabled === true
}
