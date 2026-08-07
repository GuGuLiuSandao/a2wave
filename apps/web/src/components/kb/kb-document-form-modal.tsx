import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { EntityFormGate } from '@/components/ui/entity-form-gate'
import { useKbDocument } from '@/hooks/use-kb-documents'
import { useTranslation } from 'react-i18next'
import { KbDocumentForm } from './kb-document-form'

interface Props {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** undefined = create mode; a value = edit mode */
  documentId?: string
}

/** Modal shell hosting the Knowledge Base document create/edit form. */
export function KbDocumentFormModal({ open, onOpenChange, documentId }: Props) {
  const { t } = useTranslation()
  // Only fetch while open — otherwise the closed modal keeps its last documentId
  // and this query (which polls remote docs every 3-30s) runs in the background,
  // even against a doc the user just deleted. An empty id disables the query.
  const { data: doc, isPending, error } = useKbDocument(open ? (documentId ?? '') : '')
  const title = documentId ? (doc?.name ?? t('kbDocuments.create')) : t('kbDocuments.create')

  return (
    <Dialog open={open} onOpenChange={onOpenChange} width={720} scrollBody>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
        </DialogHeader>
        {/* The form owns its own layout: the save bar stays pinned while only the
            body scrolls. We just bound the height here (70vh). */}
        <div className="mt-4 max-h-[70vh]">
          {/* In edit mode the form must not mount until the document has loaded —
              a blank form is submittable and would overwrite the real record. */}
          <EntityFormGate
            isEditMode={!!documentId}
            isOpen={open}
            isLoading={isPending}
            error={error}
            entity={doc}
          >
            {/* Remount the form per target so create/edit state never leaks between opens */}
            <KbDocumentForm
              key={documentId ?? 'new'}
              documentId={documentId}
              onSaved={() => onOpenChange(false)}
              onDeleted={() => onOpenChange(false)}
            />
          </EntityFormGate>
        </div>
      </DialogContent>
    </Dialog>
  )
}
