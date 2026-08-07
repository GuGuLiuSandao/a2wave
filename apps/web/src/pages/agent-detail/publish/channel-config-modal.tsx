/**
 * Modal shell hosting one channel's config form.
 *
 * Open state is addressed by the existing `?publishTab=<key>` query param, so
 * deep links, the onboarding tour and the E2E specs that navigate straight to a
 * channel keep working — the param's meaning shifts from "which sub-tab is
 * active" to "which channel's dialog is open".
 *
 * Saving is per-channel (PATCH /agents/:id/channels/:channel) and independent
 * of publishing, so the footer says Save rather than implying it goes live.
 */
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Info, Loader2 } from 'lucide-react'
import type { ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import type { ChannelMeta } from './channel-registry'

export interface ChannelConfigModalProps {
  meta: ChannelMeta | null
  open: boolean
  onClose: () => void
  children: ReactNode
  /** Absent for channels with nothing to persist on their own (api, oauth, a2a). */
  onSave?: () => void
  isSaving?: boolean
  /**
   * i18n key naming the missing required field, or null when the form is
   * complete. Disables Save and is shown beside it, so an incomplete config
   * cannot be saved into a state publish would immediately reject — and the
   * greyed-out button always says what is missing rather than being a dead end.
   */
  saveBlockReason?: string | null
  /**
   * Some settings live on flat agent columns rather than the channel's config
   * column, so Save cannot persist them. Shown as a hint so Save never
   * silently drops a change the user just made.
   */
  publishOnlyHint?: boolean
}

export function ChannelConfigModal({
  meta,
  open,
  onClose,
  children,
  onSave,
  isSaving,
  publishOnlyHint,
  saveBlockReason,
}: ChannelConfigModalProps) {
  const { t } = useTranslation()

  return (
    <Dialog
      open={open && !!meta}
      onOpenChange={(next) => !next && onClose()}
      width={720}
      scrollBody
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{meta ? t(meta.titleKey) : ''}</DialogTitle>
        </DialogHeader>

        <div className="flex max-h-[70vh] flex-col">
          <div className="-mr-5 min-h-0 flex-1 overflow-y-auto pr-5 pt-1">{children}</div>

          <div className="mt-4 flex shrink-0 items-center justify-end gap-2 border-t border-border/60 pt-3">
            {/* The two hints answer different questions — "why is Save
                greyed out" and "why won't Save be enough" — so they stack
                rather than compete for the one slot. */}
            <div className="mr-auto flex flex-col gap-1">
              {onSave && saveBlockReason && (
                <span className="flex items-center gap-1.5 text-xs text-warning">
                  <Info className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
                  {t(saveBlockReason)}
                </span>
              )}
              {publishOnlyHint && (
                <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
                  <Info className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
                  {t('agentPublish.publishOnlySettingHint')}
                </span>
              )}
            </div>
            <Button type="button" variant="outline" onClick={onClose}>
              {onSave ? t('common.cancel') : t('common.close')}
            </Button>
            {onSave && (
              <Button type="button" onClick={onSave} disabled={isSaving || !!saveBlockReason}>
                {isSaving && <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />}
                {t('common.save')}
              </Button>
            )}
          </div>
        </div>
      </DialogContent>
    </Dialog>
  )
}
