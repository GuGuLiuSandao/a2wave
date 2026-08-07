import { Hono } from 'hono'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const mockExistsSync = vi.fn()
const mockReadFileSync = vi.fn()

vi.mock('node:fs', () => ({
  existsSync: (...args: unknown[]) => mockExistsSync(...args),
  readFileSync: (...args: unknown[]) => mockReadFileSync(...args),
}))

describe('Changelog routes', () => {
  let app: Hono

  beforeEach(async () => {
    vi.clearAllMocks()
    const mod = await import('../changelog.js')
    app = new Hono()
    app.route('/api/changelog', mod.default)
  })

  describe('GET /', () => {
    it('returns changelog content when file exists', async () => {
      mockExistsSync.mockReturnValue(true)
      mockReadFileSync.mockReturnValue('## v0.3.4\n\n- 变更摘要')

      const res = await app.request('/api/changelog')
      expect(res.status).toBe(200)
      const body = (await res.json()) as any
      expect(body).toEqual({ content: '## v0.3.4\n\n- 变更摘要' })
      expect(res.headers.get('Cache-Control')).toBe('no-store')
    })

    it('returns empty content when file does not exist', async () => {
      mockExistsSync.mockReturnValue(false)

      const res = await app.request('/api/changelog')
      expect(res.status).toBe(200)
      const body = (await res.json()) as any
      expect(body).toEqual({ content: '' })
      expect(mockReadFileSync).not.toHaveBeenCalled()
    })

    it('returns empty content on read error', async () => {
      mockExistsSync.mockReturnValue(true)
      mockReadFileSync.mockImplementation(() => {
        throw new Error('read error')
      })

      const res = await app.request('/api/changelog')
      expect(res.status).toBe(200)
      const body = (await res.json()) as any
      expect(body).toEqual({ content: '' })
    })
  })
})
