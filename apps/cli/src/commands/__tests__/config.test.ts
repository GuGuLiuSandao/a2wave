import { beforeEach, describe, expect, it, vi } from 'vitest'

const mockLoadConfig = vi.fn()
const mockSaveConfig = vi.fn()

vi.mock('../../config.js', () => ({
  loadConfig: () => mockLoadConfig(),
  saveConfig: (...args: unknown[]) => mockSaveConfig(...args),
}))

const { configCommand } = await import('../config.js')

type SubCmd = { run: (ctx: { args: Record<string, unknown> }) => Promise<void> | void }
const subs = configCommand.subCommands as Record<string, SubCmd>

describe('config command', () => {
  let logSpy: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    vi.clearAllMocks()
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
  })

  describe('set-url', () => {
    it('writes the URL to config (preserving token)', () => {
      mockLoadConfig.mockImplementation(() => ({ token: 'tok', url: 'https://old' }))
      subs['set-url'].run({ args: { url: 'https://new.host/' } })
      // trailing slash is stripped
      expect(mockSaveConfig).toHaveBeenCalledWith({ token: 'tok', url: 'https://new.host' })
    })

    it('initializes config when none exists', () => {
      mockLoadConfig.mockImplementation(() => null)
      subs['set-url'].run({ args: { url: 'http://localhost:3502' } })
      expect(mockSaveConfig).toHaveBeenCalledWith({ token: '', url: 'http://localhost:3502' })
    })

    it('rejects URLs without http(s):// prefix', () => {
      mockLoadConfig.mockImplementation(() => ({ token: 'tok' }))
      expect(() => subs['set-url'].run({ args: { url: 'just-a-host.com' } })).toThrow(
        /must start with http/,
      )
      expect(mockSaveConfig).not.toHaveBeenCalled()
    })

    it('rejects empty URL', () => {
      mockLoadConfig.mockImplementation(() => ({ token: 'tok' }))
      expect(() => subs['set-url'].run({ args: { url: '   ' } })).toThrow(/must not be empty/)
      expect(mockSaveConfig).not.toHaveBeenCalled()
    })
  })

  describe('get', () => {
    it('prints url and masked token (last 4 chars only)', () => {
      mockLoadConfig.mockImplementation(() => ({
        url: 'http://localhost:3502',
        token: 'eyJabcdefghijk1234',
      }))
      subs.get.run({ args: {} })
      expect(logSpy).toHaveBeenCalledWith('url:   http://localhost:3502')
      expect(logSpy).toHaveBeenCalledWith('token: ***1234')
    })

    it('shows <unset> for missing fields', () => {
      mockLoadConfig.mockImplementation(() => ({ token: 'abc' }))
      subs.get.run({ args: {} })
      expect(logSpy).toHaveBeenCalledWith('url:   <unset>')
    })

    it('handles no config gracefully', () => {
      mockLoadConfig.mockImplementation(() => null)
      subs.get.run({ args: {} })
      expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('not configured'))
    })

    it('masks short token to **** instead of leaking', () => {
      mockLoadConfig.mockImplementation(() => ({ token: 'abc' }))
      subs.get.run({ args: {} })
      expect(logSpy).toHaveBeenCalledWith('token: ****')
    })
  })

  describe('unset-url', () => {
    it('removes url field, preserves token', () => {
      mockLoadConfig.mockImplementation(() => ({ url: 'http://x', token: 'tok' }))
      subs['unset-url'].run({ args: {} })
      const written = (mockSaveConfig.mock.calls[0]?.[0] ?? {}) as Record<string, unknown>
      expect(written.url).toBeUndefined()
      expect(written.token).toBe('tok')
    })

    it('no-op when no config exists', () => {
      mockLoadConfig.mockImplementation(() => null)
      subs['unset-url'].run({ args: {} })
      expect(mockSaveConfig).not.toHaveBeenCalled()
    })
  })
})
