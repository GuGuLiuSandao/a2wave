import { describe, expect, it } from 'vitest'
import {
  buildFeishuFileHint,
  mergeFeishuTopicRootText,
  resolveFeishuReplyMentionOpenId,
  resolveFeishuTopicRootId,
  resolveFeishuTopicRootMessageId,
} from '../feishu-topic-root.js'

describe('resolveFeishuTopicRootId', () => {
  const topicReply = {
    chat_type: 'group',
    thread_id: 'thread_1',
    root_id: 'message_root',
    message_id: 'message_reply',
  }

  it('returns the root for an opted-in group topic reply', async () => {
    expect(resolveFeishuTopicRootId(true, false, topicReply)).toBe('message_root')
  })

  it.each([
    ['disabled', false, false, topicReply],
    ['native prompt', true, true, topicReply],
    ['ordinary group reply', true, false, { ...topicReply, thread_id: undefined }],
    ['direct reply', true, false, { ...topicReply, chat_type: 'p2p' }],
    ['topic root itself', true, false, { ...topicReply, message_id: 'message_root' }],
  ])('returns undefined for %s', (_case, enabled, nativePrompt, message) => {
    expect(resolveFeishuTopicRootId(enabled, nativePrompt, message)).toBeUndefined()
  })
})

describe('resolveFeishuTopicRootMessageId', () => {
  it('returns the root message ID for a group topic reply', async () => {
    expect(
      resolveFeishuTopicRootMessageId({
        chat_type: 'group',
        thread_id: 'thread_1',
        root_id: 'message_root',
        message_id: 'message_reply',
      }),
    ).toBe('message_root')
  })

  it.each([
    ['ordinary group message', { chat_type: 'group', root_id: 'message_root' }],
    ['direct message', { chat_type: 'p2p', thread_id: 'thread_1', root_id: 'message_root' }],
    [
      'topic root itself',
      {
        chat_type: 'group',
        thread_id: 'thread_1',
        root_id: 'message_root',
        message_id: 'message_root',
      },
    ],
  ])('returns undefined for %s', (_case, message) => {
    expect(resolveFeishuTopicRootMessageId(message)).toBeUndefined()
  })
})

describe('resolveFeishuReplyMentionOpenId', () => {
  const topicReply = {
    chat_type: 'group',
    thread_id: 'thread_1',
    root_id: 'message_root',
    message_id: 'message_reply',
  }
  const rootUser = { id: 'ou_topic_creator', id_type: 'open_id', sender_type: 'user' }

  it('keeps mentioning the trigger sender by default', async () => {
    expect(
      resolveFeishuReplyMentionOpenId('trigger_sender', topicReply, 'ou_trigger_agent', rootUser),
    ).toBe('ou_trigger_agent')
  })

  it('mentions the topic root user instead of the triggering agent', async () => {
    expect(
      resolveFeishuReplyMentionOpenId('topic_creator', topicReply, 'ou_trigger_agent', rootUser),
    ).toBe('ou_topic_creator')
  })

  it('uses the current sender when the incoming message is the topic root', async () => {
    expect(
      resolveFeishuReplyMentionOpenId(
        'topic_creator',
        { chat_type: 'group', thread_id: 'thread_1', message_id: 'message_root' },
        'ou_topic_creator',
      ),
    ).toBe('ou_topic_creator')
  })

  it('does not mention anyone when explicitly disabled', async () => {
    expect(
      resolveFeishuReplyMentionOpenId('none', topicReply, 'ou_trigger_agent', rootUser),
    ).toBeUndefined()
  })

  it.each([
    ['an ordinary group reply', { chat_type: 'group', message_id: 'message_1' }],
    ['a topic root message', { chat_type: 'group', thread_id: 'thread_1', message_id: 'm_root' }],
  ])('honours an explicit opt-out in %s too', (_case, message) => {
    // 'none' is the one target where the operator is switching a behaviour OFF rather
    // than choosing between recipients. Scoping it to topics only would leave the
    // setting half-applied, which reads as a bug rather than a documented boundary.
    expect(resolveFeishuReplyMentionOpenId('none', message, 'ou_trigger_user')).toBeUndefined()
  })

  it.each([
    ['root lookup failed', undefined],
    ['root sender is a bot', { ...rootUser, sender_type: 'app' }],
    ['root sender does not use open_id', { ...rootUser, id_type: 'user_id' }],
  ])('does not fall back to the triggering agent when %s', (_case, rootSender) => {
    expect(
      resolveFeishuReplyMentionOpenId('topic_creator', topicReply, 'ou_trigger_agent', rootSender),
    ).toBeUndefined()
  })

  it('does not change ordinary group reply mentions', async () => {
    expect(
      resolveFeishuReplyMentionOpenId(
        'topic_creator',
        { chat_type: 'group', message_id: 'message_1' },
        'ou_trigger_user',
      ),
    ).toBe('ou_trigger_user')
  })
})

describe('topic root prompt composition', () => {
  it('places root context before the current reply', async () => {
    expect(mergeFeishuTopicRootText('root', 'reply')).toBe('root\n\n---\nreply')
  })

  it('preserves either side when the other side is empty', async () => {
    expect(mergeFeishuTopicRootText('root', '')).toBe('root')
    expect(mergeFeishuTopicRootText('', 'reply')).toBe('reply')
  })

  it('includes a readable path for root files', async () => {
    expect(buildFeishuFileHint('root.txt', '/tmp/root.txt')).toBe(
      '[文件] root.txt\n文件路径：/tmp/root.txt',
    )
  })
})
