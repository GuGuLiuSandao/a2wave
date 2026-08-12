import { beforeEach, describe, expect, it, vi } from 'vitest'
import { db } from '../../db/client.js'
import { scmSources } from '../../db/schema.js'
import { bootstrapFromEnv, parseSettingsEnvKey } from '../bootstrap.js'
import { primeSettingsCache } from '../settings-cache.js'

// `bootstrapFromEnv()` returns void but its body kicks off async upserts, so the
// tests must let the microtask queue drain before asserting on the db mock.
const flush = () => new Promise<void>((resolve) => setImmediate(resolve))

import { asyncQuery } from '../../test/async-query.js'

const mockEnv = vi.hoisted(() => ({
  ADMIN_PASSWORD: '',
  SCM_P4_PORT: '',
  SCM_P4_USER: '',
  SCM_P4_PASSWD: '',
  SCM_P4_CLIENT: '',
  SCM_P4_DEPOT_PATH: '',
  SCM_P4_LOCAL_PATH: '/app/data/p4-workspace',
  SCM_P4_AUTO_SYNC: false,
  SCM_P4_SYNC_INTERVAL: 30,
  SCM_GIT_REPO_URL: '',
  SCM_GIT_BRANCH: 'main',
  SCM_GIT_USERNAME: '',
  SCM_GIT_PAT: '',
  SCM_GIT_LOCAL_PATH: '/app/data/git-workspace',
  SCM_GIT_AUTO_SYNC: false,
  SCM_GIT_SYNC_INTERVAL: 30,
}))

vi.mock('../../db/client.js', () => ({
  db: {
    select: vi.fn(),
    insert: vi.fn(),
    update: vi.fn(),
  },
}))

vi.mock('../../env.js', () => ({ env: mockEnv }))

vi.mock('../id.js', () => ({
  createId: vi.fn((prefix: string) => `${prefix}_test123`),
}))

vi.mock('../logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}))

describe('parseSettingsEnvKey', () => {
  it('parses SETTINGS_GENERAL_WORKSPACE_PATH to general.workspacePath', async () => {
    expect(parseSettingsEnvKey('SETTINGS_GENERAL_WORKSPACE_PATH')).toEqual({
      category: 'general',
      key: 'workspacePath',
    })
  })

  it('parses SETTINGS_BRANDING_SUBTITLE to branding.subtitle', async () => {
    expect(parseSettingsEnvKey('SETTINGS_BRANDING_SUBTITLE')).toEqual({
      category: 'branding',
      key: 'subtitle',
    })
  })

  it('parses SETTINGS_GENERAL_TIMEOUT_MINUTES to general.timeoutMinutes', async () => {
    expect(parseSettingsEnvKey('SETTINGS_GENERAL_TIMEOUT_MINUTES')).toEqual({
      category: 'general',
      key: 'timeoutMinutes',
    })
  })

  it('returns null for non-SETTINGS_ prefix', async () => {
    expect(parseSettingsEnvKey('OTHER_VAR')).toBeNull()
  })

  it('returns null for SETTINGS_ with single part', async () => {
    expect(parseSettingsEnvKey('SETTINGS_GENERAL')).toBeNull()
  })

  it('returns null for empty after SETTINGS_', async () => {
    expect(parseSettingsEnvKey('SETTINGS_')).toBeNull()
  })
})

describe('bootstrapFromEnv', () => {
  beforeEach(() => {
    // Prime empty rather than invalidate: an unprimed cache falls through to a
    // real DB read, and this file's db mock has no select().from().all() chain.
    primeSettingsCache([])
    vi.clearAllMocks()
    mockEnv.SCM_P4_PORT = ''
    mockEnv.SCM_P4_USER = ''
    mockEnv.SCM_P4_CLIENT = ''
    mockEnv.SCM_GIT_REPO_URL = ''

    vi.mocked(db.select).mockReturnValue({
      from: vi.fn().mockReturnValue(
        asyncQuery({
          where: vi.fn().mockReturnValue(
            asyncQuery({
              get: vi.fn().mockReturnValue(null),
              // 网关 token 回填读 jwtSigner 全部行；默认空数组 = 无既有签名器，跳过回填。
              all: vi.fn().mockReturnValue([]),
            }),
          ),
        }),
      ),
    } as never)
    vi.mocked(db.insert).mockReturnValue({
      values: vi.fn().mockReturnValue(asyncQuery({ run: vi.fn() })),
    } as never)
    vi.mocked(db.update).mockReturnValue({
      set: vi.fn().mockReturnValue(
        asyncQuery({
          where: vi.fn().mockReturnValue(asyncQuery({ run: vi.fn() })),
        }),
      ),
    } as never)
  })

  describe('bootstrapSettings', () => {
    it('upserts settings from SETTINGS_* env vars', async () => {
      const orig = process.env.SETTINGS_GENERAL_WORKSPACE_PATH
      process.env.SETTINGS_GENERAL_WORKSPACE_PATH = '/custom/workspace'
      process.env.SETTINGS_BRANDING_SUBTITLE = 'My Team'

      bootstrapFromEnv()
      await flush()

      expect(db.insert).toHaveBeenCalled()
      const insertReturn = vi.mocked(db.insert).mock.results[0]?.value as {
        values: (v: Record<string, unknown>) => { run: () => void }
      }
      const valuesCalls = vi.mocked(insertReturn?.values).mock?.calls ?? []
      const workspaceCall = valuesCalls.find(
        (c) => c[0] && typeof c[0] === 'object' && 'key' in c[0] && c[0].key === 'workspacePath',
      )
      expect(workspaceCall).toBeDefined()
      if (workspaceCall?.[0] && typeof workspaceCall[0] === 'object') {
        expect((workspaceCall[0] as { category: string }).category).toBe('general')
        expect((workspaceCall[0] as { value: string }).value).toBe('/custom/workspace')
      }

      process.env.SETTINGS_GENERAL_WORKSPACE_PATH = orig
      delete process.env.SETTINGS_BRANDING_SUBTITLE
    })
  })

  describe('bootstrapScmP4', () => {
    it('skips when SCM_P4_PORT is empty', async () => {
      bootstrapFromEnv()
      await flush()
      const scmInsertCalls = vi.mocked(db.insert).mock.calls.filter((c) => c[0] === scmSources)
      expect(scmInsertCalls.length).toBe(0)
    })

    it('creates P4 source when env vars are set', async () => {
      mockEnv.SCM_P4_PORT = 'ssl:p4.example.com:1666'
      mockEnv.SCM_P4_USER = 'builder'
      mockEnv.SCM_P4_CLIENT = 'builder-ws'
      mockEnv.SCM_P4_PASSWD = 'secret'

      bootstrapFromEnv()
      await flush()

      const insertCalls = vi.mocked(db.insert).mock.calls
      const scmInsertCall = insertCalls.find((c) => c[0] === scmSources)
      expect(scmInsertCall).toBeDefined()
      const insertReturn = vi
        .mocked(db.insert)
        .mock.results.find((r, i) => insertCalls[i]?.[0] === scmSources)?.value as {
        values: (v: Record<string, unknown>) => { run: () => void }
      }
      const valuesCalls = vi.mocked(insertReturn?.values).mock?.calls ?? []
      const p4Values = valuesCalls.find(
        (c) =>
          c[0] &&
          typeof c[0] === 'object' &&
          'name' in c[0] &&
          (c[0] as { name: string }).name === 'env:p4',
      )?.[0]
      expect(p4Values).toBeDefined()
      expect((p4Values as { name: string }).name).toBe('env:p4')
      expect((p4Values as { type: string }).type).toBe('p4')
    })

    it('does not create a P4 source without an explicit client-root-covered path', async () => {
      mockEnv.SCM_P4_PORT = 'ssl:p4.example.com:1666'
      mockEnv.SCM_P4_USER = 'builder'
      mockEnv.SCM_P4_CLIENT = 'builder-ws'
      mockEnv.SCM_P4_LOCAL_PATH = ''

      bootstrapFromEnv()
      await flush()

      const scmInsertCalls = vi.mocked(db.insert).mock.calls.filter((c) => c[0] === scmSources)
      expect(scmInsertCalls).toHaveLength(0)
    })
  })

  describe('bootstrapScmGit', () => {
    it('creates Git source when SCM_GIT_REPO_URL is set', async () => {
      mockEnv.SCM_GIT_REPO_URL = 'https://github.com/org/repo.git'
      mockEnv.SCM_GIT_BRANCH = 'main'

      bootstrapFromEnv()
      await flush()

      const insertCalls = vi.mocked(db.insert).mock.calls
      const scmInsertCall = insertCalls.find((c) => c[0] === scmSources)
      expect(scmInsertCall).toBeDefined()
      const insertReturn = vi
        .mocked(db.insert)
        .mock.results.find((r, i) => insertCalls[i]?.[0] === scmSources)?.value as {
        values: (v: Record<string, unknown>) => { run: () => void }
      }
      const valuesCalls = vi.mocked(insertReturn?.values).mock?.calls ?? []
      const gitValues = valuesCalls.find(
        (c) =>
          c[0] &&
          typeof c[0] === 'object' &&
          'name' in c[0] &&
          (c[0] as { name: string }).name === 'env:git',
      )?.[0]
      expect(gitValues).toBeDefined()
      expect((gitValues as { name: string }).name).toBe('env:git')
      expect((gitValues as { type: string }).type).toBe('git')
    })
  })
})
