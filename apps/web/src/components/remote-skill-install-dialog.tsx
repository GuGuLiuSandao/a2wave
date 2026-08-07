import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { useCurrentUser } from '@/hooks/use-auth'
import { useInspectRemoteSkills, useInstallRemoteSkills } from '@/hooks/use-skills'
import type { Skill, SkillGroup, SkillVisibility } from '@a2wave/shared'
import { Alert, Checkbox, Input, Select } from 'antd'
import { Download, Github, Loader2, Search } from 'lucide-react'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'

interface RemoteSkillInstallDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  groups: SkillGroup[]
  onInstalled: (skills: Skill[]) => void
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}

export function RemoteSkillInstallDialog({
  open,
  onOpenChange,
  groups,
  onInstalled,
}: RemoteSkillInstallDialogProps) {
  const { t } = useTranslation()
  const inspectRemote = useInspectRemoteSkills()
  const installRemote = useInstallRemoteSkills()
  const { data: currentUser } = useCurrentUser()
  const isAdmin = currentUser?.role === 'admin'
  const [url, setUrl] = useState('')
  const [inspection, setInspection] =
    useState<Awaited<ReturnType<typeof inspectRemote.mutateAsync>>['data']>()
  const [selectedPaths, setSelectedPaths] = useState<string[]>([])
  const [groupId, setGroupId] = useState<string>()
  const [visibility, setVisibility] = useState<SkillVisibility>('private')

  const handleOpenChange = (nextOpen: boolean) => {
    if (nextOpen) {
      onOpenChange(true)
      return
    }
    setUrl('')
    setInspection(undefined)
    setSelectedPaths([])
    setGroupId(undefined)
    setVisibility('private')
    inspectRemote.reset()
    installRemote.reset()
    onOpenChange(false)
  }

  const handleInspect = async () => {
    try {
      const result = await inspectRemote.mutateAsync(url.trim())
      setInspection(result.data)
      setSelectedPaths(
        result.data.candidates.length <= 20
          ? result.data.candidates.map((candidate) => candidate.path)
          : [],
      )
    } catch {
      // The mutation exposes the API error inline.
    }
  }

  const handleInstall = async () => {
    if (!inspection) return
    const selections = inspection.candidates
      .filter((candidate) => selectedPaths.includes(candidate.path))
      .map((candidate) => ({ path: candidate.path, digest: candidate.digest }))
    try {
      const result = await installRemote.mutateAsync({
        url: inspection.inputUrl,
        requestedRef: inspection.requestedRef,
        revision: inspection.revision,
        selections,
        groupId,
        visibility,
      })
      onInstalled(result.data)
      handleOpenChange(false)
    } catch {
      // The mutation exposes the API error inline.
    }
  }

  const operationError = inspectRemote.error ?? installRemote.error

  return (
    <Dialog open={open} onOpenChange={handleOpenChange} width={680}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Github className="h-4 w-4" aria-hidden />
            {t('skills.remote.title')}
          </DialogTitle>
          <DialogDescription>{t('skills.remote.description')}</DialogDescription>
        </DialogHeader>

        <div className="mt-5 space-y-4">
          <div className="space-y-1.5">
            <label htmlFor="remote-skill-url" className="text-sm font-medium text-foreground">
              {t('skills.remote.url')}
            </label>
            <div className="flex gap-2">
              <Input
                id="remote-skill-url"
                value={url}
                onChange={(event) => {
                  setUrl(event.target.value)
                  setInspection(undefined)
                  setSelectedPaths([])
                  inspectRemote.reset()
                }}
                onPressEnter={() => {
                  if (url.trim() && !inspectRemote.isPending) void handleInspect()
                }}
                placeholder={t('skills.remote.urlPlaceholder')}
                disabled={inspectRemote.isPending || installRemote.isPending}
              />
              <Button
                variant="outline"
                onClick={() => void handleInspect()}
                disabled={!url.trim() || inspectRemote.isPending || installRemote.isPending}
              >
                {inspectRemote.isPending ? (
                  <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
                ) : (
                  <Search className="h-4 w-4" aria-hidden />
                )}
                {t('skills.remote.inspect')}
              </Button>
            </div>
            <p className="text-xs text-muted-foreground">{t('skills.remote.supported')}</p>
          </div>

          {operationError ? (
            <Alert
              type="error"
              showIcon
              message={
                operationError instanceof Error ? operationError.message : String(operationError)
              }
            />
          ) : null}

          {inspection ? (
            <>
              <div className="rounded-lg border border-border bg-muted/30 px-3 py-2 text-sm">
                <div className="font-medium text-foreground">{inspection.repository}</div>
                <div className="mt-0.5 text-xs text-muted-foreground">
                  {t('skills.remote.snapshot', {
                    ref: inspection.requestedRef,
                    revision: inspection.revision.slice(0, 8),
                  })}
                </div>
              </div>

              <div className="space-y-2">
                <div className="flex items-center justify-between">
                  <span className="text-sm font-medium text-foreground">
                    {t('skills.remote.candidates', { count: inspection.candidates.length })}
                  </span>
                  <span className="text-xs text-muted-foreground">
                    {t('skills.remote.selectionLimit')}
                  </span>
                </div>
                <div className="max-h-64 space-y-2 overflow-y-auto rounded-lg border border-border p-2">
                  {inspection.candidates.map((candidate, index) => {
                    const checked = selectedPaths.includes(candidate.path)
                    const selectionDisabled = !checked && selectedPaths.length >= 20
                    const checkboxId = `remote-skill-candidate-${index}`
                    return (
                      <div
                        key={candidate.path}
                        className="flex items-start gap-3 rounded-md px-2 py-2 hover:bg-muted/50"
                      >
                        <Checkbox
                          id={checkboxId}
                          checked={checked}
                          disabled={selectionDisabled || installRemote.isPending}
                          onChange={(event) => {
                            setSelectedPaths((current) =>
                              event.target.checked
                                ? [...current, candidate.path]
                                : current.filter((path) => path !== candidate.path),
                            )
                          }}
                        />
                        <label htmlFor={checkboxId} className="min-w-0 flex-1 cursor-pointer">
                          <span className="block font-medium text-foreground">
                            {candidate.name}
                          </span>
                          <span className="block text-xs text-muted-foreground">
                            {candidate.path} · {candidate.fileCount} {t('skills.remote.files')} ·{' '}
                            {formatBytes(candidate.totalBytes)}
                          </span>
                          {candidate.description ? (
                            <span className="mt-1 block text-xs text-muted-foreground line-clamp-2">
                              {candidate.description}
                            </span>
                          ) : null}
                        </label>
                      </div>
                    )
                  })}
                </div>
              </div>

              <div className="space-y-1.5">
                <label htmlFor="remote-skill-group" className="text-sm font-medium text-foreground">
                  {t('skills.remote.group')}
                </label>
                <Select
                  id="remote-skill-group"
                  allowClear
                  className="w-full"
                  placeholder={t('skills.remote.ungrouped')}
                  value={groupId}
                  onChange={setGroupId}
                  options={groups.map((group) => ({ value: group.id, label: group.name }))}
                  disabled={installRemote.isPending}
                />
              </div>

              <div className="space-y-1.5">
                <label
                  htmlFor="remote-skill-visibility"
                  className="text-sm font-medium text-foreground"
                >
                  {t('skillDetail.visibility')}
                </label>
                <Select
                  id="remote-skill-visibility"
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
                  disabled={installRemote.isPending}
                />
                <p className="text-xs text-muted-foreground">
                  {isAdmin
                    ? t('skillDetail.visibilityHintAdmin')
                    : t('skillDetail.visibilityHintUser')}
                </p>
              </div>
            </>
          ) : null}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => handleOpenChange(false)}>
            {t('common.cancel')}
          </Button>
          <Button
            onClick={() => void handleInstall()}
            disabled={!inspection || selectedPaths.length === 0 || installRemote.isPending}
          >
            {installRemote.isPending ? (
              <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
            ) : (
              <Download className="h-4 w-4" aria-hidden />
            )}
            {t('skills.remote.install', { count: selectedPaths.length })}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
