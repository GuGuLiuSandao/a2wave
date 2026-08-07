import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { Hono } from 'hono'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

// The uploads route resolves the storage dir at import time relative to cwd.
// We chdir into a temp dir BEFORE importing the module so files land somewhere
// we can clean up.
let cwdBackup: string
let tmp: string

beforeAll(async () => {
  cwdBackup = process.cwd()
  tmp = mkdtempSync(path.join(os.tmpdir(), 'uploads-route-'))
  process.chdir(tmp)
})

afterEach(() => {
  vi.restoreAllMocks()
})

afterAll(() => {
  if (cwdBackup) process.chdir(cwdBackup)
  if (tmp) rmSync(tmp, { recursive: true, force: true })
})

// Stub the auth middleware to a pass-through.
vi.mock('../../middleware/auth-middleware.js', () => ({
  authMiddleware: async (_c: unknown, next: () => Promise<void>) => {
    await next()
  },
}))

async function buildApp() {
  const mod = await import('../uploads.js')
  return new Hono().route('/uploads', mod.default)
}

beforeEach(() => {
  // ensure the route reads/writes into our isolated tmp dir
  process.chdir(tmp)
  // Clear uploads dir between tests
  const dir = path.resolve(tmp, 'data/uploads')
  if (existsSync(dir)) {
    rmSync(dir, { recursive: true, force: true })
  }
})

function uploadsDir() {
  return path.resolve(tmp, 'data/uploads')
}

function buildMultipart(content: Buffer | string, filename: string) {
  const fd = new FormData()
  const blob = new Blob([content as BlobPart])
  fd.append('file', new File([blob], filename))
  return fd
}

describe('routes/uploads POST /', () => {
  it('rejects when no file is provided', async () => {
    const app = await buildApp()
    const fd = new FormData()
    const res = await app.request('/uploads', { method: 'POST', body: fd })
    expect(res.status).toBe(400)
    expect((await res.json()) as any).toEqual({ error: 'No file provided' })
  })

  it('rejects when file exceeds 512KB', async () => {
    const big = Buffer.alloc(512 * 1024 + 1)
    const app = await buildApp()
    const res = await app.request('/uploads', {
      method: 'POST',
      body: buildMultipart(big, 'big.png'),
    })
    expect(res.status).toBe(400)
    expect((await res.json()) as any).toEqual({ error: 'File too large (max 512KB)' })
  })

  it('rejects disallowed file extensions', async () => {
    const app = await buildApp()
    const res = await app.request('/uploads', {
      method: 'POST',
      body: buildMultipart('# md', 'note.md'),
    })
    expect(res.status).toBe(400)
    const body = (await res.json()) as any
    expect(body.error).toContain('Invalid file type')
  })

  it('stores a png and returns a /api/uploads/<filename> URL', async () => {
    const app = await buildApp()
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
    const res = await app.request('/uploads', {
      method: 'POST',
      body: buildMultipart(png, 'icon.png'),
    })
    expect(res.status).toBe(200)
    const body = (await res.json()) as any
    expect(body.data.url).toMatch(/^\/api\/uploads\/\d+-[0-9a-f]+-icon\.png$/)
    const stored = path.join(uploadsDir(), body.data.url.replace('/api/uploads/', ''))
    expect(existsSync(stored)).toBe(true)
  })

  it('sanitizes SVG content (strips <script>, on* handlers, javascript:, <foreignObject>)', async () => {
    const dirty = `<?xml version="1.0"?><svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)">
      <script>alert('x')</script>
      <a href="javascript:alert(2)">x</a>
      <foreignObject><div onclick="x()">hi</div></foreignObject>
    </svg>`
    const app = await buildApp()
    const res = await app.request('/uploads', {
      method: 'POST',
      body: buildMultipart(dirty, 'icon.svg'),
    })
    expect(res.status).toBe(200)
    const body = (await res.json()) as any
    const stored = readFileSync(
      path.join(uploadsDir(), body.data.url.replace('/api/uploads/', '')),
      'utf-8',
    )
    expect(stored.toLowerCase()).not.toContain('<script')
    expect(stored).not.toMatch(/onload\s*=/i)
    expect(stored).not.toMatch(/onclick\s*=/i)
    expect(stored).not.toContain('javascript:alert(2)')
    expect(stored.toLowerCase()).not.toContain('<foreignobject')
  })
})

describe('routes/uploads GET /:filename', () => {
  it('returns 400 when the filename contains traversal characters', async () => {
    const app = await buildApp()
    const res = await app.request('/uploads/..%2F..%2Fetc%2Fpasswd')
    expect(res.status).toBe(400)
    expect((await res.json()) as any).toEqual({ error: 'Invalid filename' })
  })

  it('returns 404 when the file does not exist', async () => {
    const app = await buildApp()
    const res = await app.request('/uploads/nope.png')
    expect(res.status).toBe(404)
    expect((await res.json()) as any).toEqual({ error: 'File not found' })
  })

  it('streams an existing png with the right content-type and cache headers', async () => {
    const dir = uploadsDir()
    require('node:fs').mkdirSync(dir, { recursive: true })
    writeFileSync(path.join(dir, 'sample.png'), Buffer.from([1, 2, 3, 4]))

    const app = await buildApp()
    const res = await app.request('/uploads/sample.png')
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toBe('image/png')
    expect(res.headers.get('cache-control')).toContain('immutable')
    expect(res.headers.get('content-length')).toBe('4')
    expect(res.headers.get('content-security-policy')).toBeNull()
  })

  it('adds a strict CSP header when serving SVG', async () => {
    const dir = uploadsDir()
    require('node:fs').mkdirSync(dir, { recursive: true })
    writeFileSync(path.join(dir, 'i.svg'), '<svg/>')

    const app = await buildApp()
    const res = await app.request('/uploads/i.svg')
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toBe('image/svg+xml')
    expect(res.headers.get('content-security-policy')).toContain("default-src 'none'")
  })

  it('falls back to application/octet-stream for unknown extensions', async () => {
    const dir = uploadsDir()
    require('node:fs').mkdirSync(dir, { recursive: true })
    writeFileSync(path.join(dir, 'x.weird'), 'x')

    const app = await buildApp()
    const res = await app.request('/uploads/x.weird')
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toBe('application/octet-stream')
  })
})
