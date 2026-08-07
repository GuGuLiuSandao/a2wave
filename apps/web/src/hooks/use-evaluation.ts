import { api } from '@/lib/api'
import type {
  CreateEvaluationCaseInput,
  CreateEvaluationSetInput,
  CreateEvaluationTaskInput,
  EvaluationActualTurn,
  EvaluationConfigSnapshot,
  EvaluationResultStatus,
  EvaluationReview,
  EvaluationTaskStatus,
  EvaluationTaskSummary,
  EvaluationTurn,
  ReviewEvaluationResultInput,
  UpdateEvaluationCaseInput,
  UpdateEvaluationSetInput,
} from '@a2wave/shared'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'

const EVALUATION_KEY = ['evaluation'] as const

const setsKey = (agentId: string) => [...EVALUATION_KEY, agentId, 'sets'] as const
const casesKey = (agentId: string, setId: string) =>
  [...EVALUATION_KEY, agentId, 'sets', setId, 'cases'] as const
const tasksKey = (agentId: string) => [...EVALUATION_KEY, agentId, 'tasks'] as const
const taskKey = (agentId: string, taskId: string) =>
  [...EVALUATION_KEY, agentId, 'tasks', taskId] as const

export interface EvaluationSetRow {
  id: string
  agentId: string
  name: string
  description: string | null
  createdAt: string
  updatedAt: string
}

export interface EvaluationCaseRow {
  id: string
  setId: string
  name: string
  turns: EvaluationTurn[]
  sortOrder: number
  createdAt: string
  updatedAt: string
}

export interface EvaluationTaskRow {
  id: string
  agentId: string
  setId: string | null
  setName: string
  name: string | null
  status: EvaluationTaskStatus
  configSnapshot: EvaluationConfigSnapshot
  summary: EvaluationTaskSummary | null
  error: string | null
  startedAt: string | null
  finishedAt: string | null
  createdAt: string
}

export interface EvaluationResultRow {
  id: string
  taskId: string
  caseId: string | null
  caseName: string
  turnsSnapshot: EvaluationTurn[]
  actualTurns: EvaluationActualTurn[] | null
  review: EvaluationReview | null
  status: EvaluationResultStatus
  error: string | null
  durationMs: number | null
  sortOrder: number
}

export type EvaluationTaskDetail = EvaluationTaskRow & { results: EvaluationResultRow[] }

// ------------------------------------------------------------
// Sets
// ------------------------------------------------------------

export function useEvaluationSets(agentId: string | undefined) {
  return useQuery({
    queryKey: setsKey(agentId ?? ''),
    queryFn: () => api.get<EvaluationSetRow[]>(`/agents/${agentId}/evaluation-sets`),
    enabled: Boolean(agentId),
    select: (res) => res.data,
  })
}

export function useCreateEvaluationSet(agentId: string | undefined) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (input: CreateEvaluationSetInput) =>
      api.post<EvaluationSetRow>(`/agents/${agentId}/evaluation-sets`, input),
    onSuccess: () => qc.invalidateQueries({ queryKey: setsKey(agentId ?? '') }),
  })
}

export function useUpdateEvaluationSet(agentId: string | undefined) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: ({ setId, ...input }: UpdateEvaluationSetInput & { setId: string }) =>
      api.patch<EvaluationSetRow>(`/agents/${agentId}/evaluation-sets/${setId}`, input),
    onSuccess: () => qc.invalidateQueries({ queryKey: setsKey(agentId ?? '') }),
  })
}

export function useDeleteEvaluationSet(agentId: string | undefined) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (setId: string) => api.delete(`/agents/${agentId}/evaluation-sets/${setId}`),
    onSuccess: () => qc.invalidateQueries({ queryKey: EVALUATION_KEY }),
  })
}

// ------------------------------------------------------------
// Cases
// ------------------------------------------------------------

export function useEvaluationCases(agentId: string | undefined, setId: string | undefined) {
  return useQuery({
    queryKey: casesKey(agentId ?? '', setId ?? ''),
    queryFn: () =>
      api.get<EvaluationCaseRow[]>(`/agents/${agentId}/evaluation-sets/${setId}/cases`),
    enabled: Boolean(agentId && setId),
    select: (res) => res.data,
  })
}

export function useCreateEvaluationCase(agentId: string | undefined, setId: string | undefined) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (input: CreateEvaluationCaseInput) =>
      api.post<EvaluationCaseRow>(`/agents/${agentId}/evaluation-sets/${setId}/cases`, input),
    onSuccess: () => qc.invalidateQueries({ queryKey: casesKey(agentId ?? '', setId ?? '') }),
  })
}

export function useUpdateEvaluationCase(agentId: string | undefined, setId: string | undefined) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: ({ caseId, ...input }: UpdateEvaluationCaseInput & { caseId: string }) =>
      api.patch<EvaluationCaseRow>(
        `/agents/${agentId}/evaluation-sets/${setId}/cases/${caseId}`,
        input,
      ),
    onSuccess: () => qc.invalidateQueries({ queryKey: casesKey(agentId ?? '', setId ?? '') }),
  })
}

export function useDeleteEvaluationCase(agentId: string | undefined, setId: string | undefined) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (caseId: string) =>
      api.delete(`/agents/${agentId}/evaluation-sets/${setId}/cases/${caseId}`),
    onSuccess: () => qc.invalidateQueries({ queryKey: casesKey(agentId ?? '', setId ?? '') }),
  })
}

// ------------------------------------------------------------
// Tasks
// ------------------------------------------------------------

/**
 * A task is still moving while pending, queued or running; the UI polls in that
 * state. `queued` counts: it is waiting on the agent's evaluation slots and will
 * start on its own, so the client has to keep looking to notice that it did.
 */
function isTaskActive(status: EvaluationTaskStatus | undefined): boolean {
  return status === 'pending' || status === 'queued' || status === 'running'
}

export function useEvaluationTasks(agentId: string | undefined) {
  return useQuery({
    queryKey: tasksKey(agentId ?? ''),
    queryFn: () => api.get<EvaluationTaskRow[]>(`/agents/${agentId}/evaluation-tasks`),
    enabled: Boolean(agentId),
    select: (res) => res.data,
    // Poll while any task is still running so the list reflects progress.
    refetchInterval: (query) => {
      const rows = query.state.data?.data
      return rows?.some((t) => isTaskActive(t.status)) ? 3_000 : false
    },
  })
}

export function useEvaluationTask(agentId: string | undefined, taskId: string | undefined) {
  return useQuery({
    queryKey: taskKey(agentId ?? '', taskId ?? ''),
    queryFn: () => api.get<EvaluationTaskDetail>(`/agents/${agentId}/evaluation-tasks/${taskId}`),
    enabled: Boolean(agentId && taskId),
    select: (res) => res.data,
    refetchInterval: (query) => (isTaskActive(query.state.data?.data?.status) ? 2_000 : false),
  })
}

export function useCreateEvaluationTask(agentId: string | undefined) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (input: CreateEvaluationTaskInput) =>
      api.post<EvaluationTaskRow>(`/agents/${agentId}/evaluation-tasks`, input),
    onSuccess: () => qc.invalidateQueries({ queryKey: tasksKey(agentId ?? '') }),
  })
}

export function useReviewEvaluationResult(agentId: string | undefined, taskId: string | undefined) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: ({ resultId, ...input }: ReviewEvaluationResultInput & { resultId: string }) =>
      api.patch<EvaluationResultRow>(
        `/agents/${agentId}/evaluation-tasks/${taskId}/results/${resultId}`,
        input,
      ),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: taskKey(agentId ?? '', taskId ?? '') })
      // The list shows pass rate, so it needs the recomputed summary too.
      qc.invalidateQueries({ queryKey: tasksKey(agentId ?? '') })
    },
  })
}

export function useCancelEvaluationTask(agentId: string | undefined) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (taskId: string) =>
      api.post(`/agents/${agentId}/evaluation-tasks/${taskId}/cancel`, {}),
    onSuccess: () => qc.invalidateQueries({ queryKey: EVALUATION_KEY }),
  })
}

export function useDeleteEvaluationTask(agentId: string | undefined) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (taskId: string) => api.delete(`/agents/${agentId}/evaluation-tasks/${taskId}`),
    onSuccess: () => qc.invalidateQueries({ queryKey: tasksKey(agentId ?? '') }),
  })
}
