import type * as lark from '@larksuiteoapi/node-sdk'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  resolveFeishuFailureReplyMentionOpenId,
  resolveFeishuMentionRootId,
  supportsFeishuReplyMention,
} from '../feishu-reply-mention.js'

const mockLoggerWarn = vi.hoisted(() => vi.fn())

vi.mock('../logger.js', () => ({
  logger: { warn: mockLoggerWarn },
}))

describe('Feishu reply mention lookup', () => {
  const topicReply = {
    chat_type: 'group',
    thread_id: 'thread_1',
    root_id: 'message_root',
    message_id: 'message_reply',
  }

  let messageGet: ReturnType<typeof vi.fn>
  let client: lark.Client

  beforeEach(() => {
    vi.clearAllMocks()
    messageGet = vi.fn()
    client = { im: { message: { get: messageGet } } } as unknown as lark.Client
  })

  it('resolves the topic creator for failure replies', async () => {
    messageGet.mockResolvedValue({
      data: {
        items: [
          {
            sender: {
              id: 'ou_topic_creator',
              id_type: 'open_id',
              sender_type: 'user',
            },
          },
        ],
      },
    })

    await expect(
      resolveFeishuFailureReplyMentionOpenId(
        client,
        { sender_id: { open_id: 'ou_trigger_agent' } },
        topicReply,
        { topicReplyMentionTarget: 'topic_creator' },
      ),
    ).resolves.toBe('ou_topic_creator')
    expect(messageGet).toHaveBeenCalledWith({ path: { message_id: 'message_root' } })
  })

  it('does not query or mention anyone when mentions are disabled', async () => {
    await expect(
      resolveFeishuFailureReplyMentionOpenId(
        client,
        { sender_id: { open_id: 'ou_trigger_agent' } },
        topicReply,
        { topicReplyMentionTarget: 'none' },
      ),
    ).resolves.toBeUndefined()
    expect(messageGet).not.toHaveBeenCalled()
  })

  it('does not fall back to the triggering bot when creator lookup fails', async () => {
    messageGet.mockRejectedValue(new Error('missing im:message.group_msg'))

    await expect(
      resolveFeishuFailureReplyMentionOpenId(
        client,
        { sender_id: { open_id: 'ou_trigger_agent' } },
        topicReply,
        { topicReplyMentionTarget: 'topic_creator' },
      ),
    ).resolves.toBeUndefined()
    expect(mockLoggerWarn).toHaveBeenCalledOnce()
  })
})

describe('Feishu reply mention capability', () => {
  const topicReply = {
    chat_type: 'group',
    thread_id: 'thread_1',
    root_id: 'message_root',
    message_id: 'message_reply',
  }

  it.each(['text', 'post'] as const)('%s replies support mentions', (replyContentType) => {
    expect(supportsFeishuReplyMention(replyContentType)).toBe(true)
    expect(resolveFeishuMentionRootId('topic_creator', replyContentType, topicReply)).toBe(
      'message_root',
    )
  })

  it.each(['interactive', 'interactive_card', 'streaming_card'] as const)(
    '%s replies skip creator lookup',
    (replyContentType) => {
      expect(supportsFeishuReplyMention(replyContentType)).toBe(false)
      expect(
        resolveFeishuMentionRootId('topic_creator', replyContentType, topicReply),
      ).toBeUndefined()
    },
  )
})
