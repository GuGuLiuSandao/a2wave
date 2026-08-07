import { api } from '@/lib/api'
import type { HistoryAttachmentRef } from '@/lib/attachments'
import type { ChatMessage, Run } from '@a2wave/shared'
import { useQuery } from '@tanstack/react-query'

/** 历史消息：user 消息可能带附件 refs（token 可选——A2A bytes/uri 无 token），供历史里回显预览。 */
export type ChatMessageWithAttachments = ChatMessage & { attachments?: HistoryAttachmentRef[] }

/** Agent 会话摘要 */
export interface AgentChat {
  id: string
  intent: string
  status: string
  result: Record<string, unknown> | null
  createdAt: string
  updatedAt: string
  messageCount: number
}

const CHATS_KEY = (agentId: string) => ['agents', agentId, 'chats'] as const
const MESSAGES_KEY = (agentId: string, runId: string) =>
  ['agents', agentId, 'chats', runId, 'messages'] as const

/** 获取 Agent 的会话列表（按时间倒序） */
export function useAgentChats(agentId: string | undefined) {
  return useQuery({
    queryKey: CHATS_KEY(agentId ?? ''),
    queryFn: () => api.get<AgentChat[]>(`/agents/${agentId}/chats`),
    select: (res) => res.data,
    enabled: !!agentId,
  })
}

/** 获取指定会话的消息列表 */
export function useChatMessages(agentId: string | undefined, runId: string | undefined) {
  return useQuery({
    queryKey: MESSAGES_KEY(agentId ?? '', runId ?? ''),
    queryFn: () =>
      api.get<{ run: Run; messages: ChatMessageWithAttachments[] }>(
        `/agents/${agentId}/chats/${runId}/messages`,
      ),
    select: (res) => res.data,
    enabled: !!agentId && !!runId,
  })
}
