type FeishuMessageContext = {
  chat_type?: string
  chat_id?: string
  thread_id?: string
  root_id?: string
  message_id?: string
  quote_message_id?: string
}

/**
 * Build the stable session key used to continue a Feishu conversation.
 * Topics use thread_id, direct messages use chat_id, and ordinary group reply
 * chains fall back through root_id to the current message_id.
 */
export function buildTriggerSessionId(message: FeishuMessageContext): string | null {
  if (message.thread_id) return message.thread_id
  if (message.chat_type === 'p2p') return message.chat_id ?? null
  if (message.root_id) return message.root_id
  if (message.message_id) return message.message_id
  return null
}

/** Keep chained replies anchored to the original question when one is available. */
export function quoteAnchorId(message: FeishuMessageContext): string {
  return (message.quote_message_id ?? message.message_id) as string
}
