import { describe, expect, it } from 'vitest'
import { filterClaudeCodeArgs } from '../claude-code.js'
import { redactCodexArgs } from '../codex-agent.js'

/**
 * 安全网回归：exec_params.args 会渲染到对 viewer 可见的 run-log UI。脱敏从中心
 * 「只留 flag」改为各引擎自管后，这些断言钉死「prompt / 携密 flag 值永不出现在
 * display args」。新增携密 flag 而忘了同步这里的脱敏，对应用例就会变红。
 */
describe('filterClaudeCodeArgs (claude-code)', () => {
  it('drops -p prompt and --append-system-prompt identity (flag + value), keeps non-sensitive flags', async () => {
    const out = filterClaudeCodeArgs([
      '--output-format',
      'stream-json',
      '-p',
      'SECRET user prompt text',
      '--append-system-prompt',
      'SECRET identity text',
      '--model',
      'gpt-5',
    ])

    expect(out).toEqual(['--output-format', 'stream-json', '--model', 'gpt-5'])
    expect(out).not.toContain('SECRET user prompt text')
    expect(out).not.toContain('SECRET identity text')
  })

  it('does not swallow the following flag when a skipped flag is last', async () => {
    // 防御 i++ 越界：-p 在末尾时只丢自己，不影响数组其余结构
    expect(filterClaudeCodeArgs(['--model', 'gpt-5', '-p'])).toEqual(['--model', 'gpt-5'])
  })
})

describe('redactCodexArgs (codex)', () => {
  it('masks -c / --config mcp_servers value (may carry MCP credentials)', async () => {
    const out = redactCodexArgs([
      'exec',
      '--json',
      '-c',
      'mcp_servers={url="https://x",headers={authorization="Bearer SECRET"}}',
      '--config',
      'mcp_servers={token="SECRET2"}',
      '--model',
      'gpt-5',
    ])

    expect(out).toEqual([
      'exec',
      '--json',
      '-c',
      'mcp_servers=<redacted>',
      '--config',
      'mcp_servers=<redacted>',
      '--model',
      'gpt-5',
    ])
    expect(out.join(' ')).not.toContain('SECRET')
  })

  it('returns a new array and leaves the input untouched', async () => {
    const input = ['-c', 'mcp_servers=SECRET']
    const out = redactCodexArgs(input)
    expect(input).toEqual(['-c', 'mcp_servers=SECRET'])
    expect(out).toEqual(['-c', 'mcp_servers=<redacted>'])
  })
})
