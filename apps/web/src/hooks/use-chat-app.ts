import { api } from '@/lib/api'
import { useQuery } from '@tanstack/react-query'

/**
 * Public-facing profile for the chat app page.
 *
 * Mirrors `GET /api/agents/:id/chat-app` — presentation fields only, no
 * credentials or channel configs, so it is safe to render on a link that gets
 * forwarded around inside the company.
 */
export interface ChatAppProfile {
  id: string
  name: string
  description: string | null
  icon: string
  status: string
  publishStatus: string
  createdAt: string
  creator: { name: string } | null
  welcomeMessage: string | null
  suggestedQuestions: string[]
  showCreator: boolean
  allowAttachments: boolean
  showThinking: boolean
}

export const CHAT_APP_KEY = (agentId: string) => ['agents', agentId, 'chat-app'] as const

export function useChatAppProfile(agentId: string | undefined) {
  return useQuery({
    queryKey: CHAT_APP_KEY(agentId ?? ''),
    queryFn: () => api.get<ChatAppProfile>(`/agents/${agentId}/chat-app`),
    select: (res) => res.data,
    enabled: !!agentId,
    // A disabled or missing channel is a 404 and will not become available by
    // retrying; surface it immediately as the "unavailable" state.
    retry: false,
  })
}
