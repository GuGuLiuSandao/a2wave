import { beforeEach, describe, expect, it, vi } from 'vitest'

const { cancelMock } = vi.hoisted(() => ({
  cancelMock: vi.fn(),
}))

vi.mock('../cli-process-runner.js', () => ({
  cliProcessRunner: {
    cancel: cancelMock,
  },
}))

import { CursorAgentEngine } from '../cursor-agent.js'

const engineConfig = {
  apiKey: 'test-key',
  timeoutMinutes: 5,
  agentForce: false,
  approveMcps: false,
  defaultWorkDir: '/tmp',
}

describe('CursorAgentEngine process delegation', () => {
  beforeEach(() => {
    cancelMock.mockReset()
  })

  it('delegates task cancellation to the global process runner', async () => {
    cancelMock.mockReturnValueOnce(true)
    const engine = new CursorAgentEngine(engineConfig)

    expect(engine.kill('task_1')).toBe(true)
    expect(cancelMock).toHaveBeenCalledWith('task_1')
  })
})
