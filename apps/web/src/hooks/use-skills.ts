import { api } from '@/lib/api'
import type {
  CreateSkillInput,
  InstallRemoteSkillsInput,
  RemoteSkillInspection,
  RemoteSkillUpdateCheck,
  RemoteSkillUpdateResult,
  Skill,
  SkillVisibility,
  UpdateRemoteSkillInput,
  UpdateSkillInput,
} from '@a2wave/shared'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'

const SKILLS_KEY = ['skills'] as const
const SKILL_GROUPS_KEY = ['skill-groups'] as const

export type SkillFileEntry = {
  name: string
  type: 'file' | 'directory'
  size?: number
  entries?: SkillFileEntry[]
}

export function useSkills(params?: { page?: number; pageSize?: number }) {
  const { page = 1, pageSize = 50 } = params ?? {}
  return useQuery({
    queryKey: [...SKILLS_KEY, page, pageSize],
    queryFn: () => api.list<Skill>(`/skills?page=${page}&pageSize=${pageSize}`),
    staleTime: 0,
    refetchOnMount: 'always',
    refetchOnWindowFocus: 'always',
  })
}

export function useSkill(id: string) {
  return useQuery({
    queryKey: [...SKILLS_KEY, id],
    queryFn: () => api.get<Skill>(`/skills/${id}`),
    select: (res) => res.data,
    enabled: !!id,
  })
}

export function useCreateSkill() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (input: CreateSkillInput) => api.post<Skill>('/skills', input),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: SKILLS_KEY })
      qc.invalidateQueries({ queryKey: SKILL_GROUPS_KEY })
    },
  })
}

export function useUpdateSkill() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: ({ id, ...input }: UpdateSkillInput & { id: string }) =>
      api.patch<Skill>(`/skills/${id}`, input),
    onSuccess: (_, variables) => {
      qc.invalidateQueries({ queryKey: SKILLS_KEY })
      qc.invalidateQueries({ queryKey: [...SKILLS_KEY, variables.id] })
      qc.invalidateQueries({ queryKey: SKILL_GROUPS_KEY })
    },
  })
}

export function useDeleteSkill() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (id: string) => api.delete<Skill>(`/skills/${id}`),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: SKILLS_KEY })
      qc.invalidateQueries({ queryKey: SKILL_GROUPS_KEY })
    },
  })
}

export function useUploadSkill() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: async ({ file, visibility }: { file: File; visibility: SkillVisibility }) => {
      const formData = new FormData()
      formData.append('file', file)
      formData.append('visibility', visibility)
      const res = await api.upload<Skill>('/skills/upload', formData)
      return res
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: SKILLS_KEY }),
  })
}

export function useUploadSkillFolder() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: async ({
      files,
      paths,
      visibility,
    }: {
      files: File[]
      paths: string[]
      visibility: SkillVisibility
    }) => {
      const formData = new FormData()
      for (const file of files) formData.append('files', file)
      for (const path of paths) formData.append('paths', path)
      formData.append('visibility', visibility)
      return api.upload<Skill>('/skills/upload', formData)
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: SKILLS_KEY }),
  })
}

export function useInspectRemoteSkills() {
  return useMutation({
    mutationFn: (url: string) => api.post<RemoteSkillInspection>('/skills/remote/inspect', { url }),
  })
}

export function useInstallRemoteSkills() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (input: InstallRemoteSkillsInput) =>
      api.post<Skill[]>('/skills/remote/install', input),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: SKILLS_KEY })
      qc.invalidateQueries({ queryKey: SKILL_GROUPS_KEY })
    },
  })
}

export function useCheckRemoteSkillUpdate() {
  return useMutation({
    mutationFn: (skillId: string) =>
      api.post<RemoteSkillUpdateCheck>(`/skills/${skillId}/remote/check`, {}),
  })
}

export function useRemoteSkillUpdate() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: ({ skillId, ...input }: UpdateRemoteSkillInput & { skillId: string }) =>
      api.post<RemoteSkillUpdateResult>(`/skills/${skillId}/remote/update`, input),
    onSuccess: (_, variables) => {
      qc.invalidateQueries({ queryKey: SKILLS_KEY })
      qc.invalidateQueries({ queryKey: [...SKILLS_KEY, variables.skillId] })
      qc.invalidateQueries({ queryKey: [...SKILLS_KEY, variables.skillId, 'files'] })
    },
  })
}

export function useUploadSkillFiles() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: async ({
      skillId,
      files,
      paths,
      replace,
    }: {
      skillId: string
      files: File[]
      paths?: string[]
      replace?: boolean
    }) => {
      const formData = new FormData()
      for (const file of files) {
        formData.append('files', file)
      }
      for (const path of paths ?? []) {
        formData.append('paths', path)
      }
      const query = replace ? '?replace=true' : ''
      return api.upload<{ uploaded: number }>(`/skills/${skillId}/files/upload${query}`, formData)
    },
    onSuccess: (_, variables) => {
      qc.invalidateQueries({ queryKey: [...SKILLS_KEY, variables.skillId] })
      qc.invalidateQueries({ queryKey: [...SKILLS_KEY, variables.skillId, 'files'] })
      qc.invalidateQueries({ queryKey: SKILLS_KEY })
    },
  })
}

export function useReuploadSkill() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: async ({
      skillId,
      file,
      files,
      paths,
    }: {
      skillId: string
      /** 单文件模式（.md / .zip） */
      file?: File
      /** 文件夹模式：与 paths 同序，复用 /reupload 的 files[]+paths[] 分支 */
      files?: File[]
      paths?: string[]
    }) => {
      const formData = new FormData()
      if (files && files.length > 0) {
        for (const f of files) formData.append('files', f)
        for (const p of paths ?? []) formData.append('paths', p)
      } else if (file) {
        formData.append('file', file)
      } else {
        throw new Error('No file or folder provided for reupload')
      }
      return api.upload<Skill>(`/skills/${skillId}/reupload`, formData)
    },
    onSuccess: (_, variables) => {
      qc.invalidateQueries({ queryKey: [...SKILLS_KEY, variables.skillId] })
      qc.invalidateQueries({ queryKey: [...SKILLS_KEY, variables.skillId, 'files'] })
      qc.invalidateQueries({ queryKey: SKILLS_KEY })
    },
  })
}

export function useSkillFiles(skillId: string | undefined, enabled: boolean) {
  return useQuery({
    queryKey: [...SKILLS_KEY, skillId, 'files'],
    queryFn: async () => {
      const res = await api.get<{ path: string; entries: SkillFileEntry[] }>(
        `/skills/${skillId}/files`,
      )
      return res.data
    },
    enabled: !!skillId && enabled,
  })
}
