import type * as lark from '@larksuiteoapi/node-sdk'
import type { NormalizedFeishuConfig } from './feishu-config.js'
import {
  type FeishuMessageIdentity,
  type FeishuMessageSender,
  resolveFeishuReplyMentionOpenId,
  resolveFeishuTopicRootMessageId,
} from './feishu-topic-root.js'
import { logger } from './logger.js'

type FeishuEventSender = {
  sender_id?: { open_id?: string }
}

type FeishuMessageGetResponse = {
  data?: { items?: Array<{ sender?: FeishuMessageSender }> }
}

export function supportsFeishuReplyMention(replyContentType: string): boolean {
  return replyContentType === 'text' || replyContentType === 'post'
}

/**
 * Single source of truth for "does this mention target need the topic root sender?".
 *
 * Both the dispatch path and the failure-reply path must agree: if they drift, a
 * failure reply would mention a different party than the successful reply would have.
 */
export function needsFeishuRootSenderLookup(
  target: NormalizedFeishuConfig['topicReplyMentionTarget'],
): boolean {
  return target === 'topic_creator'
}

/**
 * Report that a topic_creator mention was dropped.
 *
 * Named after the party that went un-mentioned, not the triggering bot: the whole
 * point of the safe-resolution rule is that the bot is never mentioned instead, so a
 * message saying otherwise sends whoever reads the log looking for the wrong problem.
 */
export function warnFeishuTopicCreatorUnavailable(context: Record<string, unknown>): void {
  logger.warn(
    context,
    'Feishu topic root sender unavailable; reply will not mention the topic creator',
  )
}

/**
 * The root message to look up before a mention can name the topic creator.
 *
 * Gated on `replyContentType`, unlike `resolveFeishuReplyMentionOpenId`, and the
 * asymmetry is deliberate: the resolved open_id also feeds `sendFeishuFailureReply`,
 * which degrades `streaming_card` to `post`, so gating the open_id itself would drop
 * the mention from exactly those failure replies. Only the *lookup* is skipped here,
 * for reply formats that cannot render a text mention at all.
 */
export function resolveFeishuMentionRootId(
  target: NormalizedFeishuConfig['topicReplyMentionTarget'],
  replyContentType: NormalizedFeishuConfig['replyContentType'],
  message: FeishuMessageIdentity,
): string | undefined {
  if (!supportsFeishuReplyMention(replyContentType) || !needsFeishuRootSenderLookup(target)) {
    return undefined
  }
  return resolveFeishuTopicRootMessageId(message)
}

export async function resolveFeishuFailureReplyMentionOpenId(
  client: lark.Client,
  dataSender: FeishuEventSender | undefined,
  message: FeishuMessageIdentity,
  config: Pick<NormalizedFeishuConfig, 'topicReplyMentionTarget'>,
): Promise<string | undefined> {
  const triggerSenderOpenId = dataSender?.sender_id?.open_id
  const initialMentionOpenId = resolveFeishuReplyMentionOpenId(
    config.topicReplyMentionTarget,
    message,
    triggerSenderOpenId,
  )
  const rootId = needsFeishuRootSenderLookup(config.topicReplyMentionTarget)
    ? resolveFeishuTopicRootMessageId(message)
    : undefined
  if (!rootId) return initialMentionOpenId

  try {
    const messageApi = client.im.message as unknown as {
      get(input: { path: { message_id: string } }): Promise<FeishuMessageGetResponse>
    }
    const response = await messageApi.get({ path: { message_id: rootId } })
    return resolveFeishuReplyMentionOpenId(
      config.topicReplyMentionTarget,
      message,
      triggerSenderOpenId,
      response.data?.items?.[0]?.sender,
    )
  } catch (err) {
    logger.warn(
      { err, rootId },
      'Feishu topic root sender unavailable; failure reply will not mention anyone',
    )
    return undefined
  }
}
