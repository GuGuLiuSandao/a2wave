import { Hono } from 'hono'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { rateLimit } from '../rate-limit.js'

function createApp(options?: Parameters<typeof rateLimit>[0]) {
  const app = new Hono()
  app.use('*', rateLimit(options))
  app.get('/test', (c) => c.json({ ok: true }))
  return app
}

describe('rateLimit', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('allows requests within the limit', async () => {
    const app = createApp({ windowMs: 60_000, max: 3 })

    for (let i = 0; i < 3; i++) {
      const res = await app.request('/test')
      expect(res.status).toBe(200)
    }
  })

  it('blocks requests exceeding the limit', async () => {
    const app = createApp({ windowMs: 60_000, max: 2 })

    await app.request('/test')
    await app.request('/test')
    const res = await app.request('/test')

    expect(res.status).toBe(429)
    const body = (await res.json()) as {
      error: {
        code: string
        message: string
        source: string
        action: string
        retryable: boolean
      }
    }
    expect(body.error).toMatchObject({
      code: 'RATE_LIMITED',
      source: 'caller',
      action: 'retry_later',
      retryable: true,
    })
    expect(body.error.message).toContain('Retry-After')
    expect(res.headers.get('Retry-After')).toBeTruthy()
  })

  it('sets rate limit headers', async () => {
    const app = createApp({ windowMs: 60_000, max: 5 })

    const res = await app.request('/test')
    expect(res.headers.get('X-RateLimit-Limit')).toBe('5')
    expect(res.headers.get('X-RateLimit-Remaining')).toBe('4')
    expect(res.headers.get('X-RateLimit-Reset')).toBeTruthy()
  })

  it('shows remaining count decreasing', async () => {
    const app = createApp({ windowMs: 60_000, max: 3 })

    const r1 = await app.request('/test')
    expect(r1.headers.get('X-RateLimit-Remaining')).toBe('2')

    const r2 = await app.request('/test')
    expect(r2.headers.get('X-RateLimit-Remaining')).toBe('1')

    const r3 = await app.request('/test')
    expect(r3.headers.get('X-RateLimit-Remaining')).toBe('0')
  })

  it('remaining never goes below 0', async () => {
    const app = createApp({ windowMs: 60_000, max: 1 })

    await app.request('/test')
    const res = await app.request('/test')
    expect(res.headers.get('X-RateLimit-Remaining')).toBe('0')
  })

  it('resets after window expires', async () => {
    const app = createApp({ windowMs: 1_000, max: 1 })

    await app.request('/test')
    const blocked = await app.request('/test')
    expect(blocked.status).toBe(429)

    // Advance past the window
    vi.advanceTimersByTime(1_100)

    const res = await app.request('/test')
    expect(res.status).toBe(200)
  })

  it('uses custom key function', async () => {
    const app = new Hono()
    // Each unique path gets its own rate limit
    app.use('*', rateLimit({ max: 1, windowMs: 60_000, keyFn: (c) => c.req.path }))
    app.get('/a', (c) => c.json({ ok: true }))
    app.get('/b', (c) => c.json({ ok: true }))

    const r1 = await app.request('/a')
    expect(r1.status).toBe(200)

    // /a should be blocked
    const r2 = await app.request('/a')
    expect(r2.status).toBe(429)

    // /b should still work (different key)
    const r3 = await app.request('/b')
    expect(r3.status).toBe(200)
  })

  it('can key trusted proxy traffic by X-Forwarded-For client IP', async () => {
    const app = createApp({
      windowMs: 60_000,
      max: 1,
      trustProxy: true,
      trustedProxyAddresses: ['10.0.0.1'],
    })
    const env = { incoming: { socket: { remoteAddress: '10.0.0.1' } } }

    const r1 = await app.request('/test', { headers: { 'X-Forwarded-For': '203.0.113.10' } }, env)
    expect(r1.status).toBe(200)

    const r2 = await app.request('/test', { headers: { 'X-Forwarded-For': '203.0.113.11' } }, env)
    expect(r2.status).toBe(200)

    const r3 = await app.request('/test', { headers: { 'X-Forwarded-For': '203.0.113.10' } }, env)
    expect(r3.status).toBe(429)
  })

  it('cannot evade a trusted-proxy bucket by prepending a spoofed XFF value', async () => {
    const app = createApp({
      windowMs: 60_000,
      max: 1,
      trustProxy: true,
      trustedProxyAddresses: ['10.0.0.1'],
    })
    const proxy = { incoming: { socket: { remoteAddress: '10.0.0.1' } } }

    const first = await app.request(
      '/test',
      { headers: { 'X-Forwarded-For': '192.0.2.1, 203.0.113.10' } },
      proxy,
    )
    expect(first.status).toBe(200)

    const second = await app.request(
      '/test',
      { headers: { 'X-Forwarded-For': '192.0.2.2, 203.0.113.10' } },
      proxy,
    )
    expect(second.status).toBe(429)
  })

  it('ignores X-Forwarded-For from untrusted remotes', async () => {
    const app = createApp({
      windowMs: 60_000,
      max: 1,
      trustProxy: true,
      trustedProxyAddresses: ['10.0.0.1'],
    })
    const env = { incoming: { socket: { remoteAddress: '198.51.100.1' } } }

    const r1 = await app.request('/test', { headers: { 'X-Forwarded-For': '203.0.113.10' } }, env)
    expect(r1.status).toBe(200)

    const r2 = await app.request('/test', { headers: { 'X-Forwarded-For': '203.0.113.11' } }, env)
    expect(r2.status).toBe(429)
  })

  it('uses default options when none provided', async () => {
    const app = createApp()

    const res = await app.request('/test')
    expect(res.status).toBe(200)
    expect(res.headers.get('X-RateLimit-Limit')).toBe('60')
  })
})
