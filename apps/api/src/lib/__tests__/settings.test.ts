import { beforeEach, describe, expect, it, vi } from 'vitest'

const allMock = vi.fn<() => unknown[]>()

vi.mock('../../db/client.js', () => ({
  db: {
    select: () => ({
      from: () =>
        asyncQuery({
          where: () => asyncQuery({ all: allMock }),
          all: allMock,
        }),
    }),
  },
}))

vi.mock('@a2wave/shared', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@a2wave/shared')>()
  return {
    ...actual,
    SETTINGS_DEFAULTS: {
      auth: { passwordLoginEnabled: 'true', defaultRole: 'user' },
      other: { foo: 'bar' },
    },
  }
})

import { invalidateSettingsCache } from '../settings-cache.js'
import {
  getAllSettings,
  getCategorySettings,
  getSetting,
  redactCategoryForViewer,
  redactSettingsForViewer,
  refreshSettingsCache,
} from '../settings.js'

import { asyncQuery } from '../../test/async-query.js'

// Settings reads are served from an in-memory cache (see settings-cache.ts), so
// each case must start from an unprimed one — otherwise the first test's rows
// answer every later assertion regardless of what the DB mock returns.
beforeEach(() => {
  invalidateSettingsCache()
})

/** Stage the DB rows the readers should see, then load them into the cache. */
async function primeRows(rows: unknown[]): Promise<void> {
  allMock.mockReturnValue(rows)
  await refreshSettingsCache()
}

describe('getAllSettings', () => {
  it('returns defaults when DB is empty', async () => {
    await primeRows([])
    const result = getAllSettings()
    expect(result).toEqual({
      auth: { passwordLoginEnabled: 'true', defaultRole: 'user' },
      other: { foo: 'bar' },
    })
  })

  it('overrides defaults with DB rows, preserving untouched keys', async () => {
    await primeRows([
      { category: 'auth', key: 'defaultRole', value: 'admin' },
      { category: 'fresh', key: 'k', value: 'v' },
    ])
    const result = getAllSettings()
    expect(result.auth).toEqual({ passwordLoginEnabled: 'true', defaultRole: 'admin' })
    expect(result.fresh).toEqual({ k: 'v' })
    expect(result.other).toEqual({ foo: 'bar' })
  })
})

describe('getCategorySettings', () => {
  it('merges DB rows on top of category defaults', async () => {
    await primeRows([{ category: 'auth', key: 'passwordLoginEnabled', value: 'false' }])
    expect(getCategorySettings('auth')).toEqual({
      passwordLoginEnabled: 'false',
      defaultRole: 'user',
    })
  })

  it('returns an empty object for an unknown category with no rows', async () => {
    await primeRows([])
    expect(getCategorySettings('missing')).toEqual({})
  })
})

describe('getSetting', () => {
  it('returns the DB value when the key exists', async () => {
    await primeRows([
      { category: 'auth', key: 'defaultRole', value: 'admin' },
      { category: 'auth', key: 'unused', value: 'x' },
    ])
    expect(getSetting('auth', 'defaultRole')).toBe('admin')
  })

  it('falls back to SETTINGS_DEFAULTS when the row is missing', async () => {
    await primeRows([])
    expect(getSetting('auth', 'defaultRole')).toBe('user')
  })

  it('returns undefined for an unknown category + key', async () => {
    await primeRows([])
    expect(getSetting('missing', 'nope')).toBeUndefined()
  })
})

describe('redactSettingsForViewer (allowlist)', () => {
  const full = {
    attachments: { stagingPath: '/srv/data', maxFileSizeBytes: '10485760' },
    branding: { subtitle: 'Agent 工作流', faviconUrl: '/f.svg' },
    webhook: { url: 'https://hooks.example/secret-bearer', enabled: 'true' },
    jwtSigner: { privateKeyEnc: 'SUPER_SECRET', publicKeyJwk: '{}' },
    general: { workspacePath: '/srv/sandbox', teamName: 'a2wave' },
  }

  it('admin sees everything (returns the same map)', () => {
    expect(redactSettingsForViewer(full, true)).toBe(full)
  })

  it('non-admin only sees allowlisted keys; secrets/paths are stripped', () => {
    const out = redactSettingsForViewer(full, false)
    // 白名单键保留
    expect(out.branding).toEqual({ subtitle: 'Agent 工作流', faviconUrl: '/f.svg' })
    expect(out.attachments).toEqual({ maxFileSizeBytes: '10485760' })
    // 敏感/未列入的一律剔除——含 webhook.url（bearer secret）、jwtSigner.privateKeyEnc、
    // attachments.stagingPath、general.workspacePath 等内部路径。
    expect(out.attachments.stagingPath).toBeUndefined()
    expect(out.webhook).toBeUndefined()
    expect(out.jwtSigner).toBeUndefined()
    expect(out.general).toBeUndefined()
    // 原始 map 未被就地修改。
    expect(full.webhook.url).toBe('https://hooks.example/secret-bearer')
  })
})

describe('redactCategoryForViewer (allowlist)', () => {
  it('non-admin gets only allowlisted attachment keys (no stagingPath)', () => {
    const entries = { stagingPath: '/srv/data', maxFilesPerRequest: '10', allowedExtensions: 'png' }
    expect(redactCategoryForViewer('attachments', entries, true).stagingPath).toBe('/srv/data')
    const redacted = redactCategoryForViewer('attachments', entries, false)
    expect(redacted.stagingPath).toBeUndefined()
    expect(redacted.maxFilesPerRequest).toBe('10')
    expect(redacted.allowedExtensions).toBe('png')
  })

  it('non-admin gets nothing from a fully-sensitive category (webhook)', () => {
    const entries = { url: 'https://hooks.example/secret', enabled: 'true' }
    expect(redactCategoryForViewer('webhook', entries, false)).toEqual({})
  })
})
