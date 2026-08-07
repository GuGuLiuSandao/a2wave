import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import type { PaginationMeta } from '@a2wave/shared'
import { ChevronLeft, ChevronRight } from 'lucide-react'
import { useTranslation } from 'react-i18next'

interface PaginationProps {
  pagination: PaginationMeta
  onPageChange: (page: number) => void
  totalLabel: string
  previousLabel: string
  nextLabel: string
  className?: string
}

type PageItem = number | 'ellipsis-start' | 'ellipsis-end'

function getPageItems(page: number, totalPages: number): PageItem[] {
  if (totalPages <= 7) {
    return Array.from({ length: totalPages }, (_, index) => index + 1)
  }

  if (page <= 4) {
    return [1, 2, 3, 4, 5, 'ellipsis-end', totalPages]
  }

  if (page >= totalPages - 3) {
    return [
      1,
      'ellipsis-start',
      totalPages - 4,
      totalPages - 3,
      totalPages - 2,
      totalPages - 1,
      totalPages,
    ]
  }

  return [1, 'ellipsis-start', page - 1, page, page + 1, 'ellipsis-end', totalPages]
}

export function Pagination({
  pagination,
  onPageChange,
  totalLabel,
  previousLabel,
  nextLabel,
  className,
}: PaginationProps) {
  const { t } = useTranslation()

  if (pagination.totalPages <= 1) return null

  const page = pagination.page
  const totalPages = pagination.totalPages
  const pageItems = getPageItems(page, totalPages)

  return (
    <nav
      aria-label={t('common.pagination')}
      className={cn(
        'flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between',
        className,
      )}
    >
      <p className="text-sm text-muted-foreground">{totalLabel}</p>
      <div className="flex items-center gap-2">
        <Button
          type="button"
          variant="outline"
          size="icon"
          className="size-8"
          disabled={page <= 1}
          onClick={() => onPageChange(page - 1)}
          aria-label={previousLabel}
          title={previousLabel}
        >
          <ChevronLeft className="h-4 w-4" />
        </Button>
        <div className="flex items-center gap-1" aria-label={`${page} / ${totalPages}`}>
          {pageItems.map((item) =>
            typeof item === 'number' ? (
              <Button
                key={item}
                type="button"
                variant={item === page ? 'default' : 'ghost'}
                size="icon"
                className="size-8 tabular-nums"
                onClick={() => onPageChange(item)}
                aria-label={t('common.pageLabel', { page: item })}
                aria-current={item === page ? 'page' : undefined}
              >
                {item}
              </Button>
            ) : (
              <span
                key={item}
                className="flex size-8 items-center justify-center text-sm text-muted-foreground"
                aria-hidden="true"
              >
                ...
              </span>
            ),
          )}
        </div>
        <Button
          type="button"
          variant="outline"
          size="icon"
          className="size-8"
          disabled={page >= totalPages}
          onClick={() => onPageChange(page + 1)}
          aria-label={nextLabel}
          title={nextLabel}
        >
          <ChevronRight className="h-4 w-4" />
        </Button>
      </div>
    </nav>
  )
}
