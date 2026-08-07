/**
 * SSO「实际可登录方式」单一真相判定。
 *
 * 门禁（PATCH /settings 防自锁）、GET /auth/oauth/config（登录页展示哪些方式）、
 * GET /settings/sso/status 都必须用同一套判定，否则会出现「展示为可用但实际登录失败」
 * 或「门禁放行了会导致全员锁死的配置」的裂缝。
 *
 * 关键差异（相对「配置是否存在」）：
 *   - OIDC / SAML 由服务端生成回调地址（redirect_uri / ACS），生产环境必须有可用的
 *     公开回调 origin（await getSsoCallbackOrigin() !== null）才真正能登录；未配 publicBaseUrl
 *     时即便 oidcConfig/samlConfig 齐全，登录也会因 SSO_PUBLIC_URL_NOT_SET 失败。
 */

export interface SsoAvailabilityInputs {
  /** 服务端能否生成稳定的公开回调 origin（await getSsoCallbackOrigin() !== null）。 */
  callbackOriginAvailable: boolean
  /**
   * OIDC / SAML 各自计入本方式 callbackOrigin 覆盖后的回调 origin 可用性。
   * 省略时回落 callbackOriginAvailable —— 保持「只有全局 publicBaseUrl」时的旧语义。
   */
  oidcCallbackOriginAvailable?: boolean
  samlCallbackOriginAvailable?: boolean
  /** OIDC 配置是否齐全（enabled + issuer/clientId 等）。 */
  oidcConfigured: boolean
  /** SAML 配置是否齐全（enabled + entryPoint/cert 等）。 */
  samlConfigured: boolean
}

export interface SsoAvailability {
  /** OIDC 是否可作为登录入口（含回调 origin 可用性）。 */
  oidc: boolean
  /** SAML 是否可作为登录入口（含回调 origin 可用性）。 */
  saml: boolean
  /** 是否至少有一种方式可登录。 */
  anyActive: boolean
}

/** 由各输入位计算「实际可登录方式」——OIDC/SAML 均需回调 origin 可用。 */
export function computeSsoAvailability(inputs: SsoAvailabilityInputs): SsoAvailability {
  const oidc =
    inputs.oidcConfigured && (inputs.oidcCallbackOriginAvailable ?? inputs.callbackOriginAvailable)
  const saml =
    inputs.samlConfigured && (inputs.samlCallbackOriginAvailable ?? inputs.callbackOriginAvailable)
  return { oidc, saml, anyActive: oidc || saml }
}
