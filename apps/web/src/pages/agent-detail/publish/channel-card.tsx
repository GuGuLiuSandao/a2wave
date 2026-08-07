/**
 * One publish channel, rendered as a card in the grid.
 *
 * The card owns enabling (the switch) and opens the config dialog; the dialog
 * owns configuring. Keeping the switch here — and out of the dialog — makes the
 * card the single place a channel is turned on, and avoids two identically
 * labelled switches in the DOM at once.
 */
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import { cn } from '@/lib/utils'
import { Switch, Tooltip } from 'antd'
import { Settings2 } from 'lucide-react'
import type { KeyboardEvent, MouseEvent, ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import type { ChannelMeta } from './channel-registry'

export interface ChannelCardProps {
  meta: ChannelMeta
  enabled: boolean
  onEnabledChange: (value: boolean) => void
  /** i18n key explaining why the switch is disabled; null when the channel is ready. */
  blockReason: string | null
  onConfigure: () => void
  /** Compact read-only summary (App ID, page URL…) shown above the actions. */
  info?: ReactNode
  /** Live connection readout; only chat channels holding a socket supply one. */
  connection?: ReactNode
}

export function ChannelCard({
  meta,
  enabled,
  onEnabledChange,
  blockReason,
  onConfigure,
  info,
  connection,
}: ChannelCardProps) {
  const { t } = useTranslation()
  const Icon = meta.icon
  const title = t(meta.titleKey)
  const blocked = !meta.alwaysOn && !enabled && blockReason !== null

  // The card is clickable, so anything interactive inside it has to stop the
  // event on BOTH click and keydown — otherwise operating the switch with the
  // keyboard would also open the dialog.
  const swallow = (e: MouseEvent | KeyboardEvent) => e.stopPropagation()

  return (
    // biome-ignore lint/a11y/useSemanticElements: the card contains a switch and a button, so a native button would be invalid HTML.
    <Card
      role="button"
      tabIndex={0}
      data-testid={`channel-card-${meta.key}`}
      onClick={onConfigure}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault()
          onConfigure()
        }
      }}
      className={cn(
        // The grid sits inside a white panel, so a bg-card (also white) card
        // reads as flat — only the hairline border separated the two. Resting
        // on the muted surface instead makes each card a distinct tile.
        // hover:bg-surface-hover still wins over it: the brand tint is
        // translucent, so it composites on top rather than being cancelled.
        'cursor-pointer bg-muted/40 transition-colors hover:bg-surface-hover',
        enabled && 'border-primary/40',
      )}
    >
      <CardContent className="flex h-full flex-col gap-2.5 p-4">
        {/* Icon and title share a row so the card leads with one line of
            identity instead of stacking a lone icon above the name. */}
        <div className="flex items-center justify-between gap-3">
          <div className="flex min-w-0 items-center gap-2.5">
            <div className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-brand-gradient-subtle text-interactive-foreground">
              <Icon className="h-[18px] w-[18px]" aria-hidden="true" />
            </div>
            <h3 className="truncate text-sm font-medium text-foreground">{title}</h3>
          </div>

          {/* The pill is bg-card rather than bg-muted: the card itself now rests
              on bg-muted/40, so a muted pill on it would have almost no edge. */}
          {meta.alwaysOn ? (
            <span className="rounded-full bg-card px-2 py-0.5 text-[11px] leading-5 text-muted-foreground">
              {t('agentPublish.channelAlwaysOn')}
            </span>
          ) : (
            <span
              className="flex items-center gap-2"
              data-tour={meta.tourAnchor}
              onClick={swallow}
              onKeyDown={swallow}
              role="presentation"
            >
              <span className="text-xs text-muted-foreground">
                {enabled ? t('agentPublish.channelEnabled') : t('agentPublish.channelDisabled')}
              </span>
              <Tooltip title={blocked ? t('agentPublish.enableNeedsConfig') : undefined}>
                {/* antd disables pointer events on a disabled Switch, so the
                    Tooltip needs a wrapper to still receive hover. */}
                <span className={cn(blocked && 'cursor-not-allowed')}>
                  <Switch
                    checked={enabled}
                    disabled={blocked}
                    onChange={onEnabledChange}
                    // A disabled switch is not focusable, so the tooltip alone
                    // would leave keyboard and screen-reader users unable to
                    // find out why it cannot be turned on. Fold the reason into
                    // the accessible name instead of relying on hover.
                    aria-label={
                      blocked
                        ? `${t(meta.switchLabelKey)} — ${t('agentPublish.enableNeedsConfig')}`
                        : t(meta.switchLabelKey)
                    }
                  />
                </span>
              </Tooltip>
            </span>
          )}
        </div>

        <p className="line-clamp-2 min-w-0 text-xs leading-relaxed text-muted-foreground">
          {t(meta.descKey)}
        </p>

        {/* Sits above the identifying info: the socket's state is what changes
            minute to minute, while the App ID is static reference material. */}
        {connection && <div className="min-w-0">{connection}</div>}

        {info && <div className="border-t border-border/60 pt-3 text-xs">{info}</div>}

        <div className="mt-auto flex justify-end pt-1">
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={(e) => {
              e.stopPropagation()
              onConfigure()
            }}
          >
            <Settings2 className="h-3.5 w-3.5" aria-hidden="true" />
            {t('agentPublish.configure')}
          </Button>
        </div>
      </CardContent>
    </Card>
  )
}
