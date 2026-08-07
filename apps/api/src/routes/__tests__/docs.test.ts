import { Hono } from 'hono'
import { describe, expect, it, vi } from 'vitest'

vi.mock('../../openapi.js', () => ({
  openApiSpec: { openapi: '3.0.0', info: { title: 'a2wave' }, paths: {} },
}))

import docs from '../docs.js'

describe('routes/docs', () => {
  it('GET /spec returns the OpenAPI document', async () => {
    const app = new Hono().route('/docs', docs)
    const res = await app.request('/docs/spec')
    expect(res.status).toBe(200)
    expect((await res.json()) as any).toEqual({
      openapi: '3.0.0',
      info: { title: 'a2wave' },
      paths: {},
    })
  })

  it('GET / serves Swagger UI HTML', async () => {
    const app = new Hono().route('/docs', docs)
    const res = await app.request('/docs')
    expect(res.status).toBe(200)
    const body = await res.text()
    expect(body.toLowerCase()).toContain('swagger')
  })
})
