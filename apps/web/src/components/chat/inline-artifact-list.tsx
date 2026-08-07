/** Lightweight artifact list inside a conversation: filename + download only. */
import { getArtifactDownloadUrl, useArtifacts } from '@/hooks/use-artifacts'
import { Download, FileText } from 'lucide-react'
import { useTranslation } from 'react-i18next'

export function InlineArtifactList({ runId }: { runId: string }) {
  const { t } = useTranslation()
  const { data: artifacts } = useArtifacts(runId)
  if (!artifacts || artifacts.length === 0) return null

  return (
    <div className="flex justify-start pl-8 animate-chat-message-in">
      <div className="rounded-2xl border border-border bg-card px-3.5 py-2.5 space-y-1">
        <p className="text-xs text-muted-foreground mb-1.5">{t('artifacts.title')}</p>
        {artifacts.map((artifact) => (
          <div key={artifact.id} className="flex items-center gap-2">
            <FileText className="h-3.5 w-3.5 text-muted-foreground shrink-0" aria-hidden="true" />
            <span className="text-sm font-mono truncate max-w-[200px]">{artifact.filename}</span>
            <a
              href={getArtifactDownloadUrl(artifact.id)}
              download={artifact.filename}
              aria-label={t('artifacts.download')}
              className="shrink-0 inline-flex items-center justify-center size-6 rounded-md text-muted-foreground hover:text-foreground hover:bg-surface-hover transition-colors"
            >
              <Download className="h-3.5 w-3.5" />
            </a>
          </div>
        ))}
      </div>
    </div>
  )
}
