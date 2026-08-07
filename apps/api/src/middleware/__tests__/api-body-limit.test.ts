import { Hono } from 'hono'
import { describe, expect, it } from 'vitest'
import { apiBodyLimit } from '../api-body-limit.js'

function testApp() {
  const app = new Hono()
  app.use('*', apiBodyLimit(10))
  app.post('/api/oauth/:agentId/invoke', (c) => c.json({ ok: true }))
  app.post('/api/agents/import', (c) => c.json({ ok: true }))
  app.post('/api/other', (c) => c.json({ ok: true }))
  return app
}

describe('apiBodyLimit', () => {
  it('returns the OAuth GatewayError contract for oversized invoke requests', async () => {
    const response = await testApp().request('/api/oauth/agt_test/invoke', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': '11' },
      body: '12345678901',
    })

    expect(response.status).toBe(413)
    await expect(response.json()).resolves.toEqual({
      error: {
        code: 'PAYLOAD_TOO_LARGE',
        message:
          'The request body exceeds the 10-byte API limit. Reduce the message or context size, then retry.',
        source: 'caller',
        action: 'fix_request',
        retryable: false,
      },
    })
  })

  it('preserves the existing plain-text response outside OAuth routes', async () => {
    const response = await testApp().request('/api/other', {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain', 'Content-Length': '11' },
      body: '12345678901',
    })

    expect(response.status).toBe(413)
    await expect(response.text()).resolves.toBe('Payload Too Large')
  })

  it('keeps oversized Agent import multipart requests behind the global API limit', async () => {
    const response = await testApp().request('/api/agents/import', {
      method: 'POST',
      headers: {
        'Content-Type': 'multipart/form-data; boundary=agent-import-test',
        'Content-Length': '11',
      },
      body: '12345678901',
    })

    expect(response.status).toBe(413)
    await expect(response.text()).resolves.toBe('Payload Too Large')
  })
})
