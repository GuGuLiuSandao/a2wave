import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'

export interface Artifact {
  id: string
  runId: string
  agentId: string | null
  userId: string | null
  filename: string
  kind: 'file' | 'directory'
  mimeType: string | null
  size: number | null
  expiresAt: string | null
  createdAt: string | null
}

export function useArtifacts(runId: string | null | undefined) {
  return useQuery({
    queryKey: ['artifacts', runId],
    queryFn: async () => {
      const res = await fetch(`/api/artifacts?runId=${runId}`, { credentials: 'include' })
      if (!res.ok) throw new Error('Failed to fetch artifacts')
      const json = (await res.json()) as { data: Artifact[] }
      return json.data
    },
    enabled: !!runId,
  })
}

export function useDeleteArtifact() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: async (id: string) => {
      const res = await fetch(`/api/artifacts/${id}`, {
        method: 'DELETE',
        credentials: 'include',
      })
      if (!res.ok) throw new Error('Failed to delete artifact')
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ['artifacts'] }),
  })
}

export function getArtifactDownloadUrl(id: string): string {
  return `/api/artifacts/${id}/download`
}
