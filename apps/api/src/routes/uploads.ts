import { randomBytes } from 'node:crypto'
import { createReadStream, existsSync, mkdirSync, statSync } from 'node:fs'
import { writeFile } from 'node:fs/promises'
import { basename, extname, join, resolve } from 'node:path'
import { Hono } from 'hono'
import { stream } from 'hono/streaming'
import { authMiddleware } from '../middleware/auth-middleware.js'

const UPLOADS_DIR = resolve('./data/uploads')
const MAX_FILE_SIZE = 512 * 1024 // 512KB
const ALLOWED_EXTENSIONS = new Set(['.svg', '.png', '.ico', '.jpg', '.jpeg', '.webp'])
const MIME_MAP: Record<string, string> = {
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
}

function ensureUploadsDir() {
  if (!existsSync(UPLOADS_DIR)) {
    mkdirSync(UPLOADS_DIR, { recursive: true })
  }
}

const app = new Hono()

app.post('/', authMiddleware, async (c) => {
  ensureUploadsDir()

  const formData = await c.req.formData()
  const file = formData.get('file')

  if (!file || !(file instanceof File)) {
    return c.json({ error: 'No file provided' }, 400)
  }

  if (file.size > MAX_FILE_SIZE) {
    return c.json({ error: 'File too large (max 512KB)' }, 400)
  }

  const ext = extname(file.name).toLowerCase()
  if (!ALLOWED_EXTENSIONS.has(ext)) {
    return c.json(
      { error: `Invalid file type. Allowed: ${[...ALLOWED_EXTENSIONS].join(', ')}` },
      400,
    )
  }

  const safeName = basename(file.name).replace(/[^a-zA-Z0-9._-]/g, '_')
  const randomSuffix = randomBytes(8).toString('hex')
  const filename = `${Date.now()}-${randomSuffix}-${safeName}`
  const filePath = join(UPLOADS_DIR, filename)

  let buffer = Buffer.from(await file.arrayBuffer())

  // SVG content sanitization: strip dangerous elements and attributes
  if (ext === '.svg') {
    let svgContent = buffer.toString('utf-8')
    // Remove <script> tags and their content
    svgContent = svgContent.replace(/<script[\s\S]*?<\/script>/gi, '')
    svgContent = svgContent.replace(/<script[^>]*\/>/gi, '')
    // Remove on* event handler attributes
    svgContent = svgContent.replace(/\s+on\w+\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/gi, '')
    // Remove javascript: protocol in href/xlink:href attributes
    svgContent = svgContent.replace(
      /(href\s*=\s*(?:"|'))javascript:[^"']*(?:"|')/gi,
      '$1#blocked$2',
    )
    // Remove <foreignObject> which can embed arbitrary HTML
    svgContent = svgContent.replace(/<foreignObject[\s\S]*?<\/foreignObject>/gi, '')
    svgContent = svgContent.replace(/<foreignObject[^>]*\/>/gi, '')
    buffer = Buffer.from(svgContent, 'utf-8')
  }

  await writeFile(filePath, buffer)

  return c.json({ data: { url: `/api/uploads/${filename}` } })
})

app.get('/:filename', (c) => {
  const { filename } = c.req.param()

  const safeName = basename(filename)
  if (safeName !== filename || filename.includes('..')) {
    return c.json({ error: 'Invalid filename' }, 400)
  }

  const filePath = join(UPLOADS_DIR, safeName)
  if (!existsSync(filePath)) {
    return c.json({ error: 'File not found' }, 404)
  }

  const ext = extname(safeName).toLowerCase()
  const contentType = MIME_MAP[ext] || 'application/octet-stream'
  const stat = statSync(filePath)

  c.header('Content-Type', contentType)
  c.header('Content-Length', String(stat.size))
  c.header('Cache-Control', 'public, max-age=31536000, immutable')
  if (ext === '.svg') {
    c.header('Content-Security-Policy', "default-src 'none'")
  }

  return stream(c, async (s) => {
    const nodeStream = createReadStream(filePath)
    for await (const chunk of nodeStream) {
      await s.write(chunk as Uint8Array)
    }
  })
})

export default app
