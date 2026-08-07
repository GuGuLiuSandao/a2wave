import { TaskState } from '@a2a-js/sdk'

const INVOCATION_END_STATES = new Set([
  TaskState.TASK_STATE_COMPLETED,
  TaskState.TASK_STATE_FAILED,
  TaskState.TASK_STATE_CANCELED,
  TaskState.TASK_STATE_REJECTED,
  TaskState.TASK_STATE_INPUT_REQUIRED,
  TaskState.TASK_STATE_AUTH_REQUIRED,
])

export function endsCurrentInvocation(state: TaskState | undefined): boolean {
  return state !== undefined && INVOCATION_END_STATES.has(state)
}

export function taskFailureLabel(state: TaskState | undefined): string | undefined {
  switch (state) {
    case TaskState.TASK_STATE_FAILED:
      return 'failed'
    case TaskState.TASK_STATE_CANCELED:
      return 'canceled'
    case TaskState.TASK_STATE_REJECTED:
      return 'rejected'
    case TaskState.TASK_STATE_INPUT_REQUIRED:
      return 'requires additional input'
    case TaskState.TASK_STATE_AUTH_REQUIRED:
      return 'requires authentication'
    default:
      return undefined
  }
}
