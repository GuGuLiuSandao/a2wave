import { useTranslation } from 'react-i18next'

const syncStatusColors = {
  synced: 'bg-emerald-500',
  syncing: 'bg-amber-500 animate-pulse',
  error: 'bg-red-500',
  idle: 'bg-gray-400',
} as const

const syncStatusLabelKeys = {
  synced: 'kbDocuments.synced',
  syncing: 'kbDocuments.syncing',
  error: 'kbDocuments.error',
  idle: 'kbDocuments.idle',
} as const

export function SyncStatusBadge({ syncStatus }: { syncStatus: string }) {
  const { t } = useTranslation()
  const status = (
    syncStatus in syncStatusColors ? syncStatus : 'idle'
  ) as keyof typeof syncStatusColors
  return (
    <span className="inline-flex items-center gap-1.5 text-xs text-muted-foreground">
      <span className={`size-2 rounded-full ${syncStatusColors[status]}`} />
      {t(syncStatusLabelKeys[status])}
    </span>
  )
}
