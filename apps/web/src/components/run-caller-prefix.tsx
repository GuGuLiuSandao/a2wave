import type { RunTriggerSource } from '@a2wave/shared'
import { useTranslation } from 'react-i18next'

/**
 * i18n key per trigger source — the single copy.
 *
 * Typed as a total Record so adding a channel to the shared enum fails the build
 * here instead of silently rendering a raw key; a second hand-maintained copy is
 * how slack/discord went missing from the Agent overview breakdown.
 */
export const SOURCE_LABEL: Record<RunTriggerSource, string> = {
  debug: 'runs.sourceDebug',
  api: 'runs.sourceApi',
  feishu: 'runs.sourceFeishu',
  slack: 'runs.sourceSlack',
  discord: 'runs.sourceDiscord',
  a2a: 'runs.sourceA2a',
  schedule: 'runs.sourceSchedule',
  oauth: 'runs.sourceOauth',
  chat_app: 'runs.sourceChatApp',
  glab: 'runs.sourceGlab',
  gh: 'runs.sourceGh',
}

/**
 * Inline caller chip for run rows: renders a muted rounded pill in front of the
 * run intent. Three modes (in order of fallback):
 *   - name + source → `⟨张立成·飞书⟩`
 *   - name only     → `⟨张立成⟩`
 *   - source only   → `⟨飞书⟩`  ← keeps the channel signal visible for
 *                                 api_key / schedule / no-email-scope feishu /
 *                                 anonymous OAuth runs.
 * Returns null only when BOTH are missing.
 */
export function RunCallerPrefix({
  name,
  source,
}: {
  name: string | null | undefined
  source: RunTriggerSource | null | undefined
}) {
  const { t } = useTranslation()
  if (!name && !source) return null
  const channelLabel = source ? t(SOURCE_LABEL[source]) : null
  const label = name ? (channelLabel ? `${name}·${channelLabel}` : name) : (channelLabel ?? '')
  return (
    <span className="mr-1.5 inline-block max-w-[14rem] truncate rounded bg-muted px-1.5 py-0.5 align-middle text-xs font-normal text-muted-foreground">
      {label}
    </span>
  )
}
