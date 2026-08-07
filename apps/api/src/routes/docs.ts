import { swaggerUI } from '@hono/swagger-ui'
import { Hono } from 'hono'
import { openApiSpec } from '../openapi.js'

const app = new Hono()

app.get('/spec', (c) => c.json(openApiSpec))

app.get(
  '/',
  swaggerUI({
    url: '/api/docs/spec',
    title: 'a2wave Gateway API',
    persistAuthorization: true,
  }),
)

export default app
