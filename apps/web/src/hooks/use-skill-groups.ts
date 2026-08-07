import { api } from '@/lib/api'
import type { CreateSkillGroupInput, SkillGroup, UpdateSkillGroupInput } from '@a2wave/shared'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'

const GROUPS_KEY = ['skill-groups'] as const

export function useSkillGroups(params?: { page?: number; pageSize?: number }) {
  const { page = 1, pageSize = 500 } = params ?? {}
  return useQuery({
    queryKey: [...GROUPS_KEY, page, pageSize],
    queryFn: () => api.list<SkillGroup>(`/skill-groups?page=${page}&pageSize=${pageSize}`),
    staleTime: 0,
    refetchOnMount: 'always',
    refetchOnWindowFocus: 'always',
  })
}

export function useSkillGroup(id: string) {
  return useQuery({
    queryKey: [...GROUPS_KEY, id],
    queryFn: () => api.get<SkillGroup>(`/skill-groups/${id}`),
    select: (res) => res.data,
    enabled: !!id,
  })
}

export function useSkillGroupMembers(id: string | null) {
  return useQuery({
    queryKey: [...GROUPS_KEY, id, 'skills'],
    queryFn: () => api.get<string[]>(`/skill-groups/${id}/skills`),
    select: (res) => res.data,
    enabled: !!id,
  })
}

export function useCreateSkillGroup() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (input: CreateSkillGroupInput) => api.post<SkillGroup>('/skill-groups', input),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: GROUPS_KEY })
      qc.invalidateQueries({ queryKey: ['skills'] })
    },
  })
}

export function useUpdateSkillGroup() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: ({ id, ...input }: UpdateSkillGroupInput & { id: string }) =>
      api.patch<SkillGroup>(`/skill-groups/${id}`, input),
    onSuccess: (_, variables) => {
      qc.invalidateQueries({ queryKey: GROUPS_KEY })
      qc.invalidateQueries({ queryKey: [...GROUPS_KEY, variables.id] })
      qc.invalidateQueries({ queryKey: ['skills'] })
    },
  })
}

export function useDeleteSkillGroup() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (id: string) => api.delete<{ id: string }>(`/skill-groups/${id}`),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: GROUPS_KEY })
      qc.invalidateQueries({ queryKey: ['skills'] })
      // 删除分组会在后端清理 agent.skillGroupIds，Agent 列表也要刷新
      qc.invalidateQueries({ queryKey: ['agents'] })
    },
  })
}
