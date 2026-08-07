import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { EntityFormGate } from '@/components/ui/entity-form-gate'
import { useScmSource } from '@/hooks/use-scm-sources'
import { useTranslation } from 'react-i18next'
import { ScmSourceForm } from './scm-source-form'

interface Props {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** undefined = create mode; a value = edit mode */
  sourceId?: string
}

/** Modal shell hosting the SCM Source create/edit form. */
export function ScmSourceFormModal({ open, onOpenChange, sourceId }: Props) {
  const { t } = useTranslation()
  // Only fetch while open — a closed modal keeps its last sourceId and this
  // query polls sync status (every 3-30s), so gate it on `open` (empty id
  // disables the query).
  const { data: source, isPending, error } = useScmSource(open ? (sourceId ?? '') : '')
  const title = sourceId
    ? (source?.name ?? t('scmSources.createSource'))
    : t('scmSources.createSource')

  return (
    <Dialog open={open} onOpenChange={onOpenChange} width={820} scrollBody>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
        </DialogHeader>
        {/* The form owns its own layout: the tab bar and save bar stay pinned
            while only the active tab's content scrolls. We just bound the height
            here (70vh). */}
        <div className="mt-4 max-h-[70vh]">
          {/* In edit mode the form must not mount until the source has loaded — a
              blank form is submittable and would reset checkout path, credentials
              and sync settings to their defaults. */}
          <EntityFormGate
            isEditMode={!!sourceId}
            isOpen={open}
            isLoading={isPending}
            error={error}
            entity={source}
          >
            {/* Remount the form per target so create/edit state never leaks between opens */}
            <ScmSourceForm
              key={sourceId ?? 'new'}
              sourceId={sourceId}
              onSaved={() => onOpenChange(false)}
              onDeleted={() => onOpenChange(false)}
            />
          </EntityFormGate>
        </div>
      </DialogContent>
    </Dialog>
  )
}
