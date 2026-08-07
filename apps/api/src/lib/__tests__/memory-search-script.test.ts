import { spawn } from 'node:child_process'
import { createServer } from 'node:http'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'

const scriptPath = fileURLToPath(
  new URL('../../builtin-skills/a2wave-memory/scripts/memory-search.mjs', import.meta.url),
)

describe('a2wave-memory search script', () => {
  let server: ReturnType<typeof createServer> | undefined

  afterEach(async () => {
    if (server) await new Promise<void>((resolve) => server?.close(() => resolve()))
    server = undefined
  })

  it('recalls one bounded topic with a single API request', async () => {
    const requests: Array<{ method?: string; url?: string }> = []
    server = createServer((req, res) => {
      requests.push({ method: req.method, url: req.url })
      res.setHeader('Content-Type', 'application/json')
      res.end(
        JSON.stringify({
          data: {
            topicId: 'tpc_test',
            title: 'Architecture review',
            content: '# Architecture review\n\n- Put risks first.',
            budget: { remainingReads: 2, remainingTokens: 3900 },
          },
        }),
      )
    })
    await new Promise<void>((resolve) => server?.listen(0, '127.0.0.1', () => resolve()))
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('Expected an ephemeral TCP port')

    const child = spawn(process.execPath, [scriptPath, '--recall', 'architecture review'], {
      env: {
        ...process.env,
        A2WAVE_API_URL: `http://127.0.0.1:${address.port}`,
        A2WAVE_AGENT_ID: 'agt_test',
        A2WAVE_MEMORY_TOKEN: 'test-token',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stdout = ''
    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString()
    })
    const exitCode = await new Promise<number | null>((resolve) => child.on('close', resolve))

    expect(exitCode).toBe(0)
    expect(requests).toEqual([
      {
        method: 'GET',
        url: '/api/memories/agt_test/topics/recall?q=architecture+review',
      },
    ])
    expect(stdout).toContain('=== tpc_test: Architecture review ===')
    expect(stdout).toContain('Put risks first.')
  })

  it('exits non-zero when bounded recall is rejected by the API', async () => {
    server = createServer((_req, res) => {
      res.statusCode = 429
      res.setHeader('Content-Type', 'application/json')
      res.end(JSON.stringify({ code: 'TOPIC_READ_BUDGET_EXCEEDED' }))
    })
    await new Promise<void>((resolve) => server?.listen(0, '127.0.0.1', () => resolve()))
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('Expected an ephemeral TCP port')

    const child = spawn(process.execPath, [scriptPath, '--recall', 'architecture review'], {
      env: {
        ...process.env,
        A2WAVE_API_URL: `http://127.0.0.1:${address.port}`,
        A2WAVE_AGENT_ID: 'agt_test',
        A2WAVE_MEMORY_TOKEN: 'test-token',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stderr = ''
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString()
    })
    const exitCode = await new Promise<number | null>((resolve) => child.on('close', resolve))

    expect(exitCode).toBe(1)
    expect(stderr).toContain('Topic recall API error (429)')
    expect(stderr).toContain('TOPIC_READ_BUDGET_EXCEEDED')
  })
})
