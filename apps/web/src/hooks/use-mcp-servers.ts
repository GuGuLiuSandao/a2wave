import { api } from '@/lib/api'
import type { CreateMcpServerInput, McpServer, UpdateMcpServerInput } from '@a2wave/shared'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'

const MCP_SERVERS_KEY = ['mcp-servers'] as const

export function useMcpServers(params?: { page?: number; pageSize?: number }) {
  const { page = 1, pageSize = 50 } = params ?? {}
  return useQuery({
    queryKey: [...MCP_SERVERS_KEY, page, pageSize],
    queryFn: () => api.list<McpServer>(`/mcp-servers?page=${page}&pageSize=${pageSize}`),
  })
}

export function useMcpServer(id: string) {
  return useQuery({
    queryKey: [...MCP_SERVERS_KEY, id],
    queryFn: () => api.get<McpServer>(`/mcp-servers/${id}`),
    select: (res) => res.data,
    enabled: !!id,
  })
}

export function useCreateMcpServer() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (input: CreateMcpServerInput) => api.post<McpServer>('/mcp-servers', input),
    onSuccess: () => qc.invalidateQueries({ queryKey: MCP_SERVERS_KEY }),
  })
}

export function useUpdateMcpServer() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: ({ id, ...input }: UpdateMcpServerInput & { id: string }) =>
      api.patch<McpServer>(`/mcp-servers/${id}`, input),
    onSuccess: (_, variables) => {
      qc.invalidateQueries({ queryKey: MCP_SERVERS_KEY })
      qc.invalidateQueries({ queryKey: [...MCP_SERVERS_KEY, variables.id] })
    },
  })
}

export function useCloneMcpServer() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (id: string) => api.post<McpServer>(`/mcp-servers/${id}/clone`, {}),
    onSuccess: () => qc.invalidateQueries({ queryKey: MCP_SERVERS_KEY }),
  })
}

export function useDeleteMcpServer() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (id: string) => api.delete<McpServer>(`/mcp-servers/${id}`),
    onSuccess: () => qc.invalidateQueries({ queryKey: MCP_SERVERS_KEY }),
  })
}

interface McpTool {
  name: string
  description?: string
  inputSchema?: unknown
}

interface ProbeToolsInput {
  type: 'stdio' | 'sse' | 'http'
  command?: string
  args?: string[]
  url?: string
  headers?: Record<string, string>
  env?: Record<string, string>
}

export function useProbeTools() {
  return useMutation({
    mutationFn: (input: ProbeToolsInput) =>
      api.post<{ tools: McpTool[] }>('/mcp-servers/probe-tools', input),
  })
}

export function useMcpServerTools(id: string, enabled: boolean) {
  return useQuery({
    queryKey: [...MCP_SERVERS_KEY, id, 'tools'],
    queryFn: () => api.get<{ tools: McpTool[] }>(`/mcp-servers/${id}/tools`),
    select: (res) => res.data.tools,
    enabled,
    retry: false,
    staleTime: Number.POSITIVE_INFINITY,
  })
}
