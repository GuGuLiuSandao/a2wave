import { beforeEach, describe, expect, it } from 'vitest'
import {
  _resetExecutionLeasesForTests,
  beginExecutionLease,
  bindExecutionLeaseTask,
  cancelExecutionLease,
  completeExecutionLease,
  countActiveExecutionLeases,
  getExecutionAbortSignal,
  hasExecutionLease,
  reserveExecutionLease,
} from '../execution-lease-registry.js'

describe('execution lease registry', () => {
  beforeEach(() => {
    _resetExecutionLeasesForTests()
  })

  it('keeps a cancelled execution in the concurrency count until it finishes', async () => {
    const lease = beginExecutionLease('run_1', 'task_1', 'agt_1')

    const cancellation = cancelExecutionLease('run_1')

    expect(cancellation).not.toBeNull()
    expect(lease.signal.aborted).toBe(true)
    expect(countActiveExecutionLeases('agt_1')).toBe(1)

    let cancellationSettled = false
    void cancellation?.then(() => {
      cancellationSettled = true
    })
    await Promise.resolve()
    expect(cancellationSettled).toBe(false)

    lease.finish()
    await expect(cancellation).resolves.toBeUndefined()
    expect(countActiveExecutionLeases('agt_1')).toBe(0)
  })

  it('keeps a terminal run in the concurrency count through lifecycle cleanup', async () => {
    const lease = reserveExecutionLease('run_1', 'agt_1')

    expect(countActiveExecutionLeases('agt_1')).toBe(1)

    lease.finish()
    expect(countActiveExecutionLeases('agt_1')).toBe(0)
  })

  it('exposes the cancellation signal by task id and removes it on finish', async () => {
    const lease = beginExecutionLease('run_1', 'task_1', 'agt_1')

    expect(getExecutionAbortSignal('task_1')).toBe(lease.signal)

    lease.finish()

    expect(getExecutionAbortSignal('task_1')).toBeUndefined()
  })

  it('does not create an unresolved tombstone when cancellation has no active lease', async () => {
    await expect(cancelExecutionLease('run_missing')).resolves.toBeUndefined()
    expect(hasExecutionLease('run_missing')).toBe(false)
    expect(countActiveExecutionLeases('agt_1')).toBe(0)
  })

  it('binds a task to a slot lease reserved before async preparation', async () => {
    const reserved = reserveExecutionLease('run_1', 'agt_1')
    const bound = bindExecutionLeaseTask('run_1', 'task_1', 'agt_1')

    expect(bound.signal).toBe(reserved.signal)
    expect(getExecutionAbortSignal('task_1')).toBe(reserved.signal)

    reserved.finish()
  })
})
