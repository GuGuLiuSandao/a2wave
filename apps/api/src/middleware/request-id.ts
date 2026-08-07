import { randomUUID } from 'node:crypto'
import { createMiddleware } from 'hono/factory'

type Env = {
  Variables: {
    requestId: string
  }
}

export const requestIdMiddleware = createMiddleware<Env>(async (c, next) => {
  const incoming = c.req.header('x-request-id')
  const requestId = incoming?.trim() ? incoming : randomUUID()
  c.set('requestId', requestId)
  await next()
  c.header('X-Request-ID', requestId)
})
