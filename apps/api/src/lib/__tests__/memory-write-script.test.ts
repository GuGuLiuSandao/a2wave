import { spawn } from 'node:child_process'
import { createServer } from 'node:http'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'

const scriptPath = fileURLToPath(
  new URL('../../builtin-skills/a2wave-memory/scripts/memory-write.mjs', import.meta.url),
)

describe('a2wave-memory write script', () => {
  let server: ReturnType<typeof createServer> | undefined

  afterEach(async () => {
    if (server) await new Promise<void>((resolve) => server?.close(() => resolve()))
    server = undefined
  })

  it('uses POST for explicit topic writes', async () => {
    const requests: Array<{ method?: string; url?: string }> = []
    server = createServer((req, res) => {
      requests.push({ method: req.method, url: req.url })
      res.setHeader('Content-Type', 'application/json')
      res.end(JSON.stringify({ data: { created: true, topic: { topicId: 'tpc_test' } } }))
    })
    await new Promise<void>((resolve) => server?.listen(0, '127.0.0.1', () => resolve()))
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('Expected an ephemeral TCP port')

    const child = spawn(process.execPath, [scriptPath, '--remember'], {
      env: {
        ...process.env,
        A2WAVE_API_URL: `http://127.0.0.1:${address.port}`,
        A2WAVE_AGENT_ID: 'agt_test',
        A2WAVE_MEMORY_TOKEN: 'test-token',
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    child.stdin.end(
      JSON.stringify({
        title: 'Architecture review',
        scope: 'Review reports',
        description: 'Stable report preferences',
        keywords: ['architecture'],
        section: 'Decisions and Conventions',
        items: ['- Put risks before recommendations.'],
      }),
    )
    const exitCode = await new Promise<number | null>((resolve) => child.on('close', resolve))

    expect(exitCode).toBe(0)
    expect(requests).toEqual([{ method: 'POST', url: '/api/memories/agt_test/topics/remember' }])
  })

  it('exits non-zero when an explicit write is rejected by the API', async () => {
    server = createServer((_req, res) => {
      res.statusCode = 403
      res.setHeader('Content-Type', 'application/json')
      res.end(JSON.stringify({ code: 'FORBIDDEN' }))
    })
    await new Promise<void>((resolve) => server?.listen(0, '127.0.0.1', () => resolve()))
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('Expected an ephemeral TCP port')

    const child = spawn(process.execPath, [scriptPath, '--remember'], {
      env: {
        ...process.env,
        A2WAVE_API_URL: `http://127.0.0.1:${address.port}`,
        A2WAVE_AGENT_ID: 'agt_test',
        A2WAVE_MEMORY_TOKEN: 'read-only-token',
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    child.stdin.end(
      JSON.stringify({
        title: 'Denied topic',
        scope: 'Denied runtime write.',
        description: 'Denied runtime write.',
        keywords: ['denied'],
        section: 'Durable Knowledge',
        items: ['This must not be written.'],
      }),
    )
    let stderr = ''
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString()
    })
    const exitCode = await new Promise<number | null>((resolve) => child.on('close', resolve))

    expect(exitCode).toBe(1)
    expect(stderr).toContain('Write API error (403)')
    expect(stderr).toContain('FORBIDDEN')
  })
})
