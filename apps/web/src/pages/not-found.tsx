import { Button } from '@/components/ui/button'
import { useTranslation } from 'react-i18next'
import { Link } from 'react-router-dom'

export function NotFoundPage() {
  const { t } = useTranslation()

  return (
    <div className="flex min-h-[60vh] items-center justify-center p-4">
      <div className="space-y-4 text-center">
        <div className="text-6xl font-bold text-muted-foreground/20">404</div>
        <div className="space-y-2">
          <h1 className="text-xl font-semibold text-foreground">{t('notFound.title')}</h1>
          <p className="text-sm text-muted-foreground">{t('notFound.description')}</p>
        </div>
        <Button variant="outline" asChild>
          <Link to="/">{t('notFound.backHome')}</Link>
        </Button>
      </div>
    </div>
  )
}
