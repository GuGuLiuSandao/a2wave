import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { useCheckRemoteSkillUpdate, useRemoteSkillUpdate } from '@/hooks/use-skills'
import type {
  RemoteSkillFileChangeKind,
  RemoteSkillUpdateCheck,
  RemoteSkillUpdateStrategy,
  Skill,
} from '@a2wave/shared'
import { AlertTriangle, CheckCircle2, Loader2 } from 'lucide-react'
import { useEffect } from 'react'
import { useTranslation } from 'react-i18next'

interface RemoteSkillUpdateDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  skill: Skill
  onUpdated: (skill: Skill) => void
}

function changeVariant(change: RemoteSkillFileChangeKind | null) {
  if (change === 'added') return 'success' as const
  if (change === 'deleted') return 'destructive' as const
  if (change === 'modified') return 'warning' as const
  return 'outline' as const
}

export function RemoteSkillUpdateDialog({
  open,
  onOpenChange,
  skill,
  onUpdated,
}: RemoteSkillUpdateDialogProps) {
  const { t } = useTranslation()
  const checkRemote = useCheckRemoteSkillUpdate()
  const updateRemote = useRemoteSkillUpdate()
  const check = checkRemote.data?.data
  const checkForUpdate = checkRemote.mutateAsync
  const resetCheck = checkRemote.reset
  const resetUpdate = updateRemote.reset

  useEffect(() => {
    if (!open) {
      resetCheck()
      resetUpdate()
      return
    }
    void checkForUpdate(skill.id)
  }, [checkForUpdate, open, resetCheck, resetUpdate, skill.id])

  const handleUpdate = async (strategy: RemoteSkillUpdateStrategy) => {
    if (!check) return
    const response = await updateRemote.mutateAsync({
      skillId: skill.id,
      revision: check.latestRevision,
      digest: check.latestDigest,
      strategy,
    })
    onUpdated(response.data.skill)
    onOpenChange(false)
  }

  const renderChange = (side: 'local' | 'remote', change: RemoteSkillFileChangeKind | null) => {
    if (!change) return <span className="text-xs text-muted-foreground">—</span>
    return (
      <Badge variant={changeVariant(change)}>{t(`skills.remote.update.${side}.${change}`)}</Badge>
    )
  }

  const operationError = checkRemote.error ?? updateRemote.error

  return (
    <Dialog open={open} onOpenChange={onOpenChange} width={720}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t('skills.remote.update.title')}</DialogTitle>
          <DialogDescription>{t('skills.remote.update.description')}</DialogDescription>
        </DialogHeader>

        <div className="mt-5 max-h-[60vh] space-y-4 overflow-y-auto pr-1">
          {checkRemote.isPending ? (
            <div className="flex items-center justify-center gap-2 py-12 text-sm text-muted-foreground">
              <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
              {t('skills.remote.update.checking')}
            </div>
          ) : check ? (
            <>
              <div className="rounded-lg border border-border/70 bg-muted/30 p-3 text-sm">
                <div className="flex items-center justify-between gap-3">
                  <span className="font-medium text-foreground">{check.source.repository}</span>
                  {check.updateAvailable ? (
                    <Badge variant="warning">{t('skills.remote.update.available')}</Badge>
                  ) : (
                    <Badge variant="success">{t('skills.remote.update.current')}</Badge>
                  )}
                </div>
                <p className="mt-1 font-mono text-xs text-muted-foreground">
                  {check.installedRevision.slice(0, 8)} → {check.latestRevision.slice(0, 8)}
                </p>
              </div>

              {check.conflicts.length > 0 ? (
                <div className="flex gap-2 rounded-lg border border-warning/30 bg-warning/10 p-3 text-sm text-foreground">
                  <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-warning" aria-hidden />
                  <div>
                    <p className="font-medium">{t('skills.remote.update.conflictTitle')}</p>
                    <p className="mt-0.5 text-muted-foreground">
                      {t('skills.remote.update.conflictDescription', {
                        count: check.conflicts.length,
                      })}
                    </p>
                  </div>
                </div>
              ) : null}

              {check.files.length > 0 ? (
                <div className="overflow-hidden rounded-lg border border-border/70">
                  <div className="grid grid-cols-[minmax(0,1fr)_120px_120px] gap-2 bg-muted/50 px-3 py-2 text-xs font-medium text-muted-foreground">
                    <span>{t('skills.remote.update.file')}</span>
                    <span>{t('skills.remote.update.localColumn')}</span>
                    <span>{t('skills.remote.update.remoteColumn')}</span>
                  </div>
                  {check.files.map((file) => (
                    <div
                      key={file.path}
                      className="grid grid-cols-[minmax(0,1fr)_120px_120px] items-center gap-2 border-t border-border/60 px-3 py-2 text-sm"
                    >
                      <span className="min-w-0 truncate font-mono text-xs" title={file.path}>
                        {file.path}
                        {file.conflict ? (
                          <span className="ml-2 text-warning">
                            {t('skills.remote.update.conflict')}
                          </span>
                        ) : null}
                      </span>
                      <span>{renderChange('local', file.localChange)}</span>
                      <span>{renderChange('remote', file.remoteChange)}</span>
                    </div>
                  ))}
                </div>
              ) : (
                <div className="flex items-center gap-2 rounded-lg border border-border/70 p-4 text-sm text-muted-foreground">
                  <CheckCircle2 className="h-4 w-4 text-success" aria-hidden />
                  {t('skills.remote.update.noChanges')}
                </div>
              )}
            </>
          ) : null}

          {operationError ? (
            <p className="text-sm text-destructive" role="alert">
              {operationError.message}
            </p>
          ) : null}
        </div>

        <DialogFooter>
          <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
            {t('common.cancel')}
          </Button>
          {check?.updateAvailable && check.conflicts.length > 0 ? (
            <>
              <Button
                type="button"
                variant="outline"
                disabled={updateRemote.isPending}
                onClick={() => void handleUpdate('preserve_local')}
              >
                {t('skills.remote.update.preserveLocal')}
              </Button>
              <Button
                type="button"
                variant="destructive"
                disabled={updateRemote.isPending}
                onClick={() => void handleUpdate('overwrite')}
              >
                {t('skills.remote.update.overwrite')}
              </Button>
            </>
          ) : check?.updateAvailable ? (
            <Button
              type="button"
              disabled={updateRemote.isPending}
              onClick={() => void handleUpdate('abort')}
            >
              {updateRemote.isPending ? (
                <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
              ) : null}
              {t('skills.remote.update.apply')}
            </Button>
          ) : null}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
