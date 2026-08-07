import { Hono } from 'hono'
import { describe, expect, it } from 'vitest'
import { requestIdMiddleware } from '../request-id.js'

type Env = { Variables: { requestId: string } }

function createApp() {
  const app = new Hono<Env>()
  app.use('*', requestIdMiddleware)
  app.get('/test', (c) => c.json({ requestId: c.get('requestId') }))
  return app
}

describe('requestIdMiddleware', () => {
  it('generates a UUID when no X-Request-ID header is present', async () => {
    const app = createApp()
    const res = await app.request('/test')
    const body = (await res.json()) as { requestId: string }

    expect(body.requestId).toBeDefined()
    expect(body.requestId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/)
  })

  it('uses existing X-Request-ID header if present', async () => {
    const app = createApp()
    const customId = 'my-custom-request-id-123'
    const res = await app.request('/test', {
      headers: { 'X-Request-ID': customId },
    })
    const body = (await res.json()) as { requestId: string }

    expect(body.requestId).toBe(customId)
  })

  it('sets X-Request-ID in response header', async () => {
    const app = createApp()
    const res = await app.request('/test')
    const responseId = res.headers.get('X-Request-ID')

    expect(responseId).toBeDefined()
    expect(responseId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/)
  })

  it('response X-Request-ID matches the context requestId', async () => {
    const app = createApp()
    const res = await app.request('/test')
    const body = (await res.json()) as { requestId: string }
    const responseId = res.headers.get('X-Request-ID')

    expect(responseId).toBe(body.requestId)
  })

  it('echoes back the provided X-Request-ID in response', async () => {
    const app = createApp()
    const customId = 'echo-this-id'
    const res = await app.request('/test', {
      headers: { 'X-Request-ID': customId },
    })

    expect(res.headers.get('X-Request-ID')).toBe(customId)
  })
})
