import { MarkdownContent } from '@/components/markdown-content'
import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'
import { useQuery } from '@tanstack/react-query'
import { ArrowLeft } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { Link } from 'react-router-dom'

export function ChangelogPage() {
  const { t } = useTranslation()
  const { data: changelog, isLoading } = useQuery<{ content: string }>({
    queryKey: ['changelog'],
    queryFn: () => fetch('/api/changelog').then((r) => r.json()),
    staleTime: 0,
  })

  return (
    <div className="space-y-6">
      <div className="flex items-start gap-3">
        <Button
          variant="ghost"
          size="icon"
          className="mt-0.5 size-8 shrink-0 text-muted-foreground hover:text-foreground"
          title={t('common.back')}
          aria-label={t('common.back')}
          asChild
        >
          <Link to="/wiki">
            <ArrowLeft className="h-3.5 w-3.5" aria-hidden="true" />
          </Link>
        </Button>
        <div>
          <h2 className="text-2xl font-semibold tracking-tight text-foreground">
            {t('common.changelogTitle')}
          </h2>
          <p className="text-sm text-muted-foreground mt-1.5">{t('common.changelogDesc')}</p>
        </div>
      </div>
      <div className="rounded-lg border border-border bg-card">
        <div className="p-6">
          {isLoading ? (
            <div className="space-y-2">
              <Skeleton className="h-5 w-24" />
              <Skeleton className="h-3 w-full" />
              <Skeleton className="h-3 w-full" />
              <Skeleton className="h-3 w-[80%]" />
              <Skeleton className="h-5 w-24 mt-4" />
              <Skeleton className="h-3 w-full" />
              <Skeleton className="h-3 w-[60%]" />
            </div>
          ) : (
            <MarkdownContent content={changelog?.content ?? ''} />
          )}
        </div>
      </div>
    </div>
  )
}
