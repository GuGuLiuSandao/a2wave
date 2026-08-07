/**
 * Structured failure reasons for runs that fail outside the normal execution
 * path (e.g. server restart cleanup). Written into runs.result.error as a
 * machine-readable object so callers can distinguish retryable signals from
 * genuine execution errors.
 *
 * Normal execution errors still flow through run-lifecycle.finishRunError and
 * keep their free-form message shape — only startup recovery uses these codes.
 */
export type FailureReasonCode =
  | 'SERVER_RESTART_DURING_EXEC'
  | 'PENDING_ORPHAN_ON_STARTUP'
  | 'FEISHU_QUEUED_RESET_FOR_REPLAY'
  | 'REPLACED_BY_REPLAY'
  | 'DANGLING_RUN_ON_STARTUP'

export interface FailureReason {
  code: FailureReasonCode
  message: string
  retryable: boolean
}

export const FAILURE_REASONS: Record<FailureReasonCode, FailureReason> = {
  SERVER_RESTART_DURING_EXEC: {
    code: 'SERVER_RESTART_DURING_EXEC',
    message: 'Interrupted by a server restart; safe to retry',
    retryable: true,
  },
  PENDING_ORPHAN_ON_STARTUP: {
    code: 'PENDING_ORPHAN_ON_STARTUP',
    message: 'Interrupted before entering the execution queue; can be triggered again',
    retryable: true,
  },
  FEISHU_QUEUED_RESET_FOR_REPLAY: {
    code: 'FEISHU_QUEUED_RESET_FOR_REPLAY',
    message:
      'Queued Feishu task was rebuilt by message replay after a restart; the original record is marked failed',
    retryable: true,
  },
  REPLACED_BY_REPLAY: {
    code: 'REPLACED_BY_REPLAY',
    message: 'Feishu message replay replaced a task left unfinished before the restart',
    retryable: false,
  },
  DANGLING_RUN_ON_STARTUP: {
    code: 'DANGLING_RUN_ON_STARTUP',
    message: 'The associated Agent no longer exists; archived during startup recovery',
    retryable: false,
  },
}
