import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Label } from '@/components/ui/label'
import type { SkillVisibility } from '@a2wave/shared'
import { Select } from 'antd'
import { FileArchive, Folder, Loader2, Upload } from 'lucide-react'
import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'

export type SkillUploadSelection =
  | { kind: 'file'; name: string }
  | { kind: 'folder'; count: number }

interface SkillUploadDialogProps {
  open: boolean
  isAdmin: boolean
  isPending: boolean
  selection?: SkillUploadSelection
  onOpenChange: (open: boolean) => void
  onConfirm: (visibility: SkillVisibility) => void
}

export function SkillUploadDialog({
  open,
  isAdmin,
  isPending,
  selection,
  onOpenChange,
  onConfirm,
}: SkillUploadDialogProps) {
  const { t } = useTranslation()
  const [visibility, setVisibility] = useState<SkillVisibility>('private')

  useEffect(() => {
    if (open) setVisibility('private')
  }, [open])

  const handleOpenChange = (nextOpen: boolean) => {
    if (!isPending) onOpenChange(nextOpen)
  }

  return (
    <Dialog open={open} onOpenChange={handleOpenChange} width={480}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t('skills.uploadCreateTitle')}</DialogTitle>
          <DialogDescription>{t('skills.uploadCreateDescription')}</DialogDescription>
        </DialogHeader>

        <div className="mt-5 space-y-5">
          {selection ? (
            <div className="flex items-center gap-3 rounded-lg border border-border bg-muted/30 px-3 py-2.5 text-sm">
              {selection.kind === 'file' ? (
                <FileArchive className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden />
              ) : (
                <Folder className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden />
              )}
              <span className="min-w-0 truncate">
                {selection.kind === 'file'
                  ? t('skills.uploadSelectedFile', { name: selection.name })
                  : t('skills.uploadSelectedFolder', { count: selection.count })}
              </span>
            </div>
          ) : null}

          <div className="space-y-1.5">
            <Label htmlFor="skill-upload-visibility">{t('skillDetail.visibility')}</Label>
            <Select
              id="skill-upload-visibility"
              className="w-full"
              value={visibility}
              onChange={(value) => setVisibility(value as SkillVisibility)}
              options={[
                { value: 'private', label: t('skillDetail.visibilityPrivate') },
                {
                  value: 'all-users',
                  label: t('skillDetail.visibilityAllUsers'),
                  disabled: !isAdmin,
                },
              ]}
              disabled={isPending}
            />
            <p className="text-xs text-muted-foreground">
              {isAdmin ? t('skillDetail.visibilityHintAdmin') : t('skillDetail.visibilityHintUser')}
            </p>
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => handleOpenChange(false)} disabled={isPending}>
            {t('common.cancel')}
          </Button>
          <Button onClick={() => onConfirm(visibility)} disabled={!selection || isPending}>
            {isPending ? (
              <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
            ) : (
              <Upload className="h-4 w-4" aria-hidden />
            )}
            {t('skills.upload')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
