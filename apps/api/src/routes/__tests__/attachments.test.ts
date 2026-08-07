import { mkdtempSync, readdirSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { Hono } from 'hono'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

let cwdBackup: string
let tmp: string

// Auth middleware → pass-through.
vi.mock('../../middleware/auth-middleware.js', () => ({
  authMiddleware: async (_c: unknown, next: () => Promise<void>) => {
    await next()
  },
}))

// Settings → isolated staging root under tmp + fixed limits.
const stagingHolder = { path: '' }
vi.mock('../../lib/settings.js', () => ({
  getAttachmentSettings: () => ({
    stagingPath: stagingHolder.path,
    stagingTtlHours: 24,
    maxFileSizeBytes: 1024, // 1KB — easy to exceed in tests
    maxFilesPerRequest: 10,
    allowedExtensions: new Set(['png', 'pdf']),
  }),
}))

// owner 绑定鉴权 → 默认放行；IDOR 拒绝单独测（见 attachment-access.test.ts）。
const accessHolder = { allow: true }
vi.mock('../../lib/attachment-access.js', () => ({
  canAccessAttachment: () => accessHolder.allow,
}))

beforeAll(() => {
  cwdBackup = process.cwd()
  tmp = mkdtempSync(path.join(os.tmpdir(), 'attachments-route-'))
  process.chdir(tmp)
  stagingHolder.path = path.join(tmp, 'data/attachments')
})

afterEach(() => {
  vi.clearAllMocks()
  accessHolder.allow = true
})

afterAll(() => {
  if (cwdBackup) process.chdir(cwdBackup)
  if (tmp) rmSync(tmp, { recursive: true, force: true })
})

async function buildApp() {
  const mod = await import('../attachments.js')
  return new Hono().route('/attachments', mod.default)
}

function buildMultipart(content: Buffer | string, filename: string, type?: string) {
  const fd = new FormData()
  const blob = new Blob([content as BlobPart], type ? { type } : undefined)
  fd.append('file', new File([blob], filename, type ? { type } : undefined))
  return fd
}

beforeEach(() => {
  const dir = stagingHolder.path
  rmSync(dir, { recursive: true, force: true })
})

describe('POST /api/attachments', () => {
  it('rejects when no file is provided', async () => {
    const app = await buildApp()
    const res = await app.request('/attachments', { method: 'POST', body: new FormData() })
    expect(res.status).toBe(400)
  })

  it('stores a png and returns a token', async () => {
    const app = await buildApp()
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47])
    const res = await app.request('/attachments', {
      method: 'POST',
      body: buildMultipart(png, 'pic.png', 'image/png'),
    })
    expect(res.status).toBe(200)
    const body = (await res.json()) as { data: { token: string; name: string; mimeType: string } }
    expect(body.data.token).toMatch(/^att_/)
    expect(body.data.name).toBe('pic.png')
    expect(body.data.mimeType).toBe('image/png')
    // token dir exists on disk
    expect(readdirSync(stagingHolder.path)).toContain(body.data.token)
  })

  it('stores a pdf document', async () => {
    const app = await buildApp()
    const res = await app.request('/attachments', {
      method: 'POST',
      body: buildMultipart('%PDF-1.4', 'doc.pdf', 'application/pdf'),
    })
    expect(res.status).toBe(200)
    const body = (await res.json()) as { data: { mimeType: string } }
    expect(body.data.mimeType).toBe('application/pdf')
  })

  it('canonicalizes MIME from the extension, ignoring spoofed file.type', async () => {
    // 上传 .pdf 但把 file.type 伪造成 image/png：存下的 mimeType 必须按扩展名归一为
    // application/pdf，否则非图片会被当图片注入 prompt / 以图片 Content-Type 内联回显（review [P1]）。
    const app = await buildApp()
    const res = await app.request('/attachments', {
      method: 'POST',
      body: buildMultipart('%PDF-1.4', 'report.pdf', 'image/png'),
    })
    expect(res.status).toBe(200)
    const body = (await res.json()) as { data: { mimeType: string } }
    expect(body.data.mimeType).toBe('application/pdf')
  })

  it('rejects disallowed extension', async () => {
    const app = await buildApp()
    const res = await app.request('/attachments', {
      method: 'POST',
      body: buildMultipart('hi', 'note.txt', 'text/plain'),
    })
    expect(res.status).toBe(400)
    const body = (await res.json()) as { error: string }
    expect(body.error).toContain('Invalid file type')
  })

  it('rejects file over the size limit with 413', async () => {
    const app = await buildApp()
    const big = Buffer.alloc(2048)
    const res = await app.request('/attachments', {
      method: 'POST',
      body: buildMultipart(big, 'big.png', 'image/png'),
    })
    expect(res.status).toBe(413)
  })
})

describe('GET /api/attachments/:token', () => {
  it('streams back a staged image inline', async () => {
    const app = await buildApp()
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47])
    const up = await app.request('/attachments', {
      method: 'POST',
      body: buildMultipart(png, 'pic.png', 'image/png'),
    })
    const { data } = (await up.json()) as { data: { token: string } }

    const res = await app.request(`/attachments/${data.token}`)
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toBe('image/png')
    expect(res.headers.get('content-disposition')).toContain('inline')
    const body = Buffer.from(await res.arrayBuffer())
    expect(body.equals(png)).toBe(true)
  })

  it('404 for unknown / traversal token', async () => {
    const app = await buildApp()
    expect((await app.request('/attachments/att_missing')).status).toBe(404)
    // path-traversal token is rejected by resolveStagedAttachment → 404
    expect((await app.request('/attachments/..%2F..%2Fetc')).status).toBe(404)
  })

  it('serves non-image as octet-stream + attachment (never renders)', async () => {
    const app = await buildApp()
    const up = await app.request('/attachments', {
      method: 'POST',
      body: buildMultipart('%PDF', 'doc.pdf', 'application/pdf'),
    })
    const { data } = (await up.json()) as { data: { token: string } }
    const res = await app.request(`/attachments/${data.token}`)
    expect(res.headers.get('content-type')).toBe('application/octet-stream')
    expect(res.headers.get('content-disposition')).toContain('attachment')
    expect(res.headers.get('x-content-type-options')).toBe('nosniff')
    expect(res.headers.get('content-security-policy')).toContain('sandbox')
  })

  it('ignores attacker-controlled MIME (XSS): png stays image/png, not text/html', async () => {
    const app = await buildApp()
    // upload a .png but claim text/html content-type
    const up = await app.request('/attachments', {
      method: 'POST',
      body: buildMultipart('<script>alert(1)</script>', 'evil.png', 'text/html'),
    })
    const { data } = (await up.json()) as { data: { token: string } }
    const res = await app.request(`/attachments/${data.token}`)
    // Content-Type derived from extension, NOT the stored text/html
    expect(res.headers.get('content-type')).toBe('image/png')
    expect(res.headers.get('content-type')).not.toContain('text/html')
  })

  it('403 when access is denied (IDOR)', async () => {
    const app = await buildApp()
    const up = await app.request('/attachments', {
      method: 'POST',
      body: buildMultipart('x', 'a.png', 'image/png'),
    })
    const { data } = (await up.json()) as { data: { token: string } }
    accessHolder.allow = false
    const res = await app.request(`/attachments/${data.token}`)
    expect(res.status).toBe(403)
    accessHolder.allow = true
  })
})
