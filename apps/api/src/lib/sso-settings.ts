/**
 * SSO 登录方式的 DB 配置读取（settings 表 `sso` 分类）。
 *
 * 配置真源：DB > env 兜底 —— 本模块只负责 DB 侧解析（JSON + zod 校验，坏值按
 * 未配置处理并告警，不让脏数据把登录整个打挂）；env 兜底逻辑在各自的解析函数
 * （lib/oidc.ts / lib/saml-config.ts）里，DB 有效时整体优先。
 */
import { SSO_CONFIG_SCHEMAS, type SsoConfigKey } from '@a2wave/shared'
import type { z } from 'zod'
import { logger } from './logger.js'
import { decryptSecret } from './secret-box.js'
import { getCategorySettings } from './settings.js'

type SsoConfigOf<K extends SsoConfigKey> = z.infer<(typeof SSO_CONFIG_SCHEMAS)[K]>

/** 读取并校验一个 sso JSON 配置键；空串/坏 JSON/校验失败 → null（回落 env）。 */
export async function readSsoDbConfig<K extends SsoConfigKey>(
  key: K,
): Promise<SsoConfigOf<K> | null> {
  const raw = (getCategorySettings('sso')[key] ?? '').trim()
  if (!raw) return null

  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    logger.warn({ key }, 'settings.sso config is not valid JSON — falling back to env')
    return null
  }
  const result = SSO_CONFIG_SCHEMAS[key].safeParse(parsed)
  if (!result.success) {
    logger.warn(
      { key, issues: result.error.issues.map((i) => i.path.join('.')) },
      'settings.sso config failed schema validation — falling back to env',
    )
    return null
  }
  return result.data as SsoConfigOf<K>
}

/**
 * 解密 OIDC client_secret（sso.oidcClientSecretEnc，AUTH_SECRET 派生密钥 AES-GCM）。
 * 未设置返回 undefined；解密失败（AUTH_SECRET 更换等）告警并按未设置处理 ——
 * 公共客户端（PKCE）不依赖 secret，机密客户端会在 token 端点收到明确的 401。
 */
export async function readOidcClientSecret(): Promise<string | undefined> {
  const enc = (getCategorySettings('sso').oidcClientSecretEnc ?? '').trim()
  if (!enc) return undefined
  try {
    return decryptSecret(enc)
  } catch (err) {
    logger.error(
      { err: (err as Error).message },
      'failed to decrypt sso.oidcClientSecretEnc (AUTH_SECRET changed?) — treating as unset',
    )
    return undefined
  }
}
