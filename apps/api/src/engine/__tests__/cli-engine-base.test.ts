import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { runMock } = vi.hoisted(() => ({ runMock: vi.fn() }))

vi.mock('../cli-process-runner.js', () => ({
  cliProcessRunner: {
    run: runMock,
    cancel: vi.fn(),
  },
}))

vi.mock('../../lib/logger.js', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}))

import { BaseCliAgentEngine, type RunCliStreamOptions, stripPromptArg } from '../cli-engine-base.js'
import type { ExecuteResult, StreamExecuteRequest } from '../types.js'

class TestCliEngine extends BaseCliAgentEngine {
  readonly type = 'test-cli'
  protected readonly cliName = 'test-cli'

  constructor() {
    super({ path: 'test-cli', timeoutMinutes: 1, defaultWorkDir: '/tmp' })
  }

  runForTest(options: RunCliStreamOptions): Promise<ExecuteResult> {
    return this.runCliStream(options)
  }

  buildEnvForTest(options: Parameters<TestCliEngine['buildCredentialEnv']>[0]) {
    return this.buildCredentialEnv(options)
  }

  protected executeStreamWithModel(
    _request: StreamExecuteRequest,
    _model: string,
  ): Promise<ExecuteResult> {
    throw new Error('not used')
  }
}

describe('BaseCliAgentEngine Runner adapter', () => {
  beforeEach(() => {
    runMock.mockReset()
  })

  it('preserves the process duration reported by CliProcessRunner', async () => {
    runMock.mockResolvedValueOnce({
      reason: 'completed',
      exitCode: 0,
      signal: null,
      stderr: '',
      durationMs: 321,
    })
    const engine = new TestCliEngine()

    await expect(
      engine.runForTest({
        taskId: 'task_1',
        args: [],
        env: {},
        cwd: '/tmp',
        timeoutMs: 1_000,
        onStdoutLine: vi.fn(),
        settle: () => ({ ok: true, result: { success: true, output: 'done' } }),
      }),
    ).resolves.toEqual({ success: true, output: 'done', durationMs: 321 })
  })

  it.each(['timeout', 'cancelled'] as const)(
    'attaches parsed usage when the process ends as %s',
    async (reason) => {
      runMock.mockResolvedValueOnce({
        reason,
        exitCode: null,
        signal: 'SIGTERM',
        stderr: '',
        durationMs: 321,
      })
      const engine = new TestCliEngine()

      await expect(
        engine.runForTest({
          taskId: 'task_usage',
          args: [],
          env: {},
          cwd: '/tmp',
          timeoutMs: 1_000,
          onStdoutLine: vi.fn(),
          getUsage: () => ({ inputTokens: 12, reasoningTokens: 3 }),
          settle: () => ({ ok: true, result: { success: true, output: 'done' } }),
        }),
      ).rejects.toMatchObject({
        usage: { inputTokens: 12, reasoningTokens: 3 },
      })
    },
  )
})

describe('BaseCliAgentEngine credential env matrix', () => {
  // Mutate keys in place and delete them afterwards rather than reassigning
  // process.env: a bare replacement leaks this suite's values into every later
  // test in the same worker, and drops the env object's platform semantics
  // (Windows case-insensitivity, value coercion to string).
  const TOUCHED = [
    'SECRET_TOKEN',
    'CRED_HOME',
    'HOME',
    'PATH',
    'HTTPS_PROXY',
    'AUTH_SECRET',
    'SCM_GIT_PAT',
    'INTERNAL_ONLY_RANDOM_VALUE',
  ] as const
  const saved = new Map<string, string | undefined>()
  beforeEach(() => {
    for (const key of TOUCHED) saved.set(key, process.env[key])
  })
  afterEach(() => {
    for (const [key, value] of saved) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
    saved.clear()
  })

  it('strips protectedNames from the inherited process env', async () => {
    process.env.SECRET_TOKEN = 'from-host'
    const engine = new TestCliEngine()

    const env = engine.buildEnvForTest({ protectedNames: ['SECRET_TOKEN'] })

    expect(env.SECRET_TOKEN).toBeUndefined()
  })

  it('inherits only operational process env and never unrelated service secrets', async () => {
    process.env.PATH = '/opt/a2wave/bin:/usr/bin'
    process.env.HOME = '/operator/home'
    process.env.HTTPS_PROXY = 'http://proxy.example.com:8080'
    process.env.AUTH_SECRET = 'service-jwt-secret'
    process.env.SCM_GIT_PAT = 'service-scm-token'
    process.env.INTERNAL_ONLY_RANDOM_VALUE = 'not-a-known-secret-name'
    const engine = new TestCliEngine()

    const env = engine.buildEnvForTest({
      protectedNames: [],
      agentEnv: { AGENT_FEATURE_FLAG: 'enabled' },
      runtimeEnv: { A2WAVE_RUN_ID: 'run_1' },
    })

    expect(env).toMatchObject({
      PATH: '/opt/a2wave/bin:/usr/bin',
      HOME: '/operator/home',
      HTTPS_PROXY: 'http://proxy.example.com:8080',
      AGENT_FEATURE_FLAG: 'enabled',
      A2WAVE_RUN_ID: 'run_1',
    })
    expect(env.AUTH_SECRET).toBeUndefined()
    expect(env.SCM_GIT_PAT).toBeUndefined()
    expect(env.INTERNAL_ONLY_RANDOM_VALUE).toBeUndefined()
  })

  it('blocks agentEnvOnlyNames from agentEnv while keeping the host value', async () => {
    // The reason this option exists: a var that redirects a credential store
    // (e.g. KIMI_CODE_HOME) must never be settable by an Agent editor, yet the
    // operator's own value has to survive — the CLI resolves its login through
    // it. Listing such a name in `protectedNames` deletes it from the trusted
    // process env too, silently severing the login.
    process.env.CRED_HOME = '/operator/store'
    const engine = new TestCliEngine()

    const env = engine.buildEnvForTest({
      protectedNames: [],
      agentEnvOnlyNames: ['CRED_HOME'],
      agentEnv: { CRED_HOME: '/attacker/store', SAFE: 'kept' },
    })

    expect(env.CRED_HOME).toBe('/operator/store')
    expect(env.SAFE).toBe('kept')
  })

  it('blocks agentEnvOnlyNames from runtimeEnv as defense in depth', async () => {
    process.env.CRED_HOME = '/operator/store'
    const engine = new TestCliEngine()

    const env = engine.buildEnvForTest({
      protectedNames: [],
      agentEnvOnlyNames: ['CRED_HOME'],
      runtimeEnv: { CRED_HOME: '/runtime/store' },
    })

    expect(env.CRED_HOME).toBe('/operator/store')
  })

  it('keeps HOME from the host when it is only omitted from runtimeEnv', async () => {
    process.env.HOME = '/host/home'
    const engine = new TestCliEngine()

    const env = engine.buildEnvForTest({
      protectedNames: [],
      omitRuntimeKeys: ['HOME'],
      runtimeEnv: { HOME: '/runtime/home', OTHER: 'x' },
    })

    expect(env.HOME).toBe('/host/home')
    expect(env.OTHER).toBe('x')
  })
})

// These guard exec_params logging: anything left in the array is written to the
// run log, so a flag that carries prompt text must take its value with it.
describe('stripPromptArg', () => {
  it('strips the default -p flag together with its value', async () => {
    expect(stripPromptArg(['-p', 'secret', '--output-format', 'json'])).toEqual([
      '--output-format',
      'json',
    ])
  })

  it('strips every configured flag, not just the first (claude-code passes two)', async () => {
    const args = [
      '-p',
      'user prompt plaintext',
      '--model',
      'sonnet',
      '--append-system-prompt',
      'injected identity prompt',
      '--verbose',
    ]

    const filtered = stripPromptArg(args, ['-p', '--append-system-prompt'])

    expect(filtered).toEqual(['--model', 'sonnet', '--verbose'])
    expect(filtered).not.toContain('user prompt plaintext')
    expect(filtered).not.toContain('injected identity prompt')
  })

  it('leaves args untouched when no configured flag is present', async () => {
    expect(stripPromptArg(['--model', 'opus'], ['-p', '--append-system-prompt'])).toEqual([
      '--model',
      'opus',
    ])
  })

  it('drops a trailing prompt flag that has no value', async () => {
    expect(stripPromptArg(['--verbose', '-p'])).toEqual(['--verbose'])
  })
})
