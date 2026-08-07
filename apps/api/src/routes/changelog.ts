import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Hono } from 'hono'

const app = new Hono()

/** CHANGELOG.md 位于 monorepo 根目录，从 apps/api/src/routes 向上 4 级 */
const CHANGELOG_PATH = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  '..',
  '..',
  'CHANGELOG.md',
)

app.get('/', (c) => {
  let content = ''
  if (existsSync(CHANGELOG_PATH)) {
    try {
      content = readFileSync(CHANGELOG_PATH, 'utf-8')
    } catch {
      // fallback to empty on read error
    }
  }
  c.header('Cache-Control', 'no-store')
  return c.json({ content })
})

export default app
