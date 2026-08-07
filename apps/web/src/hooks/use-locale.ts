import { useEffect } from 'react'
import { useTranslation } from 'react-i18next'
import { useCurrentUser } from './use-auth'

/** Sync i18n language with user's locale preference */
export function useLocale() {
  const { i18n } = useTranslation()
  const { data: user } = useCurrentUser()

  useEffect(() => {
    const locale = user?.locale
    if (locale && (locale === 'zh' || locale === 'en') && i18n.language !== locale) {
      i18n.changeLanguage(locale)
    }
  }, [user?.locale, i18n])
}
