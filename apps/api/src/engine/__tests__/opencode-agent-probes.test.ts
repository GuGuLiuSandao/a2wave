import { afterEach, describe, expect, it, vi } from 'vitest'

const mockRunStatusProbe = vi.hoisted(() => vi.fn())

vi.mock('../login-status-helper.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../login-status-helper.js')>()
  return { ...actual, runStatusProbe: mockRunStatusProbe }
})

import { OpencodeAgentEngine } from '../opencode-agent.js'

const engine = new OpencodeAgentEngine({
  path: 'opencode',
  timeoutMinutes: 5,
  defaultWorkDir: '/tmp',
})

function probeResult(overrides: Record<string, unknown>) {
  return { notFound: false, timedOut: false, exitCode: 0, stdout: '', stderr: '', ...overrides }
}

/** 真实 `opencode auth list` 输出形状（stripAnsi 后，opencode 1.18.2 实测） */
const AUTH_LIST_LOGGED_IN = [
  '',
  '┌  Credentials ~/.local/share/opencode/auth.json',
  '│',
  '●  111 api',
  '│',
  '└  1 credentials',
].join('\n')

const AUTH_LIST_EMPTY = [
  '',
  '┌  Credentials ~/.local/share/opencode/auth.json',
  '│',
  '└  0 credentials',
].join('\n')

describe('OpencodeAgentEngine.checkLoginStatus', () => {
  afterEach(() => vi.clearAllMocks())

  it('有 credential 时 loggedIn=true 并列出名称', async () => {
    mockRunStatusProbe.mockResolvedValue(probeResult({ stdout: AUTH_LIST_LOGGED_IN }))
    const status = await engine.checkLoginStatus()
    expect(status.installed).toBe(true)
    expect(status.loggedIn).toBe(true)
    expect(status.detail).toContain('111')
  })

  it('0 credentials 时 loggedIn=false 并给出引导', async () => {
    mockRunStatusProbe.mockResolvedValue(probeResult({ stdout: AUTH_LIST_EMPTY }))
    const status = await engine.checkLoginStatus()
    expect(status.loggedIn).toBe(false)
    expect(status.error).toContain('opencode auth login')
  })

  it('计数锚定 └ 汇总行，credential 名称含数字不干扰', async () => {
    const out = ['┌  Credentials', '●  provider42 api', '●  team7 oauth', '└  2 credentials'].join(
      '\n',
    )
    mockRunStatusProbe.mockResolvedValue(probeResult({ stdout: out }))
    const status = await engine.checkLoginStatus()
    expect(status.loggedIn).toBe(true)
    expect(status.detail).toContain('2 credential')
  })

  it('CLI 未安装 → installed=false', async () => {
    mockRunStatusProbe.mockResolvedValue(probeResult({ notFound: true }))
    const status = await engine.checkLoginStatus()
    expect(status).toMatchObject({ installed: false, loggedIn: false })
  })

  it('超时 → installed=true 但 loggedIn=false 带 error', async () => {
    mockRunStatusProbe.mockResolvedValue(probeResult({ timedOut: true, stdout: 'partial' }))
    const status = await engine.checkLoginStatus()
    expect(status.installed).toBe(true)
    expect(status.loggedIn).toBe(false)
    expect(status.error).toMatch(/timed out/)
  })

  it('exit != 0 → loggedIn=false', async () => {
    mockRunStatusProbe.mockResolvedValue(
      probeResult({ exitCode: 1, stdout: AUTH_LIST_LOGGED_IN, stderr: 'boom' }),
    )
    const status = await engine.checkLoginStatus()
    expect(status.loggedIn).toBe(false)
  })
})

describe('OpencodeAgentEngine.listAvailableModels', () => {
  afterEach(() => vi.clearAllMocks())

  it('非 localSession 一律拒绝 unsupported_mode', async () => {
    for (const authMode of ['apiKey', 'oauth'] as const) {
      const result = await engine.listAvailableModels({ authMode })
      expect(result.code).toBe('unsupported_mode')
      expect(result.models).toEqual([])
    }
    expect(mockRunStatusProbe).not.toHaveBeenCalled()
  })

  it('解析 provider/model 二段式行，过滤空行与非模型行', async () => {
    const stdout = [
      '',
      'opencode/big-pickle',
      'opencode/deepseek-v4-flash-free',
      '111/gpt-5.5',
      'Loading models...',
      '=== header ===',
      '',
    ].join('\n')
    mockRunStatusProbe.mockResolvedValue(probeResult({ stdout }))
    const result = await engine.listAvailableModels({ authMode: 'localSession' })
    expect(result.error).toBeUndefined()
    expect(result.models).toEqual([
      'opencode/big-pickle',
      'opencode/deepseek-v4-flash-free',
      '111/gpt-5.5',
    ])
  })

  it('notFound → spawn_failed；timedOut → timeout；exit!=0 → cli_failed', async () => {
    mockRunStatusProbe.mockResolvedValueOnce(probeResult({ notFound: true }))
    expect((await engine.listAvailableModels({ authMode: 'localSession' })).code).toBe(
      'spawn_failed',
    )
    mockRunStatusProbe.mockResolvedValueOnce(probeResult({ timedOut: true }))
    expect((await engine.listAvailableModels({ authMode: 'localSession' })).code).toBe('timeout')
    mockRunStatusProbe.mockResolvedValueOnce(probeResult({ exitCode: 1, stderr: 'err' }))
    expect((await engine.listAvailableModels({ authMode: 'localSession' })).code).toBe('cli_failed')
  })

  it('无可解析模型行 → parse_failed', async () => {
    mockRunStatusProbe.mockResolvedValue(probeResult({ stdout: 'No providers configured\n' }))
    const result = await engine.listAvailableModels({ authMode: 'localSession' })
    expect(result.code).toBe('parse_failed')
    expect(result.models).toEqual([])
  })
})
