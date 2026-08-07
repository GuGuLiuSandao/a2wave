/**
 * Covers formatExitError — a small pure helper not exercised by the other
 * cursor-agent tests.
 */
import { describe, expect, it, vi } from 'vitest'

vi.mock('../../lib/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}))

import { formatExitError } from '../cursor-agent.js'

describe('formatExitError', () => {
  it.each([
    [1, 'Execution failed'],
    [2, 'Command argument error'],
    [126, 'Permission denied'],
    [127, 'Command not found'],
    [128, 'Invalid exit signal'],
    [130, 'Ctrl\\+C'],
    [137, 'forcibly terminated'],
    [143, 'Execution cancelled'],
  ])('maps exit code %s to its friendly message', (code, expected) => {
    expect(formatExitError(code as number, '')).toMatch(new RegExp(expected as string))
  })

  it('falls back to a generic message for unknown codes', async () => {
    expect(formatExitError(99, '')).toMatch(/code 99/)
  })

  it('appends a trimmed stderr when present', async () => {
    expect(formatExitError(1, '  boom  \n')).toBe('Execution failed\nDetails: boom')
  })

  it('omits the details section when stderr is empty/whitespace', async () => {
    expect(formatExitError(1, '   ')).toBe('Execution failed')
  })
})
