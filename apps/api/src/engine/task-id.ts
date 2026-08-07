// Single source of truth for taskId prefixes used across trigger sources
// (direct /runs/:id/start, chat, feishu, invoke). Centralised here so that
// adding a new trigger source only requires touching this file plus the new
// registration point — runs.ts cancel logic picks it up automatically via
// allTaskIdVariants().

export const TASK_ID_PREFIXES = ['', 'chat/', 'feishu/', 'invoke/'] as const

export type TaskIdPrefix = (typeof TASK_ID_PREFIXES)[number]

export function buildTaskId(prefix: TaskIdPrefix, runId: string, stepId: string): string {
  return `${prefix}${runId}/${stepId}`
}

export function allTaskIdVariants(runId: string, stepId: string): string[] {
  return TASK_ID_PREFIXES.map((p) => buildTaskId(p, runId, stepId))
}
