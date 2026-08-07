import { describe, expect, it } from 'vitest'
import type { agents } from '../../db/schema.js'
import {
  collectFeishuConfigChecks,
  collectFeishuExclusiveSlotChecks,
  collectWsChecks,
} from '../feishu-diagnose.js'

type AgentRow = typeof agents.$inferSelect

/** 仅用于诊断纯函数测试的轻量行（字段不全时由 as 断言） */
function row(p: Partial<AgentRow> & { id: string }): AgentRow {
  return p as AgentRow
}

describe('collectFeishuConfigChecks', () => {
  it('未启用飞书渠道时仅 info', async () => {
    const checks = collectFeishuConfigChecks(row({ id: 'a1', publishChannels: ['api'] }), [])
    expect(checks.some((c) => c.id === 'feishu_channel_off')).toBe(true)
    expect(checks.every((c) => c.severity === 'info')).toBe(true)
  })

  it('启用飞书但无配置 → error', async () => {
    const checks = collectFeishuConfigChecks(
      row({ id: 'a1', publishChannels: ['api', 'feishu'], feishuConfig: null }),
      [],
    )
    expect(checks.some((c) => c.id === 'feishu_config_missing' && c.severity === 'error')).toBe(
      true,
    )
  })

  it('interactive 缺少 cardTemplateId → error', async () => {
    const checks = collectFeishuConfigChecks(
      row({
        id: 'a1',
        publishChannels: ['feishu'],
        feishuConfig: {
          appId: 'cli_x',
          appSecret: 's',
          groupTriggerOnAt: true,
          groupTriggerOnNewMessage: false,
          groupReplyMode: 'quote',
          topicTriggerOnAt: true,
          topicTriggerOnNewTopic: false,
          topicTriggerOnNewComment: false,
          topicReplyMode: 'topic_reply',
          replyContentType: 'interactive',
          sendArtifactsAsFile: true,
        },
      }),
      [],
    )
    expect(checks.some((c) => c.id === 'feishu_card_template_required')).toBe(true)
  })

  it('streaming_card 不要求 cardTemplateId', async () => {
    const checks = collectFeishuConfigChecks(
      row({
        id: 'a1',
        publishChannels: ['feishu'],
        feishuConfig: {
          appId: 'cli_x',
          appSecret: 's',
          groupTriggerOnAt: true,
          groupTriggerOnNewMessage: false,
          groupReplyMode: 'quote',
          topicTriggerOnAt: true,
          topicTriggerOnNewTopic: false,
          topicTriggerOnNewComment: false,
          topicReplyMode: 'topic_reply',
          replyContentType: 'streaming_card',
          sendArtifactsAsFile: true,
        },
      }),
      [],
    )
    expect(checks.some((c) => c.id === 'feishu_card_template_required')).toBe(false)
  })

  it('streaming_card + 仅 p2pReplyMode 非 none → 仍输出 streaming_card info', async () => {
    // 用户场景：「我只在私聊用 streaming_card」——group/topic 都设 none，仅 p2p 启用回复
    const checks = collectFeishuConfigChecks(
      row({
        id: 'a1',
        publishChannels: ['feishu'],
        feishuConfig: {
          appId: 'cli_x',
          appSecret: 's',
          groupTriggerOnAt: true,
          groupTriggerOnNewMessage: false,
          groupReplyMode: 'none',
          topicTriggerOnAt: true,
          topicTriggerOnNewTopic: false,
          topicTriggerOnNewComment: false,
          topicReplyMode: 'none',
          p2pReplyMode: 'quote',
          replyContentType: 'streaming_card',
          sendArtifactsAsFile: true,
        },
      }),
      [],
    )
    expect(checks.some((c) => c.id === 'feishu_streaming_card_reply_mode')).toBe(true)
  })

  it('fetchUserInfo=true 时 warn 提示需要 contact 权限', async () => {
    const checks = collectFeishuConfigChecks(
      row({
        id: 'a1',
        publishChannels: ['feishu'],
        feishuConfig: {
          appId: 'cli_x',
          appSecret: 's',
          groupTriggerOnAt: true,
          groupTriggerOnNewMessage: false,
          groupReplyMode: 'quote',
          topicTriggerOnAt: true,
          topicTriggerOnNewTopic: false,
          topicTriggerOnNewComment: false,
          topicReplyMode: 'topic_reply',
          replyContentType: 'text',
          sendArtifactsAsFile: true,
          fetchUserInfo: true,
        },
      }),
      [],
    )
    const check = checks.find((c) => c.id === 'feishu_fetch_user_info_scopes')
    expect(check).toBeDefined()
    if (!check) throw new Error('missing feishu_fetch_user_info_scopes check')
    expect(check.severity).toBe('warn')
    expect(check.message).toContain('contact:contact.base:readonly')
    expect(check.message).toContain('contact:user.email:readonly')
  })

  it('fetchUserInfo=false 时不生成 contact 权限告警', async () => {
    const checks = collectFeishuConfigChecks(
      row({
        id: 'a1',
        publishChannels: ['feishu'],
        feishuConfig: {
          appId: 'cli_x',
          appSecret: 's',
          groupTriggerOnAt: true,
          groupTriggerOnNewMessage: false,
          groupReplyMode: 'quote',
          topicTriggerOnAt: true,
          topicTriggerOnNewTopic: false,
          topicTriggerOnNewComment: false,
          topicReplyMode: 'topic_reply',
          replyContentType: 'text',
          sendArtifactsAsFile: true,
          fetchUserInfo: false,
        },
      }),
      [],
    )
    expect(checks.some((c) => c.id === 'feishu_fetch_user_info_scopes')).toBe(false)
  })

  it('重复 appId 给出 warn', async () => {
    const cfg = {
      appId: 'cli_dup',
      appSecret: 's',
      groupTriggerOnAt: true,
      groupTriggerOnNewMessage: false,
      groupReplyMode: 'quote' as const,
      topicTriggerOnAt: true,
      topicTriggerOnNewTopic: false,
      topicTriggerOnNewComment: false,
      topicReplyMode: 'topic_reply' as const,
      replyContentType: 'text' as const,
      sendArtifactsAsFile: true,
    }
    const peers = [
      row({
        id: 'other',
        publishStatus: 'published',
        publishChannels: ['feishu'],
        feishuConfig: cfg,
      }),
    ]
    const checks = collectFeishuConfigChecks(
      row({
        id: 'self',
        publishStatus: 'published',
        publishChannels: ['feishu'],
        feishuConfig: { ...cfg },
      }),
      peers,
    )
    expect(checks.some((c) => c.id === 'feishu_duplicate_app_id')).toBe(true)
  })
})

describe('collectFeishuExclusiveSlotChecks', () => {
  it('槽位被其他 Agent 占用 → error', async () => {
    const checks = collectFeishuExclusiveSlotChecks(
      row({
        id: 'agt_loser',
        publishStatus: 'published',
        publishChannels: ['feishu'],
        feishuConfig: { appId: 'cli_x', appSecret: 's' } as never,
      }),
      'agt_winner',
    )
    expect(
      checks.some((c) => c.id === 'feishu_app_id_held_by_peer' && c.severity === 'error'),
    ).toBe(true)
  })

  it('槽位由自身占用或无占用 → 无检查项', async () => {
    expect(
      collectFeishuExclusiveSlotChecks(
        row({
          id: 'agt_self',
          publishStatus: 'published',
          publishChannels: ['feishu'],
          feishuConfig: { appId: 'cli_x', appSecret: 's' } as never,
        }),
        'agt_self',
      ),
    ).toHaveLength(0)
    expect(
      collectFeishuExclusiveSlotChecks(
        row({
          id: 'agt_x',
          publishStatus: 'published',
          publishChannels: ['feishu'],
          feishuConfig: { appId: 'cli_x', appSecret: 's' } as never,
        }),
        undefined,
      ),
    ).toHaveLength(0)
  })
})

describe('collectWsChecks', () => {
  it('已发布且注册但未连通 → warn', async () => {
    const checks = collectWsChecks(
      row({
        id: 'a1',
        publishStatus: 'published',
        publishChannels: ['feishu'],
        feishuConfig: {} as never,
      }),
      true,
      false,
    )
    expect(checks.some((c) => c.id === 'ws_not_connected')).toBe(true)
  })

  it('已发布但未注册 → error', async () => {
    const checks = collectWsChecks(
      row({
        id: 'a1',
        publishStatus: 'published',
        publishChannels: ['feishu'],
        feishuConfig: {} as never,
      }),
      false,
      false,
    )
    expect(checks.some((c) => c.id === 'ws_not_registered' && c.severity === 'error')).toBe(true)
  })
})
