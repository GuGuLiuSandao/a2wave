import { beforeEach, describe, expect, it } from 'vitest'
import { isReady, markReady, resetReadinessForTests } from '../readiness.js'

describe('readiness state', () => {
  beforeEach(() => {
    resetReadinessForTests()
  })

  it('starts out not ready', async () => {
    // The port can be bound before boot-time seeding finishes; until it does,
    // the process must not claim it can serve correct answers.
    expect(isReady()).toBe(false)
  })

  it('reports ready once boot completes', async () => {
    markReady()
    expect(isReady()).toBe(true)
  })

  it('stays ready when marked more than once', async () => {
    markReady()
    markReady()
    expect(isReady()).toBe(true)
  })
})
