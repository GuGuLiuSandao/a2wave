import { api } from '@/lib/api'
import type { CreateKbDocumentInput, KbDocument, UpdateKbDocumentInput } from '@a2wave/shared'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'

const KB_DOCUMENTS_KEY = ['kb-documents'] as const

export function useKbDocuments(params?: { page?: number; pageSize?: number }) {
  const { page = 1, pageSize = 50 } = params ?? {}
  return useQuery({
    queryKey: [...KB_DOCUMENTS_KEY, page, pageSize],
    queryFn: () => api.list<KbDocument>(`/kb-documents?page=${page}&pageSize=${pageSize}`),
  })
}

export function useKbDocument(id: string) {
  return useQuery({
    queryKey: [...KB_DOCUMENTS_KEY, id],
    queryFn: () => api.get<KbDocument>(`/kb-documents/${id}`),
    select: (res) => res.data,
    enabled: !!id,
    refetchInterval: (query) => {
      const raw = query.state.data as { data: KbDocument } | undefined
      const doc = raw?.data
      if (doc?.syncStatus === 'syncing') return 3_000
      if (doc?.sourceType === 'upload') return false
      return 30_000
    },
  })
}

export function useCreateKbDocument() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (input: CreateKbDocumentInput) => api.post<KbDocument>('/kb-documents', input),
    onSuccess: () => qc.invalidateQueries({ queryKey: KB_DOCUMENTS_KEY }),
    // A batch reports each failure inline in its results panel; without this the global
    // MutationCache handler would stack an identical toast per failed item on top of it.
    meta: { handleLocally: true },
  })
}

export function useUpdateKbDocument() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: ({ id, ...input }: UpdateKbDocumentInput & { id: string }) =>
      api.patch<KbDocument>(`/kb-documents/${id}`, input),
    onSuccess: (_, variables) => {
      qc.invalidateQueries({ queryKey: KB_DOCUMENTS_KEY })
      qc.invalidateQueries({ queryKey: [...KB_DOCUMENTS_KEY, variables.id] })
    },
  })
}

export function useDeleteKbDocument() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (id: string) => api.delete<KbDocument>(`/kb-documents/${id}`),
    onSuccess: () => qc.invalidateQueries({ queryKey: KB_DOCUMENTS_KEY }),
  })
}

export function useSyncKbDocument() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (id: string) => api.post<KbDocument>(`/kb-documents/${id}/sync`, {}),
    onSuccess: (_, id) => {
      qc.invalidateQueries({ queryKey: KB_DOCUMENTS_KEY })
      qc.invalidateQueries({ queryKey: [...KB_DOCUMENTS_KEY, id] })
    },
  })
}

export function useKbDocumentContent(id: string) {
  return useQuery({
    queryKey: [...KB_DOCUMENTS_KEY, id, 'content'],
    queryFn: () => api.text(`/kb-documents/${id}/content`),
    enabled: !!id,
  })
}

export function useReuploadKbDocument() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: async ({ id, file }: { id: string; file: File }) => {
      const formData = new FormData()
      formData.append('file', file)
      return api.upload<KbDocument>(`/kb-documents/${id}/reupload`, formData)
    },
    onSuccess: (_, { id }) => {
      qc.invalidateQueries({ queryKey: KB_DOCUMENTS_KEY })
      qc.invalidateQueries({ queryKey: [...KB_DOCUMENTS_KEY, id] })
      qc.invalidateQueries({ queryKey: [...KB_DOCUMENTS_KEY, id, 'content'] })
    },
  })
}

export function useUploadKbDocument() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: async (file: File) => {
      const formData = new FormData()
      formData.append('file', file)
      return api.upload<KbDocument>('/kb-documents/upload', formData)
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: KB_DOCUMENTS_KEY }),
    // Batched: failures are summarised once by the caller, not one toast per file.
    meta: { handleLocally: true },
  })
}
