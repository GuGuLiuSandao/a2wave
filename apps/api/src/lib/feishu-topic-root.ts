import { basename } from 'node:path'

export type FeishuMessageIdentity = {
  chat_type?: string
  thread_id?: string
  root_id?: string
  message_id?: string
}

export type FeishuTopicReplyMentionTarget = 'trigger_sender' | 'topic_creator' | 'none'

export type FeishuMessageSender = {
  id?: string
  id_type?: string
  sender_type?: string
}

/** Return the root message ID only for a group topic reply below the root. */
export function resolveFeishuTopicRootMessageId(
  message: FeishuMessageIdentity,
): string | undefined {
  if (message.chat_type !== 'group' || !message.thread_id) return undefined
  if (!message.root_id || message.root_id === message.message_id) return undefined
  return message.root_id
}

/** Return the root only when its content should be injected into the Agent prompt. */
export function resolveFeishuTopicRootId(
  enabled: boolean,
  keepNativePrompt: boolean,
  message: FeishuMessageIdentity,
): string | undefined {
  if (keepNativePrompt || !enabled) return undefined
  return resolveFeishuTopicRootMessageId(message)
}

/**
 * Select the real Feishu open_id to mention in a reply.
 *
 * Scope differs by target on purpose. `trigger_sender` and `topic_creator` answer
 * "whom do we mention", a question an ordinary group reply cannot ask — there is no
 * topic and so no creator — so both keep the historical trigger-sender behaviour there.
 * `none` answers "do we mention at all", which every group reply can ask, so it applies
 * to all of them; scoping the opt-out to topics would leave the switch half-applied.
 *
 * A failed creator lookup deliberately returns undefined instead of falling back to the
 * triggering bot, which would notify the wrong party.
 *
 * `topic_creator` can therefore mention someone other than the person who triggered this
 * turn. That cross-author mention is intended and was confirmed in review: it is opt-in,
 * it can only ever name the root message's sender, and Feishu already governs who may be
 * mentioned inside a group. Reviewers keep re-raising it — it is a decision, not an oversight.
 */
export function resolveFeishuReplyMentionOpenId(
  target: FeishuTopicReplyMentionTarget,
  message: FeishuMessageIdentity,
  triggerSenderOpenId?: string,
  rootSender?: FeishuMessageSender,
): string | undefined {
  if (message.chat_type === 'p2p') return undefined
  if (target === 'none') return undefined
  if (!message.thread_id) return triggerSenderOpenId
  if (target === 'trigger_sender') return triggerSenderOpenId

  const rootMessageId = resolveFeishuTopicRootMessageId(message)
  if (!rootMessageId) return triggerSenderOpenId
  if (
    rootSender?.sender_type !== 'user' ||
    rootSender.id_type !== 'open_id' ||
    !rootSender.id?.trim()
  ) {
    return undefined
  }
  return rootSender.id
}

export function mergeFeishuTopicRootText(rootText: string, replyText: string): string {
  if (!rootText) return replyText
  return replyText ? `${rootText}\n\n---\n${replyText}` : rootText
}

export function buildFeishuFileHint(fileName: string | undefined, filePath: string): string {
  const normalizedName = fileName?.trim()
  const label = normalizedName ? `[文件] ${basename(normalizedName)}` : '[文件]'
  return `${label}\n文件路径：${filePath}`
}
