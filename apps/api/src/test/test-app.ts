/**
 * Hono test app helper for route-level integration tests.
 *
 * Creates a Hono app instance that can mount route modules and inject
 * a mock auth context (simulating authenticated requests).
 *
 * Usage:
 *   const app = createTestApp()
 *   const mod = await import('../routes/agents.js')
 *   app.route('/agents', mod.default)
 *
 *   const res = await app.request('/agents', { method: 'GET' })
 *   expect(res.status).toBe(200)
 */
import { Hono } from 'hono'

interface TestAppOptions {
  /** User ID for auth context. Defaults to 'usr_admin'. */
  userId?: string
  /** User role for auth context. Defaults to 'admin'. */
  role?: 'admin' | 'user'
  /** Whether to skip injecting auth middleware. Defaults to false. */
  noAuth?: boolean
}

/**
 * Create a Hono app with optional auth context injection.
 * Routes mounted on this app will see c.get('userId') and c.get('userRole').
 */
export function createTestApp(options: TestAppOptions = {}): Hono {
  const { userId = 'usr_admin', role = 'admin', noAuth = false } = options
  const app = new Hono()

  if (!noAuth) {
    app.use('*', async (c, next) => {
      c.set('userId' as never, userId as never)
      c.set('userRole' as never, role as never)
      await next()
    })
  }

  return app
}
