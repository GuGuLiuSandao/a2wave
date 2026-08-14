import { runMain } from 'citty'
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('citty', () => ({
  defineCommand: vi.fn(() => ({})),
  runMain: vi.fn(() => Promise.resolve()),
}))

vi.mock('../commands/login.js', () => ({
  loginCommand: {},
  logoutCommand: {},
}))
vi.mock('../commands/skills.js', () => ({ skillsCommand: {} }))
vi.mock('../commands/agents.js', () => ({ agentsCommand: {} }))
vi.mock('../commands/runs.js', () => ({ runsCommand: {} }))

const { handleError, runCli } = await import('../index.js')
const { CliError } = await import('../errors.js')
const { ApiError } = await import('../client.js')

describe('handleError', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('prints message and exits with 1 for CliError', () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => {
      throw new Error('process.exit')
    }) as never)

    expect(() => handleError(new CliError('something went wrong'))).toThrow('process.exit')
    expect(errorSpy).toHaveBeenCalledWith('something went wrong')
    expect(exitSpy).toHaveBeenCalledWith(1)

    errorSpy.mockRestore()
    exitSpy.mockRestore()
  })

  it('prints formatted message for ApiError', () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => {
      throw new Error('process.exit')
    }) as never)

    expect(() => handleError(new ApiError(404, 'not found'))).toThrow('process.exit')
    expect(errorSpy).toHaveBeenCalledWith('API Error (404): not found')
    expect(exitSpy).toHaveBeenCalledWith(1)

    errorSpy.mockRestore()
    exitSpy.mockRestore()
  })

  it('re-throws non-CliError errors', () => {
    const err = new Error('unexpected')
    expect(() => handleError(err)).toThrow('unexpected')
  })
})

describe('runCli', () => {
  it('prints the global version without running a nested command', () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
    vi.mocked(runMain).mockClear()

    runCli(['setup', '--version'])

    expect(logSpy).toHaveBeenCalledWith(expect.stringMatching(/^\d+\.\d+\.\d+/))
    expect(runMain).not.toHaveBeenCalled()
    logSpy.mockRestore()
  })

  it('does not treat a free-text --version value as the global version flag', () => {
    vi.mocked(runMain).mockClear()
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})

    runCli(['chat', 'send', 'my-agent', '-m', '--version'])

    expect(runMain).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ rawArgs: ['chat', 'send', 'my-agent', '-m', '--version'] }),
    )
    expect(log).not.toHaveBeenCalled()
  })
})
