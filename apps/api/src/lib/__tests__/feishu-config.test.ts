import { describe, expect, it } from 'vitest'
import { normalizeFeishuConfig } from '../feishu-config.js'

describe('normalizeFeishuConfig topic settings', () => {
  it('uses safe defaults for legacy configs', async () => {
    const config = normalizeFeishuConfig({ appId: 'cli_x', appSecret: 'secret' })

    expect(config.topicInjectRootMessage).toBe(false)
    expect(config.topicReplyMentionTarget).toBe('trigger_sender')
  })

  it.each(['trigger_sender', 'topic_creator', 'none'] as const)(
    'preserves topicReplyMentionTarget=%s',
    (topicReplyMentionTarget) => {
      const config = normalizeFeishuConfig({
        appId: 'cli_x',
        appSecret: 'secret',
        topicReplyMentionTarget,
      })

      expect(config.topicReplyMentionTarget).toBe(topicReplyMentionTarget)
    },
  )

  it('falls back when topicReplyMentionTarget is invalid', async () => {
    const config = normalizeFeishuConfig({
      appId: 'cli_x',
      appSecret: 'secret',
      topicReplyMentionTarget: 'second_mention',
    })

    expect(config.topicReplyMentionTarget).toBe('trigger_sender')
  })

  it('preserves an explicit boolean opt-in', async () => {
    const config = normalizeFeishuConfig({
      appId: 'cli_x',
      appSecret: 'secret',
      topicInjectRootMessage: true,
    })

    expect(config.topicInjectRootMessage).toBe(true)
  })

  it('rejects non-boolean persisted values', async () => {
    const config = normalizeFeishuConfig({
      appId: 'cli_x',
      appSecret: 'secret',
      topicInjectRootMessage: 'yes',
    })

    expect(config.topicInjectRootMessage).toBe(false)
  })
})
