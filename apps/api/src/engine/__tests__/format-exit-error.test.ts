import { describe, expect, it } from 'vitest'
import { formatExitError } from '../cursor-agent.js'

describe('formatExitError', () => {
  it('returns friendly message for known exit codes', async () => {
    expect(formatExitError(143, '')).toBe('Execution cancelled')
    expect(formatExitError(137, '')).toBe('Process forcibly terminated (out of memory or timeout)')
    expect(formatExitError(130, '')).toBe('User interrupted execution (Ctrl+C)')
    expect(formatExitError(127, '')).toBe('Command not found')
    expect(formatExitError(126, '')).toBe('Permission denied, cannot execute')
    expect(formatExitError(1, '')).toBe('Execution failed')
  })

  it('returns generic message for unknown exit codes', async () => {
    expect(formatExitError(42, '')).toBe('Execution error (code 42)')
    expect(formatExitError(255, '')).toBe('Execution error (code 255)')
  })

  it('appends stderr when present', async () => {
    expect(formatExitError(143, 'some error details')).toBe(
      'Execution cancelled\nDetails: some error details',
    )
    expect(formatExitError(127, 'command not found: foo')).toBe(
      'Command not found\nDetails: command not found: foo',
    )
  })

  it('trims whitespace from stderr', async () => {
    expect(formatExitError(1, '  error with spaces  ')).toBe(
      'Execution failed\nDetails: error with spaces',
    )
    expect(formatExitError(1, '\n\n')).toBe('Execution failed')
  })

  it('handles empty stderr gracefully', async () => {
    expect(formatExitError(143, '')).toBe('Execution cancelled')
    expect(formatExitError(143, '   ')).toBe('Execution cancelled')
  })
})
