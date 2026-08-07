import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// Resolves by default: production is `async` and the scheduler now attaches
// `.catch()` to the returned promise. A mock returning `undefined` (as this one
// did) hides that shape entirely — the same mock drift that let the gateway 424
// tests pass against a dead catch block.
const { mockDeleteExpiredArtifacts, mockLoggerError } = vi.hoisted(() => ({
  mockDeleteExpiredArtifacts: vi.fn(async () => {}),
  mockLoggerError: vi.fn(),
}))

vi.mock('../artifact-storage.js', () => ({
  deleteExpiredArtifacts: mockDeleteExpiredArtifacts,
}))

vi.mock('../logger.js', () => ({
  logger: { info: vi.fn(), error: mockLoggerError, warn: vi.fn() },
}))

import { startArtifactCleanupScheduler } from '../artifact-cleanup.js'

describe('startArtifactCleanupScheduler', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    mockDeleteExpiredArtifacts.mockReset()
    mockDeleteExpiredArtifacts.mockResolvedValue(undefined)
    mockLoggerError.mockReset()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('does not call deleteExpiredArtifacts immediately on start', async () => {
    startArtifactCleanupScheduler()
    expect(mockDeleteExpiredArtifacts).not.toHaveBeenCalled()
  })

  it('calls deleteExpiredArtifacts after 1 hour', async () => {
    startArtifactCleanupScheduler()
    vi.advanceTimersByTime(60 * 60 * 1000)
    expect(mockDeleteExpiredArtifacts).toHaveBeenCalledTimes(1)
  })

  it('calls deleteExpiredArtifacts repeatedly every hour', async () => {
    startArtifactCleanupScheduler()
    vi.advanceTimersByTime(3 * 60 * 60 * 1000)
    expect(mockDeleteExpiredArtifacts).toHaveBeenCalledTimes(3)
  })

  it('logs an error when deleteExpiredArtifacts REJECTS', async () => {
    // Rejection, not a synchronous throw. `deleteExpiredArtifacts` is async, so a
    // synchronous try/catch around it catches nothing and the rejection escapes
    // as an unhandled one — with no process-level handler, a database blip during
    // the hourly sweep could terminate the API.
    mockDeleteExpiredArtifacts.mockRejectedValue(new Error('DB error'))

    startArtifactCleanupScheduler()
    vi.advanceTimersByTime(60 * 60 * 1000)
    // Let the rejection settle: .catch() runs on a microtask, which the timer
    // advance above does not itself flush.
    await Promise.resolve()
    await Promise.resolve()

    expect(mockLoggerError).toHaveBeenCalledWith(
      expect.objectContaining({ err: expect.any(Error) }),
      'Artifact cleanup failed',
    )
  })
})
