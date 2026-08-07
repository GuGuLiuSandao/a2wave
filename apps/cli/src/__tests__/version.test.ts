import { readFileSync } from 'node:fs'
import { describe, expect, it, vi } from 'vitest'

vi.mock('node:fs', () => ({
  readFileSync: vi.fn(),
}))

const mockedReadFileSync = vi.mocked(readFileSync)

describe('getVersion', () => {
  it('returns version from package.json', async () => {
    mockedReadFileSync.mockReturnValue(JSON.stringify({ version: '1.2.3' }))

    // Re-import to get fresh module with our mock
    const { getVersion } = await import('../version.js')
    expect(getVersion()).toBe('1.2.3')
  })

  it('returns 0.0.0 when package.json cannot be read', async () => {
    mockedReadFileSync.mockImplementation(() => {
      throw new Error('ENOENT')
    })

    const { getVersion } = await import('../version.js')
    expect(getVersion()).toBe('0.0.0')
  })

  it('returns 0.0.0 when package.json is invalid JSON', async () => {
    mockedReadFileSync.mockReturnValue('not json')

    const { getVersion } = await import('../version.js')
    expect(getVersion()).toBe('0.0.0')
  })
})

describe('getPackageName', () => {
  it('returns name from package.json', async () => {
    mockedReadFileSync.mockReturnValue(JSON.stringify({ name: '@example/my-cli' }))

    const { getPackageName } = await import('../version.js')
    expect(getPackageName()).toBe('@example/my-cli')
  })

  it('returns null when package.json cannot be read', async () => {
    mockedReadFileSync.mockImplementation(() => {
      throw new Error('ENOENT')
    })

    const { getPackageName } = await import('../version.js')
    expect(getPackageName()).toBeNull()
  })

  it('returns null when name is missing', async () => {
    mockedReadFileSync.mockReturnValue(JSON.stringify({ version: '1.0.0' }))

    const { getPackageName } = await import('../version.js')
    expect(getPackageName()).toBeNull()
  })
})
