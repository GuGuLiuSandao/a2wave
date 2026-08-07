import { StreamLogItem } from '@/components/stream-log-item'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Pagination } from '@/components/ui/pagination'
import type { StreamLogEntry } from '@/hooks/use-agents'
import { Download, Loader2 } from 'lucide-react'
import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useSearchParams } from 'react-router-dom'

const PAGE_SIZE = 500

type FilterKey = 'all' | 'tools' | 'messages' | 'problems'

type FullLogPage = {
  entries: StreamLogEntry[]
  meta: {
    page: number
    pageSize: number
    totalEntries: number
    totalPages: number
    stats: {
      total: number
      tools: number
      messages: number
      errors: number
    }
  }
}

export function FullLogViewer({
  runId,
  open,
  onOpenChange,
}: {
  runId: string
  open: boolean
  onOpenChange: (open: boolean) => void
}) {
  const { t } = useTranslation()
  const [searchParams, setSearchParams] = useSearchParams()
  const [logPage, setLogPage] = useState<FullLogPage | null>(null)
  const [loadError, setLoadError] = useState(false)
  const [filter, setFilter] = useState<FilterKey>('all')
  const requestedPage = searchParams.get('logPage')
    ? Math.max(1, Number.parseInt(searchParams.get('logPage') ?? '1') || 1)
    : 'last'

  const setRequestedPage = (nextPage: number | 'last') => {
    const next = new URLSearchParams(searchParams)
    if (nextPage === 'last') {
      next.delete('logPage')
    } else {
      next.set('logPage', String(nextPage))
    }
    setSearchParams(next)
  }

  const handleOpenChange = (nextOpen: boolean) => {
    if (!nextOpen) {
      const next = new URLSearchParams(searchParams)
      next.delete('logPage')
      setSearchParams(next, { replace: true })
    }
    onOpenChange(nextOpen)
  }

  useEffect(() => {
    if (open) return
    setLogPage(null)
    setLoadError(false)
    setFilter('all')
  }, [open])

  useEffect(() => {
    if (!open) return
    const controller = new AbortController()
    setLogPage(null)
    setLoadError(false)

    const params = new URLSearchParams({
      page: String(requestedPage),
      limit: String(PAGE_SIZE),
      filter,
    })

    fetch(`/api/runs/${runId}/logs?${params}`, {
      credentials: 'include',
      signal: controller.signal,
    })
      .then((res) => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`)
        return res.json()
      })
      .then((json: { data: StreamLogEntry[]; meta: FullLogPage['meta'] }) => {
        setLogPage({ entries: json.data, meta: json.meta })
      })
      .catch((err) => {
        if ((err as { name?: string }).name !== 'AbortError') setLoadError(true)
      })

    return () => controller.abort()
  }, [open, runId, filter, requestedPage])

  const stats = logPage?.meta.stats ?? null
  const page = logPage?.meta.page ?? 1
  const totalPages = logPage?.meta.totalPages ?? 1
  const pageEntries = logPage?.entries ?? []
  const baseTs = pageEntries[0]?.ts

  const filters: Array<{ key: FilterKey; label: string }> = [
    { key: 'all', label: t('runLog.filterAll') },
    { key: 'tools', label: t('runLog.filterTools') },
    { key: 'messages', label: t('runLog.filterMessages') },
    { key: 'problems', label: t('runLog.filterProblems') },
  ]

  return (
    <Dialog open={open} onOpenChange={handleOpenChange} width={760}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t('runLog.fullLog')}</DialogTitle>
          {stats && (
            <p className="text-xs text-muted-foreground">
              {t('runLog.fullLogSummary', {
                total: stats.total,
                tools: stats.tools,
                messages: stats.messages,
                errors: stats.errors,
              })}
            </p>
          )}
        </DialogHeader>

        <div className="mt-3 space-y-2">
          <div className="flex items-center justify-between gap-2">
            <div className="flex items-center gap-1">
              {filters.map((f) => (
                <button
                  key={f.key}
                  type="button"
                  onClick={() => {
                    setFilter(f.key)
                    setRequestedPage('last')
                  }}
                  className={`text-2xs px-2 py-0.5 rounded-full border transition-colors ${
                    filter === f.key
                      ? 'border-primary/40 bg-primary/10 text-interactive-foreground'
                      : 'border-border text-muted-foreground hover:text-foreground'
                  }`}
                >
                  {f.label}
                </button>
              ))}
            </div>
            <a
              href={`/api/runs/${runId}/logs/download`}
              download={`${runId}.ndjson`}
              className="inline-flex items-center gap-1 text-2xs text-muted-foreground hover:text-foreground transition-colors shrink-0"
            >
              <Download className="h-3 w-3" />
              {t('runLog.downloadFullLog')}
            </a>
          </div>

          {loadError ? (
            <div className="py-10 text-center text-sm text-muted-foreground">
              {t('runLog.fullLogLoadError')}
            </div>
          ) : !logPage ? (
            <div className="flex items-center justify-center py-10">
              <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
            </div>
          ) : pageEntries.length === 0 ? (
            <div className="py-10 text-center text-sm text-muted-foreground">
              {t('runLog.fullLogEmpty')}
            </div>
          ) : (
            <div className="bg-muted/30 rounded p-2 overflow-auto h-[60vh] space-y-1.5">
              {pageEntries.map((entry, i) => (
                <StreamLogItem key={`${entry.ts}-${i}`} entry={entry} baseTs={baseTs} />
              ))}
            </div>
          )}

          {logPage && (
            <Pagination
              className="mt-2"
              pagination={{
                total: logPage.meta.totalEntries,
                page,
                pageSize: logPage.meta.pageSize,
                totalPages,
              }}
              onPageChange={setRequestedPage}
              totalLabel={t('runLog.pageInfo', { page, total: totalPages })}
              previousLabel={t('runLog.prevPage')}
              nextLabel={t('runLog.nextPage')}
            />
          )}
        </div>
      </DialogContent>
    </Dialog>
  )
}
