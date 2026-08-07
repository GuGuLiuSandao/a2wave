import { describe, expect, it } from 'vitest'
import { toDisplayExecParams } from '../exec-params.js'

describe('toDisplayExecParams', () => {
  it('strips credential keys but keeps the engine-redacted args verbatim', async () => {
    const serverParams = {
      cmd: 'claude',
      // already redacted by the engine: prompt + --append-system-prompt dropped,
      // non-sensitive flag values kept.
      args: [
        '--output-format',
        'stream-json',
        '--verbose',
        '--dangerously-skip-permissions',
        '--allowedTools',
        'mcp__*',
        '--model',
        'gpt-5',
      ],
      cwd: '/work',
      authMode: 'apiKey',
      baseUrl: 'https://api.anthropic.com',
      runtimeHome: '/app/data/agent-homes/agt_secret',
      workspaceDir: '/tmp/a2wave-sandbox/agt_secret',
      apiKey: 'sk-abcd1234***', // must NOT reach the UI
      oauthToken: 'oat-xyz***', // must NOT reach the UI
      cursorApiKey: 'cur-xyz***', // must NOT reach the UI
    }
    const out = toDisplayExecParams(serverParams)

    expect(out.apiKey).toBeUndefined()
    expect(out.oauthToken).toBeUndefined()
    expect(out.cursorApiKey).toBeUndefined()
    expect(out.runtimeHome).toBeUndefined()
    expect(out.cmd).toBe('claude')
    expect(out.cwd).toBe('/work')
    expect(out.authMode).toBe('apiKey')
    expect(out.baseUrl).toBe('https://api.anthropic.com')
    expect(out.workspaceDir).toBe('/tmp/a2wave-sandbox/agt_secret')
    // args are trusted as-is: flag values survive (model, allowedTools, …)
    expect(out.args).toEqual([
      '--output-format',
      'stream-json',
      '--verbose',
      '--dangerously-skip-permissions',
      '--allowedTools',
      'mcp__*',
      '--model',
      'gpt-5',
    ])
  })

  it('keeps a codex-redacted -c value masked (engine already replaced it)', async () => {
    const serverParams = {
      cmd: 'codex',
      args: ['exec', '--json', '--model', 'gpt-5', '-c', 'mcp_servers=<redacted>'],
      authMode: 'apiKey',
      apiKey: 'sk-abcd1234***',
    }
    const out = toDisplayExecParams(serverParams)

    expect(out.apiKey).toBeUndefined()
    expect(out.args).toEqual(['exec', '--json', '--model', 'gpt-5', '-c', 'mcp_servers=<redacted>'])
  })
})
