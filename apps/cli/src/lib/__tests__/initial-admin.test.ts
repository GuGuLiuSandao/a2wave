import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterEach, describe, expect, it } from 'vitest'
import { submitInitialAdminPassword } from '../initial-admin.js'

const servers: ReturnType<typeof createServer>[] = []

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolve, reject) => {
          if (!server.listening) return resolve()
          server.close((error) => (error ? reject(error) : resolve()))
        }),
    ),
  )
})

describe('submitInitialAdminPassword', () => {
  it('posts exactly the password pair to a real HTTP endpoint', async () => {
    let received: Record<string, unknown> | null = null
    const server = createServer((request, response) => {
      const chunks: Buffer[] = []
      request.on('data', (chunk) => chunks.push(Buffer.from(chunk)))
      request.on('end', () => {
        received = JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>
        response.writeHead(200, { 'content-type': 'application/json' })
        response.end(JSON.stringify({ data: { token: 'session' } }))
      })
    })
    servers.push(server)
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen(0, '127.0.0.1', resolve)
    })
    const address = server.address() as AddressInfo

    const result = await submitInitialAdminPassword(
      `http://127.0.0.1:${address.port}`,
      'Str0ngPass',
      'Str0ngPass',
    )

    expect(result.status).toBe(200)
    // No bootstrap credential is sent — first-time setup takes the password only.
    expect(received).toEqual({ password: 'Str0ngPass', confirmPassword: 'Str0ngPass' })
  })
})
