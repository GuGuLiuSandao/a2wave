import { describe, expect, it } from 'vitest'
import { isBlockedHost, validateImportUrl } from '../agent-import.js'

describe('SSRF protection', () => {
  describe('isBlockedHost', () => {
    it('blocks localhost', async () => {
      expect(isBlockedHost('localhost')).toBe(true)
      expect(isBlockedHost('[::1]')).toBe(true)
    })

    it('blocks loopback IPs', async () => {
      expect(isBlockedHost('127.0.0.1')).toBe(true)
      expect(isBlockedHost('127.0.0.2')).toBe(true)
    })

    it('blocks private 10.x.x.x', async () => {
      expect(isBlockedHost('10.0.0.1')).toBe(true)
      expect(isBlockedHost('10.255.255.255')).toBe(true)
    })

    it('blocks private 192.168.x.x', async () => {
      expect(isBlockedHost('192.168.1.1')).toBe(true)
      expect(isBlockedHost('192.168.0.100')).toBe(true)
    })

    it('blocks private 172.16-31.x.x', async () => {
      expect(isBlockedHost('172.16.0.1')).toBe(true)
      expect(isBlockedHost('172.31.255.255')).toBe(true)
    })

    it('allows 172.x outside 16-31 range', async () => {
      expect(isBlockedHost('172.15.0.1')).toBe(false)
      expect(isBlockedHost('172.32.0.1')).toBe(false)
    })

    it('blocks link-local', async () => {
      expect(isBlockedHost('169.254.169.254')).toBe(true)
      expect(isBlockedHost('169.254.1.1')).toBe(true)
    })

    it('blocks metadata endpoints', async () => {
      expect(isBlockedHost('169.254.169.254')).toBe(true)
      expect(isBlockedHost('metadata.google.internal')).toBe(true)
    })

    it('allows public IPs', async () => {
      expect(isBlockedHost('8.8.8.8')).toBe(false)
      expect(isBlockedHost('1.1.1.1')).toBe(false)
    })

    it('blocks reserved/documentation ranges (e.g. TEST-NET-3 203.0.113.0/24)', async () => {
      // ipaddr.js classifies these as `reserved` (non-routable). The SSRF filter
      // only allows public unicast, so they are blocked — stricter than the old
      // prefix-list which silently let them through.
      expect(isBlockedHost('203.0.113.1')).toBe(true)
      expect(isBlockedHost('192.0.2.1')).toBe(true)
    })

    it('allows public hostnames', async () => {
      expect(isBlockedHost('example.com')).toBe(false)
      expect(isBlockedHost('a2wave.example.com')).toBe(false)
    })
  })

  describe('validateImportUrl', () => {
    it('allows valid https URL', async () => {
      const parsed = validateImportUrl('https://example.com/api/agents/shared/abc')
      expect(parsed.hostname).toBe('example.com')
    })

    it('allows valid http URL', async () => {
      const parsed = validateImportUrl('http://example.com/export.zip')
      expect(parsed.hostname).toBe('example.com')
    })

    it('rejects non-http protocols', async () => {
      expect(() => validateImportUrl('ftp://example.com/file.zip')).toThrow(
        'Only the http/https protocols are supported',
      )
      expect(() => validateImportUrl('file:///etc/passwd')).toThrow(
        'Only the http/https protocols are supported',
      )
    })

    it('rejects invalid URLs', async () => {
      expect(() => validateImportUrl('not-a-url')).toThrow('Invalid URL')
    })

    it('rejects localhost URLs', async () => {
      expect(() => validateImportUrl('http://localhost:3502/api/agents/agt_x/export')).toThrow(
        'Access to internal network addresses is not allowed',
      )
      expect(() => validateImportUrl('http://127.0.0.1/export')).toThrow(
        'Access to internal network addresses is not allowed',
      )
    })

    it('rejects private network URLs', async () => {
      expect(() => validateImportUrl('http://10.0.0.1/export')).toThrow(
        'Access to internal network addresses is not allowed',
      )
      expect(() => validateImportUrl('http://192.168.1.100/export')).toThrow(
        'Access to internal network addresses is not allowed',
      )
      expect(() => validateImportUrl('http://172.16.0.5/export')).toThrow(
        'Access to internal network addresses is not allowed',
      )
    })

    it('rejects metadata endpoint URLs', async () => {
      expect(() => validateImportUrl('http://169.254.169.254/latest/meta-data/')).toThrow(
        'Access to internal network addresses is not allowed',
      )
    })
  })
})
