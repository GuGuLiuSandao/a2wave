import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { uniqueId } from '@/lib/utils'
import { Tag } from 'antd'
import { Eye, EyeOff, Plus, Settings2, Variable, X } from 'lucide-react'
import type { CSSProperties } from 'react'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { EnvEntry } from './types'

interface EnvSectionProps {
  envEntries: EnvEntry[]
  setEnvEntries: React.Dispatch<React.SetStateAction<EnvEntry[]>>
  visibleEnvIds: Set<string>
  setVisibleEnvIds: React.Dispatch<React.SetStateAction<Set<string>>>
}

const SENSITIVE_PATTERNS = /PASSWORD|TOKEN|SECRET|KEY|PASSWD|CREDENTIAL/i

export function EnvSection({
  envEntries,
  setEnvEntries,
  visibleEnvIds,
  setVisibleEnvIds,
}: EnvSectionProps) {
  const { t } = useTranslation()
  const [dialogOpen, setDialogOpen] = useState(false)

  const handleEnvKeyChange = (index: number, newKey: string) => {
    setEnvEntries((prev) => {
      const updated = [...prev]
      const entry = updated[index]
      const wasSensitive = entry.sensitive
      const autoSensitive = SENSITIVE_PATTERNS.test(newKey)
      updated[index] = {
        ...entry,
        key: newKey,
        sensitive: wasSensitive || autoSensitive,
      }
      return updated
    })
  }

  const addEntry = () =>
    setEnvEntries((prev) => [...prev, { id: uniqueId(), key: '', value: '', sensitive: false }])

  /**
   * Opens the editor, seeding a blank row only when there is nothing to edit
   * yet. Seeding unconditionally would mark the form dirty for a user who just
   * opened the dialog to look, triggering a spurious unsaved-changes prompt.
   */
  const openEditor = () => {
    if (envEntries.length === 0) addEntry()
    setDialogOpen(true)
  }

  const namedEntries = envEntries.filter((e) => e.key.trim())

  return (
    <Card className="flex h-full flex-col">
      <CardContent className="flex flex-1 flex-col space-y-3 p-5">
        <div className="space-y-1">
          {/* No bulk-copy affordance here: it emitted `export KEY=value` for
              every variable in plaintext, sensitive ones included, so one click
              put credentials on the clipboard. Values stay reachable one at a
              time behind the per-row reveal toggle in the editor dialog. */}
          <div className="flex items-center gap-2">
            <Variable className="h-4 w-4 text-muted-foreground" aria-hidden="true" />
            <Label className="text-sm font-medium text-foreground">
              {t('agentDetail.envVars')}
            </Label>
            {namedEntries.length > 0 && (
              <span className="text-muted-foreground text-xs tabular-nums">
                {namedEntries.length}
              </span>
            )}
          </div>
          <p className="text-muted-foreground text-xs">{t('agentDetail.envVarsEmptyHint')}</p>
        </div>

        {namedEntries.length === 0 ? (
          // flex-1 + centering: in a stretched row the empty box would otherwise
          // hug the header and leave a gap above the bottom-pinned action.
          <div className="flex flex-1 items-center justify-center rounded-md border border-border/50 border-dashed bg-muted/30 px-3 py-3 text-center">
            <p className="text-muted-foreground text-xs">{t('agentDetail.envVarsEmpty')}</p>
          </div>
        ) : (
          <div className="flex flex-1 flex-wrap content-start gap-1.5">
            {namedEntries.map((entry) => (
              <Tag key={entry.id} className="m-0 max-w-[200px] truncate font-mono text-xs">
                {entry.key.trim()}
              </Tag>
            ))}
          </div>
        )}

        {/* mt-auto pins the action to the card's bottom edge so it lines up
            across a stretched row regardless of how tall the summary is. */}
        <div className="mt-auto flex justify-end pt-1">
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="gap-1"
            onClick={openEditor}
            data-testid="env-configure"
          >
            {namedEntries.length === 0 ? (
              <Plus className="h-3.5 w-3.5" aria-hidden="true" />
            ) : (
              <Settings2 className="h-3.5 w-3.5" aria-hidden="true" />
            )}
            {namedEntries.length === 0
              ? t('agentDetail.addVariable')
              : t('agentDetail.envVarsConfigure')}
          </Button>
        </div>
      </CardContent>

      <Dialog open={dialogOpen} onOpenChange={setDialogOpen} width={720} scrollBody>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t('agentDetail.envVars')}</DialogTitle>
            <DialogDescription>{t('agentDetail.envVarsEmptyHint')}</DialogDescription>
          </DialogHeader>

          <div className="-mr-4 mt-4 max-h-[65vh] space-y-2 overflow-y-auto pr-4">
            {envEntries.map((entry, index) => (
              <div key={entry.id} className="flex items-center gap-2">
                <Input
                  placeholder={t('agentDetail.keyPlaceholder')}
                  value={entry.key}
                  onChange={(e) => handleEnvKeyChange(index, e.target.value)}
                  className="font-mono text-sm w-[160px] shrink-0"
                  spellCheck={false}
                  autoComplete="off"
                />
                <Input
                  placeholder={t('agentDetail.valuePlaceholder')}
                  type="text"
                  value={entry.value}
                  onChange={(e) =>
                    setEnvEntries((prev) => {
                      const updated = [...prev]
                      updated[index] = { ...updated[index], value: e.target.value }
                      return updated
                    })
                  }
                  className="font-mono text-sm flex-1 min-w-0"
                  style={
                    entry.sensitive && !visibleEnvIds.has(entry.id)
                      ? ({ WebkitTextSecurity: 'disc' } as CSSProperties)
                      : undefined
                  }
                  spellCheck={false}
                  autoComplete="off"
                />
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  className="size-8 shrink-0"
                  onClick={() => {
                    if (entry.sensitive) {
                      setVisibleEnvIds((prev) => {
                        const next = new Set(prev)
                        if (next.has(entry.id)) next.delete(entry.id)
                        else next.add(entry.id)
                        return next
                      })
                    } else {
                      setEnvEntries((prev) => {
                        const updated = [...prev]
                        updated[index] = { ...updated[index], sensitive: true }
                        return updated
                      })
                    }
                  }}
                  aria-label={
                    entry.sensitive
                      ? visibleEnvIds.has(entry.id)
                        ? t('agentDetail.hideValue')
                        : t('agentDetail.showValue')
                      : t('agentDetail.markSensitive')
                  }
                  title={
                    entry.sensitive
                      ? visibleEnvIds.has(entry.id)
                        ? t('agentDetail.hideValue')
                        : t('agentDetail.showValue')
                      : t('agentDetail.markSensitive')
                  }
                >
                  {entry.sensitive ? (
                    visibleEnvIds.has(entry.id) ? (
                      <EyeOff className="h-4 w-4" />
                    ) : (
                      <Eye className="h-4 w-4" />
                    )
                  ) : (
                    <Eye className="h-4 w-4 text-muted-foreground/40" />
                  )}
                </Button>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  className="size-8 shrink-0 text-muted-foreground hover:text-destructive"
                  onClick={() => {
                    setEnvEntries((prev) => prev.filter((_, i) => i !== index))
                    setVisibleEnvIds((prev) => {
                      const next = new Set(prev)
                      next.delete(entry.id)
                      return next
                    })
                  }}
                  aria-label={t('agentDetail.removeVariable')}
                >
                  <X className="h-4 w-4" />
                </Button>
              </div>
            ))}
          </div>

          <Button type="button" variant="outline" size="sm" className="mt-3" onClick={addEntry}>
            <Plus className="h-4 w-4" aria-hidden="true" />
            {t('agentDetail.addVariable')}
          </Button>
        </DialogContent>
      </Dialog>
    </Card>
  )
}
