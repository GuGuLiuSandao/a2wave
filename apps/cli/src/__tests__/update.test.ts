import { execFileSync } from 'node:child_process'
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('node:child_process', () => ({
  execFileSync: vi.fn(),
}))

vi.mock('../version.js', () => ({
  getVersion: vi.fn(() => '0.2.0'),
  getPackageName: vi.fn(() => 'my-cli'),
}))

const { getVersion, getPackageName } = await import('../version.js')
const mockedExecFileSync = vi.mocked(execFileSync)
const mockedGetVersion = vi.mocked(getVersion)
const mockedGetPackageName = vi.mocked(getPackageName)

// We need to extract the run function from the command definition.
// defineCommand is called at import time, so we mock citty to capture args.
let capturedRun: () => Promise<void>

vi.mock('citty', () => ({
  defineCommand: vi.fn((opts: { run: () => Promise<void> }) => {
    capturedRun = opts.run
    return opts
  }),
}))

await import('../commands/update.js')

describe('updateCommand', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockedExecFileSync.mockReset().mockReturnValue('')
    mockedGetVersion.mockReturnValue('0.2.0')
    mockedGetPackageName.mockReturnValue('my-cli')
    Reflect.deleteProperty(process.env, 'A2WAVE_NPM_REGISTRY')
  })

  it('prints up-to-date message when versions match', async () => {
    mockedExecFileSync.mockReturnValue('0.2.0\n')
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})

    await capturedRun()

    expect(logSpy).toHaveBeenCalledWith('Already up to date (v0.2.0)')
    logSpy.mockRestore()
  })

  it('runs npm install when an update is available', async () => {
    mockedExecFileSync.mockReturnValueOnce('0.3.0\n')
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})

    await capturedRun()

    expect(logSpy).toHaveBeenCalledWith('Updating v0.2.0 → v0.3.0...')
    expect(mockedExecFileSync).toHaveBeenCalledWith('npm', ['i', '-g', 'my-cli@latest'], {
      stdio: 'inherit',
    })
    logSpy.mockRestore()
  })

  it('queries the latest version against the npm default registry', async () => {
    mockedExecFileSync.mockReturnValue('0.2.0\n')
    vi.spyOn(console, 'log').mockImplementation(() => {})

    await capturedRun()

    expect(mockedExecFileSync).toHaveBeenCalledWith('npm', ['view', 'my-cli', 'version'], {
      encoding: 'utf-8',
    })
  })

  it('uses A2WAVE_NPM_REGISTRY when one is configured', async () => {
    process.env.A2WAVE_NPM_REGISTRY = 'https://mirror.example.org'
    mockedExecFileSync.mockReturnValueOnce('0.3.0\n')
    vi.spyOn(console, 'log').mockImplementation(() => {})

    await capturedRun()

    expect(mockedExecFileSync).toHaveBeenCalledWith(
      'npm',
      ['view', 'my-cli', 'version', '--registry', 'https://mirror.example.org'],
      { encoding: 'utf-8' },
    )
    expect(mockedExecFileSync).toHaveBeenCalledWith(
      'npm',
      ['i', '-g', 'my-cli@latest', '--registry', 'https://mirror.example.org'],
      { stdio: 'inherit' },
    )
  })

  it('passes shell metacharacters in the registry as one literal npm argument', async () => {
    const registry = 'https://mirror.example.org/; touch /tmp/a2wave-pwned'
    process.env.A2WAVE_NPM_REGISTRY = registry
    mockedExecFileSync.mockReturnValueOnce('0.3.0\n')
    vi.spyOn(console, 'log').mockImplementation(() => {})

    await capturedRun()

    expect(mockedExecFileSync).toHaveBeenNthCalledWith(
      1,
      'npm',
      ['view', 'my-cli', 'version', '--registry', registry],
      { encoding: 'utf-8' },
    )
    expect(mockedExecFileSync).toHaveBeenNthCalledWith(
      2,
      'npm',
      ['i', '-g', 'my-cli@latest', '--registry', registry],
      { stdio: 'inherit' },
    )
  })

  it('fails with a clear error when the package name cannot be resolved', async () => {
    mockedGetPackageName.mockReturnValue(null)
    vi.spyOn(console, 'log').mockImplementation(() => {})

    await expect(capturedRun()).rejects.toThrow(/package\.json/)
    expect(mockedExecFileSync).not.toHaveBeenCalled()
  })

  // Regression guard: the CLI is published publicly, so no internal package
  // scope, registry host or private-registry setup step may ever surface in
  // user-facing output. Matches a bare scope mention, not just npmrc syntax.
  it('never leaks an internal scope or registry into user-facing output', async () => {
    process.env.A2WAVE_NPM_REGISTRY = 'https://mirror.example.org'
    mockedExecFileSync.mockReturnValueOnce('0.3.0\n')
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})

    await capturedRun()

    const allOutput = [...logSpy.mock.calls, ...warnSpy.mock.calls].flat().join('\n')
    expect(allOutput).not.toMatch(/@lilith|lilithgame|cnpm|atlas-skillhub|npm config set/i)
    logSpy.mockRestore()
    warnSpy.mockRestore()
  })

  it('reports a generic registry auth error with the resolved registry on 401/403', async () => {
    process.env.A2WAVE_NPM_REGISTRY = 'https://mirror.example.org'
    mockedExecFileSync.mockImplementation(() => {
      throw new Error('npm error code E401 Unauthorized')
    })
    vi.spyOn(console, 'log').mockImplementation(() => {})

    const failure = await capturedRun().catch((err: Error) => err)
    expect(failure).toBeInstanceOf(Error)
    const message = (failure as Error).message
    expect(message).toContain('authentication failed')
    expect(message).toContain('https://mirror.example.org')
    // 公司 = "company", 私有 = "private" — an auth error must not hint at an
    // internal registry, since the CLI now targets public npm.
    expect(message).not.toMatch(/cnpm|private registry|internal registry|公司|私有/i)
  })

  it('mentions the npm default registry in auth errors when no registry is configured', async () => {
    mockedExecFileSync.mockImplementation(() => {
      throw new Error('npm error code E403 Forbidden')
    })
    vi.spyOn(console, 'log').mockImplementation(() => {})

    const failure = await capturedRun().catch((err: Error) => err)
    expect(failure).toBeInstanceOf(Error)
    expect((failure as Error).message).toContain('npm default registry')
  })

  it('throws CliError on failure', async () => {
    mockedExecFileSync.mockImplementation(() => {
      throw new Error('network error')
    })
    vi.spyOn(console, 'log').mockImplementation(() => {})

    await expect(capturedRun()).rejects.toThrow('Update failed: network error')
  })
})
