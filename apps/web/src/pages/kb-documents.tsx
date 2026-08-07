import { KbDocumentFormModal } from '@/components/kb/kb-document-form-modal'
import { SyncStatusBadge } from '@/components/sync-status-badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Skeleton } from '@/components/ui/skeleton'
import { useKbBatch } from '@/hooks/use-kb-batch'
import { useKbDocuments, useUploadKbDocument } from '@/hooks/use-kb-documents'
import { useUrlRecord } from '@/hooks/use-url-state'
import { message } from '@/lib/antd-static'
import type { KbDocument } from '@a2wave/shared'
import { BookOpen, FileUp, Loader2, Plus, RefreshCw } from 'lucide-react'
import { useRef } from 'react'
import { useTranslation } from 'react-i18next'

export function KbDocumentsPage() {
  const { t } = useTranslation()
  const { data: result, isLoading } = useKbDocuments()
  const docs = result?.data
  const uploadKb = useUploadKbDocument()
  const { running: uploading, run: runBatch, filesFromInput } = useKbBatch()
  const fileInputRef = useRef<HTMLInputElement>(null)
  // Create/edit modal (undefined documentId = create).
  // Modal state lives in the URL so an editor is linkable and survives a reload.
  const docModal = useUrlRecord('doc')
  const openDoc = (doc: KbDocument) => docModal.openEdit(doc.id)

  const handleUpload = async (files: File[]) => {
    const { succeeded, createdIds, firstError, abandoned } = await runBatch(
      'file',
      files.map((file) => file.name),
      async (_label, index) => {
        const res = await uploadKb.mutateAsync(files[index])
        return { name: res.data.name, id: res.data.id }
      },
    )
    if (abandoned) return

    const failed = files.length - succeeded
    if (failed > 0) {
      // Report the successes too: they are already created, and a bare failure count
      // reads as "nothing happened", inviting a re-pick that duplicates them.
      const summary = [
        t('kbDocuments.batchSucceeded', { count: succeeded }),
        t('kbDocuments.batchFailed', { count: failed }),
      ].join(' · ')
      message.error(`${summary}: ${firstError}`)
      return
    }
    // Opening the editor only makes sense for a single pick — that is the flow the
    // shortcut exists for (upload one file, then name/describe it right away). For a
    // batch there is no defensible "which one", and jumping into one hides the rest;
    // the refreshed list is the right confirmation surface.
    if (createdIds.length === 1) {
      docModal.openEdit(createdIds[0])
    } else {
      message.success(t('kbDocuments.batchUploaded', { count: succeeded }))
    }
  }

  const onFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = filesFromInput(e.target.files)
    if (files) handleUpload(files).catch((err) => console.error('Upload batch failed:', err))
    e.target.value = ''
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h2
            className="text-2xl font-semibold tracking-tight text-foreground"
            style={{ textWrap: 'balance' }}
          >
            {t('kbDocuments.title')}
          </h2>
          <p className="text-sm text-muted-foreground mt-1.5">
            {t('kbDocuments.emptyDescription')}
          </p>
        </div>
        <div className="flex gap-2">
          <input
            ref={fileInputRef}
            type="file"
            accept=".md,.txt"
            multiple
            className="hidden"
            onChange={onFileChange}
          />
          <Button
            variant="outline"
            onClick={() => fileInputRef.current?.click()}
            disabled={uploading}
          >
            {uploading ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <FileUp className="h-4 w-4" />
            )}
            {t('kbDocuments.upload')}
          </Button>
          <Button onClick={() => docModal.openCreate()}>
            <Plus className="h-4 w-4" />
            {t('kbDocuments.create')}
          </Button>
        </div>
      </div>

      {isLoading ? (
        <div className="grid gap-3 md:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
          {Array.from({ length: 4 }).map((_, i) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: skeleton placeholder, fixed count
            <Card key={i}>
              <CardHeader>
                <div className="flex items-center gap-3">
                  <Skeleton className="size-10 rounded-xl" />
                  <div className="space-y-2 flex-1">
                    <Skeleton className="h-4 w-24" />
                    <Skeleton className="h-3 w-16" />
                  </div>
                </div>
              </CardHeader>
              <CardContent>
                <Skeleton className="h-3 w-full mb-2" />
                <Skeleton className="h-3 w-2/3" />
              </CardContent>
            </Card>
          ))}
        </div>
      ) : docs?.length === 0 ? (
        <Card>
          <CardContent className="flex flex-col items-center justify-center py-20 px-8">
            <div className="flex size-14 items-center justify-center rounded-2xl bg-brand-gradient-subtle text-interactive-foreground mb-5">
              <BookOpen className="h-7 w-7" aria-hidden="true" />
            </div>
            <h3 className="font-semibold text-base mb-1 text-foreground">
              {t('kbDocuments.empty')}
            </h3>
            <p
              className="text-sm text-muted-foreground text-center max-w-xs"
              style={{ textWrap: 'pretty' }}
            >
              {t('kbDocuments.emptyDescription')}
            </p>
          </CardContent>
        </Card>
      ) : (
        <div className="grid gap-3 md:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
          {docs?.map((doc) => (
            <Card
              key={doc.id}
              // biome-ignore lint/a11y/useSemanticElements: <button> accepts phrasing content only,
              // while this card renders an <h3> title and paragraph blocks — invalid in a button.
              role="button"
              tabIndex={0}
              onClick={() => openDoc(doc)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' || e.key === ' ') {
                  e.preventDefault()
                  openDoc(doc)
                }
              }}
              className="h-full cursor-pointer hover:border-primary/15 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              <CardHeader className="pb-3">
                <div className="flex items-center gap-3 min-w-0">
                  <div className="flex size-10 items-center justify-center rounded-xl bg-muted text-foreground shrink-0">
                    {doc.sourceType === 'feishu' || doc.sourceType === 'notion' ? (
                      <RefreshCw className="h-5 w-5" />
                    ) : (
                      <BookOpen className="h-5 w-5" />
                    )}
                  </div>
                  <div className="min-w-0 flex-1">
                    <CardTitle className="text-base truncate font-semibold">{doc.name}</CardTitle>
                    <div className="flex items-center gap-2 mt-1">
                      <span className="text-xs text-muted-foreground">
                        {t(`kbDocuments.${doc.sourceType}`)}
                      </span>
                      <SyncStatusBadge syncStatus={doc.syncStatus} />
                    </div>
                  </div>
                </div>
              </CardHeader>
              <CardContent>
                {doc.description ? (
                  <p className="text-sm text-muted-foreground line-clamp-2 leading-relaxed">
                    {doc.description}
                  </p>
                ) : (
                  <p className="text-sm text-muted-foreground/50 italic">
                    {t('common.noDescription')}
                  </p>
                )}
              </CardContent>
            </Card>
          ))}
        </div>
      )}

      <KbDocumentFormModal
        open={docModal.open}
        onOpenChange={(open) => !open && docModal.close()}
        documentId={docModal.id}
      />
    </div>
  )
}
