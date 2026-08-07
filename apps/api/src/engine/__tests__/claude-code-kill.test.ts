import { beforeEach, describe, expect, it, vi } from 'vitest'

const { cancelMock } = vi.hoisted(() => ({
  cancelMock: vi.fn(),
}))

vi.mock('../cli-process-runner.js', () => ({
  cliProcessRunner: {
    cancel: cancelMock,
  },
}))

import { ClaudeCodeEngine } from '../claude-code.js'

const engineConfig = {
  path: 'claude',
  apiKey: '',
  baseUrl: '',
  timeoutMinutes: 5,
  force: false,
  approveMcps: false,
  defaultWorkDir: '/tmp',
}

describe('ClaudeCodeEngine process delegation', () => {
  beforeEach(() => {
    cancelMock.mockReset()
  })

  it('delegates task cancellation to the global process runner', async () => {
    cancelMock.mockReturnValueOnce(true)
    const engine = new ClaudeCodeEngine(engineConfig)

    expect(engine.kill('task_1')).toBe(true)
    expect(cancelMock).toHaveBeenCalledWith('task_1')
  })

  it('returns false when no global task matches', async () => {
    cancelMock.mockReturnValueOnce(false)
    const engine = new ClaudeCodeEngine(engineConfig)

    expect(engine.kill('missing')).toBe(false)
  })
})
