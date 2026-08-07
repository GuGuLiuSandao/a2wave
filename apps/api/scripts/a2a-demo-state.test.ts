import { TaskState } from '@a2a-js/sdk'
import { describe, expect, it } from 'vitest'
import { endsCurrentInvocation, taskFailureLabel } from './a2a-demo-state.js'

describe('A2A demo task states', () => {
  it.each([
    TaskState.TASK_STATE_COMPLETED,
    TaskState.TASK_STATE_FAILED,
    TaskState.TASK_STATE_CANCELED,
    TaskState.TASK_STATE_REJECTED,
    TaskState.TASK_STATE_INPUT_REQUIRED,
    TaskState.TASK_STATE_AUTH_REQUIRED,
  ])('ends the current invocation for state %s', (state) => {
    expect(endsCurrentInvocation(state)).toBe(true)
  })

  it.each([TaskState.TASK_STATE_SUBMITTED, TaskState.TASK_STATE_WORKING])(
    'keeps waiting for non-terminal state %s',
    (state) => {
      expect(endsCurrentInvocation(state)).toBe(false)
    },
  )

  it('classifies interrupted states as actionable failures', () => {
    expect(taskFailureLabel(TaskState.TASK_STATE_INPUT_REQUIRED)).toBe('requires additional input')
    expect(taskFailureLabel(TaskState.TASK_STATE_AUTH_REQUIRED)).toBe('requires authentication')
    expect(taskFailureLabel(TaskState.TASK_STATE_COMPLETED)).toBeUndefined()
  })
})
