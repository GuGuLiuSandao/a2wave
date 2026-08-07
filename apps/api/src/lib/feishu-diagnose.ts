import * as lark from '@larksuiteoapi/node-sdk'
import type { agents } from '../db/schema.js'
import { feishuConnectionManager, normalizeFeishuConfig } from './feishu-service.js'

export type DiagnoseSeverity = 'error' | 'warn' | 'info'

export type DiagnoseCheck = {
  id: string
  severity: DiagnoseSeverity
  message: string
}

export type AgentFeishuDiagnoseData = {
  ok: boolean
  meta: {
    scope: 'current_api_process'
    checkedAt: string
  }
  checks: DiagnoseCheck[]
}

type AgentRow = typeof agents.$inferSelect

type FeishuCfg = NonNullable<AgentRow['feishuConfig']>

function channelsOf(a: AgentRow): string[] {
  return (a.publishChannels as string[] | null | undefined) ?? []
}

function hasFeishuChannel(a: AgentRow): boolean {
  return channelsOf(a).includes('feishu')
}

/** 同步规则检查（不发起外呼） */
export function collectFeishuConfigChecks(
  agent: AgentRow,
  publishedFeishuPeers: AgentRow[],
): DiagnoseCheck[] {
  const checks: DiagnoseCheck[] = []
  const feishuOn = hasFeishuChannel(agent)
  const rawCfg = agent.feishuConfig as Record<string, unknown> | null | undefined
  const cfg = rawCfg ? (normalizeFeishuConfig(rawCfg) as unknown as FeishuCfg) : null

  if (!feishuOn) {
    checks.push({
      id: 'feishu_channel_off',
      severity: 'info',
      message: 'The Feishu publish channel is not enabled for this Agent.',
    })
    return checks
  }

  if (agent.publishStatus === 'draft') {
    checks.push({
      id: 'draft_feishu_enabled',
      severity: 'warn',
      message:
        'The Feishu channel is selected but the Agent is still a draft; no long connection is established until it is published.',
    })
  }

  if (agent.publishStatus === 'stopped') {
    checks.push({
      id: 'stopped_no_ws',
      severity: 'info',
      message: 'The Agent is stopped, so this instance does not maintain a Feishu long connection.',
    })
  }

  if (!cfg) {
    checks.push({
      id: 'feishu_config_missing',
      severity: 'error',
      message:
        'The Feishu channel is enabled but no Feishu app is configured (App ID / Secret, etc.).',
    })
    return checks
  }

  if (!cfg.appId?.trim()) {
    checks.push({
      id: 'feishu_app_id_empty',
      severity: 'error',
      message: 'Feishu App ID (Client ID) is empty.',
    })
  }

  if (!cfg.appSecret?.trim()) {
    checks.push({
      id: 'feishu_app_secret_empty',
      severity: 'error',
      message: 'Feishu App Secret is empty.',
    })
  }

  const replyType = cfg.replyContentType ?? 'text'
  if (replyType === 'interactive' && !cfg.cardTemplateId?.trim()) {
    checks.push({
      id: 'feishu_card_template_required',
      severity: 'error',
      message:
        'A card template ID (cardTemplateId) is required when the reply type is interactive.',
    })
  }

  if (!cfg.groupTriggerOnAt && !cfg.groupTriggerOnNewMessage) {
    checks.push({
      id: 'feishu_group_trigger_none',
      severity: 'warn',
      message:
        'No trigger condition is enabled for regular group chats, so only direct (p2p) messages reach the Agent; regular group chats may get no response.',
    })
  }

  if (!cfg.topicTriggerOnAt && !cfg.topicTriggerOnNewTopic && !cfg.topicTriggerOnNewComment) {
    checks.push({
      id: 'feishu_topic_trigger_none',
      severity: 'warn',
      message:
        'No trigger condition is enabled for topic groups, so topic group messages will not trigger the Agent.',
    })
  }

  if (
    replyType === 'streaming_card' &&
    (cfg.groupReplyMode !== 'none' || cfg.topicReplyMode !== 'none' || cfg.p2pReplyMode !== 'none')
  ) {
    checks.push({
      id: 'feishu_streaming_card_reply_mode',
      severity: 'info',
      message:
        'streaming_card mode uses the streaming card delivery flow wherever a reply is sent (regular group / topic group / direct chat), falling back to the non-streaming path on error.',
    })
  }

  if (replyType === 'interactive_card') {
    checks.push({
      id: 'feishu_interactive_card_callback',
      severity: 'info',
      message:
        'The reply format is "interactive card": on the Feishu Open Platform, go to "Events & Callbacks → Callback configuration" and add "Card callback interaction card.action.trigger", choosing "Receive callbacks over the long connection" as the subscription method, and make sure the `im:message:send_as_bot` scope is granted. Otherwise card clicks cannot be delivered back and the conversation will not resume.',
    })
  }

  if (cfg.fetchUserInfo) {
    checks.push({
      id: 'feishu_fetch_user_info_scopes',
      severity: 'warn',
      message:
        '"Fetch sender user info" is enabled. Make sure the Feishu app has been granted both the base scope `contact:contact.base:readonly` (without it the API returns 403 outright) and the field scopes `contact:user.base:readonly` (name) + `contact:user.email:readonly` (email). Both scope layers apply to tenant_access_token and are unrelated to OAuth user identity.',
    })
  }

  const appId = cfg.appId?.trim()
  if (appId && agent.publishStatus === 'published') {
    const dup = publishedFeishuPeers.filter(
      (p) => p.id !== agent.id && (p.feishuConfig as FeishuCfg | null)?.appId?.trim() === appId,
    )
    if (dup.length > 0) {
      checks.push({
        id: 'feishu_duplicate_app_id',
        severity: 'warn',
        message: `The same Feishu app (App ID) is also used by ${dup.length} other published Agent(s). Within one API process a single app may hold only one Feishu long connection, first come first served; give the other Agents their own Feishu apps, or stop the current holder before enabling this Agent.`,
      })
    }
  }

  return checks
}

/** 同进程内 App 槽位已被其他 Agent 占用时的诊断（需由调用方传入 getExclusiveSlotHolder 结果） */
export function collectFeishuExclusiveSlotChecks(
  agent: AgentRow,
  holderAgentId: string | undefined,
): DiagnoseCheck[] {
  if (!holderAgentId || holderAgentId === agent.id) return []
  if (agent.publishStatus !== 'published') return []
  if (!hasFeishuChannel(agent)) return []
  const cfg = agent.feishuConfig as FeishuCfg | null | undefined
  if (!cfg?.appId?.trim()) return []
  return [
    {
      id: 'feishu_app_id_held_by_peer',
      severity: 'error',
      message: `The long-connection slot for this Feishu app is already held by Agent "${holderAgentId}" in this API process, so the current Agent cannot connect; a later starter cannot preempt it. Stop the holder first, or give one of them a separate Feishu app.`,
    },
  ]
}

export function collectWsChecks(
  agent: AgentRow,
  wsRegistered: boolean,
  wsSocketOpen: boolean,
): DiagnoseCheck[] {
  const checks: DiagnoseCheck[] = []
  if (!hasFeishuChannel(agent)) return checks

  if (agent.publishStatus !== 'published') {
    return checks
  }

  if (!wsRegistered) {
    checks.push({
      id: 'ws_not_registered',
      severity: 'error',
      message:
        'No Feishu long connection is registered for this Agent in the current API process (publishing may have failed, the config may be invalid, or the connection may live on another instance).',
    })
    return checks
  }

  if (!wsSocketOpen) {
    checks.push({
      id: 'ws_not_connected',
      severity: 'warn',
      message:
        'The long connection is registered but the underlying WebSocket is not open — it may be reconnecting, or the credentials or network may be failing; check the service logs.',
    })
  } else {
    checks.push({
      id: 'ws_connected',
      severity: 'info',
      message: 'The Feishu WebSocket is connected on the current instance.',
    })
  }

  return checks
}

/** 调用飞书 bot/v3/info 校验凭证（不返回 secret） */
export async function probeFeishuBotCredentials(
  appId: string,
  appSecret: string,
): Promise<DiagnoseCheck | null> {
  const client = new lark.Client({ appId, appSecret, loggerLevel: lark.LoggerLevel.error })
  try {
    await (client as { request: (r: { method: string; url: string }) => Promise<unknown> }).request(
      {
        method: 'GET',
        url: '/open-apis/bot/v3/info',
      },
    )
    return {
      id: 'feishu_bot_api_ok',
      severity: 'info',
      message: 'Feishu open-apis/bot/v3/info check passed; the app credentials are valid.',
    }
  } catch {
    return {
      id: 'feishu_bot_api_failed',
      severity: 'error',
      message:
        'Could not verify the credentials via Feishu open-apis/bot/v3/info. Check the App ID / App Secret, whether the bot is enabled for the app, and network connectivity.',
    }
  }
}

export async function runAgentFeishuDiagnose(input: {
  agent: AgentRow
  publishedFeishuAgentsSameOwner: AgentRow[]
  wsRegistered: boolean
  wsSocketOpen: boolean
}): Promise<AgentFeishuDiagnoseData> {
  const { agent, publishedFeishuAgentsSameOwner, wsRegistered, wsSocketOpen } = input
  const checks: DiagnoseCheck[] = []

  checks.push(...collectFeishuConfigChecks(agent, publishedFeishuAgentsSameOwner))

  const cfgProbe = agent.feishuConfig as FeishuCfg | null | undefined
  const appIdTrim = cfgProbe?.appId?.trim()
  const slotHolder = appIdTrim
    ? feishuConnectionManager.getExclusiveSlotHolder(appIdTrim)
    : undefined
  const exclusiveSlotChecks = collectFeishuExclusiveSlotChecks(agent, slotHolder)
  checks.push(...exclusiveSlotChecks)

  const wsChecks = collectWsChecks(agent, wsRegistered, wsSocketOpen)
  const heldByPeer = exclusiveSlotChecks.some((c) => c.id === 'feishu_app_id_held_by_peer')
  checks.push(...(heldByPeer ? wsChecks.filter((c) => c.id !== 'ws_not_registered') : wsChecks))

  const cfg = agent.feishuConfig as FeishuCfg | null | undefined
  const canProbe =
    hasFeishuChannel(agent) &&
    cfg &&
    cfg.appId?.trim() &&
    cfg.appSecret?.trim() &&
    !checks.some(
      (c) =>
        c.id === 'feishu_config_missing' ||
        c.id === 'feishu_app_id_empty' ||
        c.id === 'feishu_app_secret_empty',
    )

  if (canProbe && cfg) {
    const probe = await probeFeishuBotCredentials(cfg.appId.trim(), cfg.appSecret.trim())
    if (probe) checks.push(probe)
  }

  const hasError = checks.some((c) => c.severity === 'error')
  const severityOrder: Record<DiagnoseSeverity, number> = { error: 0, warn: 1, info: 2 }
  checks.sort((a, b) => severityOrder[a.severity] - severityOrder[b.severity])

  return {
    ok: !hasError,
    meta: {
      scope: 'current_api_process',
      checkedAt: new Date().toISOString(),
    },
    checks,
  }
}
