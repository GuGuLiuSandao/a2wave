import { useOauthConfig } from '@/hooks/use-auth'
import { Loader2, ShieldX } from 'lucide-react'
import { useEffect, useRef } from 'react'
import { useTranslation } from 'react-i18next'
import { useSearchParams } from 'react-router-dom'
import { resolveSsoMethods, startSsoMethod } from './login'

/** returnTo 必须是站内分享路径（/s/ 开头），挡掉 open-redirect / 协议相对地址。 */
export function isSafeSharePath(p: string | null): p is string {
  return !!p && p.startsWith('/s/') && !p.startsWith('/s//')
}

/**
 * 分享页「需要登录」按钮的落点（API 渲染的分享页是 sandbox、不能跑 JS，无法直接拉起
 * SSO，故必须先跳到这个 SPA 路由）。本页在挂载时立即以 purpose='share' 发起 SSO，
 * 把分享路径作为 returnTo 带走；登录成功后跳回该分享页（只验证身份、不建/不碰 a2wave 账号）。
 *
 * oidc/saml 走服务端回调的 share 分支；有多种方式时取第一个（分享自动拉起，不做交互选择）。
 */
export function ShareLoginPage() {
  const { t } = useTranslation()
  const [params] = useSearchParams()
  const { data: oauthConfig, isLoading } = useOauthConfig()
  const returnTo = params.get('returnTo')
  const launched = useRef(false)

  const safeReturnTo = isSafeSharePath(returnTo) ? returnTo : null
  const methods = resolveSsoMethods(oauthConfig)
  const method = methods[0] ?? null

  useEffect(() => {
    if (launched.current) return
    if (isLoading) return
    if (!safeReturnTo) return
    if (!method) return
    launched.current = true
    startSsoMethod(method, 'share', safeReturnTo)
  }, [isLoading, method, safeReturnTo])

  const error = !safeReturnTo
    ? t('shareLogin.badReturn')
    : !isLoading && !method
      ? t('shareLogin.ssoDisabled')
      : null

  return (
    <div className="flex min-h-dvh items-center justify-center bg-background">
      <div className="rounded-xl border border-border bg-card p-8 shadow-sm w-full max-w-[420px] text-center">
        {error ? (
          <>
            <ShieldX className="mx-auto h-8 w-8 text-destructive" />
            <h2 className="mt-4 text-lg font-semibold text-foreground">
              {t('shareLogin.failedTitle')}
            </h2>
            <p className="mt-2 text-sm text-muted-foreground whitespace-pre-line">{error}</p>
          </>
        ) : (
          <>
            <Loader2 className="mx-auto h-8 w-8 animate-spin text-interactive-foreground" />
            <h2 className="mt-4 text-lg font-semibold text-foreground">
              {t('shareLogin.redirectingTitle')}
            </h2>
            <p className="mt-2 text-sm text-muted-foreground">{t('shareLogin.redirectingDesc')}</p>
          </>
        )}
      </div>
    </div>
  )
}
