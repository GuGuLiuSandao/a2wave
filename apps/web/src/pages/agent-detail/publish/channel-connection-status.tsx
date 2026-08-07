// The live connection readout on a native chat channel's card.
//
// Each chat channel holds its own long connection over its own protocol, so the
// pill names the protocol (WebSocket / Socket Mode / Gateway) next to the state
// rather than showing an anonymous green dot — when three channels are enabled
// at once, the protocol is what tells an operator which one to go debug.
import {
  CHANNEL_TRANSPORTS,
  type ChannelConnectionUiKind,
  type ConnectedChannelKey,
  channelConnectionLabelKey,
  channelConnectionTone,
} from '@/lib/channel-connection-ui'
import { cn } from '@/lib/utils'
import { Tooltip } from 'antd'
import { Loader2 } from 'lucide-react'
import { useTranslation } from 'react-i18next'

const toneDotClass = {
  success: 'bg-success',
  warning: 'bg-warning',
  muted: 'bg-muted-foreground/40',
} as const

const toneTextClass = {
  success: 'text-success',
  warning: 'text-warning',
  muted: 'text-muted-foreground',
} as const

export interface ChannelConnectionStatusProps {
  channel: ConnectedChannelKey
  kind: ChannelConnectionUiKind
}

export function ChannelConnectionStatus({ channel, kind }: ChannelConnectionStatusProps) {
  const { t } = useTranslation()
  const transport = CHANNEL_TRANSPORTS[channel]
  const tone = channelConnectionTone(kind)
  const stateLabel = t(channelConnectionLabelKey(kind))
  const transportLabel = t(transport.labelKey)

  return (
    <Tooltip
      title={
        <div>
          <div>{`${transportLabel} · ${stateLabel}`}</div>
          {/* `pending` and `error` explain themselves rather than describing the
              transport — in both cases the protocol is not the useful fact. */}
          <div className="mt-0.5 text-xs opacity-75">
            {kind === 'pending'
              ? t('agentPublish.connPendingHint')
              : kind === 'error'
                ? t('agentPublish.connErrorHint')
                : t(transport.hintKey)}
          </div>
          {kind !== 'loading' && kind !== 'disabled' && kind !== 'pending' && (
            <div className="mt-0.5 text-xs opacity-75">{t('agentPublish.connScopeHint')}</div>
          )}
        </div>
      }
    >
      <div
        data-testid={`channel-connection-${channel}`}
        data-state={kind}
        className="inline-flex min-w-0 items-center gap-1.5 text-xs"
      >
        {kind === 'loading' ? (
          <Loader2
            className="h-3 w-3 shrink-0 animate-spin text-muted-foreground"
            aria-hidden="true"
          />
        ) : (
          <div
            // Sized inline rather than with `size-1.5` / `h-[6px]`: antd's
            // Radio focus tracking builds `<tag>.<each-class> .ant-radio-input`
            // selectors from the elements it walks, and jsdom's parser rejects
            // the unescaped `.` and `[]` those Tailwind class names carry.
            style={{ width: 6, height: 6 }}
            className={cn(
              'shrink-0 rounded-full',
              toneDotClass[tone],
              // A socket that is up should read as live rather than as one more
              // static dot; reconnecting pulses too, since it is in motion.
              (kind === 'connected' || kind === 'reconnecting') && 'animate-pulse',
            )}
            aria-hidden="true"
          />
        )}
        <span className="shrink-0 text-muted-foreground">{transportLabel}</span>
        <span className={cn('truncate', toneTextClass[tone])}>{stateLabel}</span>
      </div>
    </Tooltip>
  )
}
