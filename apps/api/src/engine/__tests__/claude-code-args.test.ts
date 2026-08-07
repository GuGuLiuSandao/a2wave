import { describe, expect, it } from 'vitest'
import { ClaudeCodeEngine } from '../claude-code.js'

const engineConfig = {
  path: 'claude',
  apiKey: '',
  baseUrl: '',
  timeoutMinutes: 5,
  force: true,
  approveMcps: true,
  defaultWorkDir: '/tmp',
}

type BuildArgs = (
  prompt: string,
  model: string,
  outputFormat: 'json' | 'stream-json',
  chatId?: string,
  extras?: { readOnly?: boolean; force?: boolean; approveMcps?: boolean },
) => string[]

function getBuildArgs(engine: ClaudeCodeEngine): BuildArgs {
  return (engine as unknown as { buildArgs: BuildArgs }).buildArgs.bind(engine)
}

describe('ClaudeCodeEngine buildArgs', () => {
  it('adds --verbose for stream-json output', async () => {
    const engine = new ClaudeCodeEngine(engineConfig)
    const args = getBuildArgs(engine)('hello', 'claude-sonnet-4-6', 'stream-json')

    expect(args).toContain('--output-format')
    expect(args).toContain('stream-json')
    expect(args).toContain('--verbose')
  })

  it('does not add --verbose for json output', async () => {
    const engine = new ClaudeCodeEngine(engineConfig)
    const args = getBuildArgs(engine)('hello', 'claude-sonnet-4-6', 'json')

    expect(args).toContain('--output-format')
    expect(args).toContain('json')
    expect(args).not.toContain('--verbose')
  })

  // --append-system-prompt 注入：修 claude-code CLI 内置过时模型清单导致 agent 答错版本
  // 详见 buildIdentityPrompt 注释
  describe('identity prompt injection (--append-system-prompt)', () => {
    it('appends identity prompt with model id when model is set', async () => {
      const engine = new ClaudeCodeEngine(engineConfig)
      const args = getBuildArgs(engine)('hello', 'claude-opus-4-8', 'stream-json')

      expect(args).toContain('--append-system-prompt')
      const idx = args.indexOf('--append-system-prompt')
      expect(args[idx + 1]).toContain('claude-opus-4-8')
      expect(args[idx + 1]).toContain('a2wave runtime identity')
    })

    it('does NOT append identity prompt when model is empty string', async () => {
      const engine = new ClaudeCodeEngine(engineConfig)
      const args = getBuildArgs(engine)('hello', '', 'stream-json')
      expect(args).not.toContain('--append-system-prompt')
    })

    it('does NOT append identity prompt when model is whitespace only', async () => {
      const engine = new ClaudeCodeEngine(engineConfig)
      const args = getBuildArgs(engine)('hello', '   ', 'stream-json')
      expect(args).not.toContain('--append-system-prompt')
    })

    it('appends model-specific prompt for different model ids', async () => {
      const engine = new ClaudeCodeEngine(engineConfig)
      const args1 = getBuildArgs(engine)('hello', 'claude-sonnet-4-6', 'stream-json')
      const args2 = getBuildArgs(engine)('hello', 'claude-haiku-4-5-20251001', 'stream-json')

      const idx1 = args1.indexOf('--append-system-prompt')
      const idx2 = args2.indexOf('--append-system-prompt')
      expect(args1[idx1 + 1]).toContain('claude-sonnet-4-6')
      expect(args2[idx2 + 1]).toContain('claude-haiku-4-5-20251001')
      // 互不相同（model id 不同导致 prompt 内容不同）
      expect(args1[idx1 + 1]).not.toBe(args2[idx2 + 1])
    })
  })
})
