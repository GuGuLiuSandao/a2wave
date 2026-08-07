import type { SQL } from 'drizzle-orm'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { asyncQuery } from '../../test/async-query.js'

const mockGet = vi.fn()
const mockRun = vi.fn()
const mockValues = vi.fn(() => asyncQuery({ run: mockRun }))
const mockInsert = vi.fn(() => ({ values: mockValues }))
const mockSet = vi.fn(() => ({ where: vi.fn(() => asyncQuery({ run: mockRun })) }))
const mockUpdate = vi.fn(() => ({ set: mockSet }))
const mockWhere = vi.fn(() => asyncQuery({ get: mockGet }))
const mockFrom = vi.fn(() => ({ where: mockWhere }))
const mockSelect = vi.fn(() => ({ from: mockFrom }))

vi.mock('../../db/client.js', () => ({
  db: {
    select: () => mockSelect(),
    insert: () => mockInsert(),
    update: () => mockUpdate(),
  },
}))

vi.mock('../../db/schema.js', async () => {
  const { sqliteTable, text } =
    await vi.importActual<typeof import('drizzle-orm/sqlite-core')>('drizzle-orm/sqlite-core')
  return {
    skills: sqliteTable('skills', {
      id: text('id'),
      name: text('name'),
      userId: text('user_id'),
      visibility: text('visibility'),
    }),
  }
})

vi.mock('../id.js', () => ({
  createId: (prefix: string) => `${prefix}_test123`,
}))

vi.mock('../logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}))

vi.mock('../../env.js', () => ({
  env: { PORT: 3502, NODE_ENV: 'development', A2WAVE_SKILLS_STORAGE: '/tmp/test-skills' },
}))

const mockExistsSync = vi.fn()
const mockReadFileSync = vi.fn()
const mockReaddirSync = vi.fn()
const mockCpSync = vi.fn()
const mockMkdirSync = vi.fn()
const mockRmSync = vi.fn()

vi.mock('node:fs', () => ({
  existsSync: (...args: unknown[]) => mockExistsSync(...args),
  readFileSync: (...args: unknown[]) => mockReadFileSync(...args),
  readdirSync: (...args: unknown[]) => mockReaddirSync(...args),
  cpSync: (...args: unknown[]) => mockCpSync(...args),
  mkdirSync: (...args: unknown[]) => mockMkdirSync(...args),
  rmSync: (...args: unknown[]) => mockRmSync(...args),
}))

vi.mock('../skill-storage.js', () => ({
  parseSkillMd: (content: string) => {
    const lines = content.split('\n')
    const nameMatch = lines.find((l: string) => l.startsWith('name:'))
    const descMatch = lines.find((l: string) => l.startsWith('description:'))
    const bodyStart = content.indexOf('---', content.indexOf('---') + 3)
    return {
      name: nameMatch?.split(':')[1]?.trim() ?? 'Untitled',
      description: descMatch ? descMatch.slice(descMatch.indexOf(':') + 1).trim() : null,
      body: content.slice(bodyStart + 3).trim(),
    }
  },
  getSkillStoragePath: (id: string) => `/tmp/test-skills/${id}`,
}))

describe('seed-builtin-skills', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockExistsSync.mockReturnValue(true)
    // 单个内置技能目录（含 SKILL.md），保持单技能断言
    mockReaddirSync.mockReturnValue([{ name: 'a2wave-memory', isDirectory: () => true }])
    mockReadFileSync.mockReturnValue(
      '---\nname: a2wave-memory\ndescription: Test description\n---\n\n# Test content',
    )
  })

  it('inserts built-in skill when it does not exist', async () => {
    mockGet.mockReturnValue(undefined)

    const { seedBuiltinSkills } = await import('../seed-builtin-skills.js')
    await seedBuiltinSkills()

    expect(mockInsert).toHaveBeenCalledTimes(1)
    expect(mockValues).toHaveBeenCalledWith(
      expect.objectContaining({
        id: 'skl_test123',
        name: 'a2wave-memory',
        storagePath: 'skl_test123',
        userId: null,
        visibility: 'all-users',
      }),
    )
    expect(mockCpSync).toHaveBeenCalledTimes(1)
  })

  it('updates built-in skill when it already exists', async () => {
    mockGet.mockReturnValue({
      id: 'skl_existing',
      name: 'a2wave-memory',
      storagePath: 'skl_existing',
    })

    const { seedBuiltinSkills } = await import('../seed-builtin-skills.js')
    await seedBuiltinSkills()

    expect(mockUpdate).toHaveBeenCalledTimes(1)
    expect(mockSet).toHaveBeenCalledWith(
      expect.objectContaining({
        description: expect.any(String),
        content: expect.any(String),
        visibility: 'all-users',
      }),
    )
    expect(mockCpSync).toHaveBeenCalledTimes(1)
    expect(mockCpSync).toHaveBeenCalledWith(expect.any(String), '/tmp/test-skills/skl_existing', {
      recursive: true,
    })
  })

  it('skips seeding when SKILL.md is not found', async () => {
    mockExistsSync.mockReturnValue(false)

    const { seedBuiltinSkills } = await import('../seed-builtin-skills.js')
    await seedBuiltinSkills()

    expect(mockInsert).not.toHaveBeenCalled()
    expect(mockUpdate).not.toHaveBeenCalled()
  })

  it('matches a built-in by name and system ownership', async () => {
    mockGet.mockReturnValue(undefined)

    const { seedBuiltinSkills } = await import('../seed-builtin-skills.js')
    await seedBuiltinSkills()

    expect(mockWhere).toHaveBeenCalledTimes(1)
    const { SQLiteSyncDialect } = await import('drizzle-orm/sqlite-core')
    const whereArg = (mockWhere.mock.calls as unknown as Array<[SQL<unknown>]>)[0]?.[0]
    if (!whereArg) throw new Error('Expected the built-in lookup visibility predicate')
    const query = new SQLiteSyncDialect().sqlToQuery(whereArg)
    expect(query.sql).toContain('"skills"."name" = ?')
    expect(query.sql).toContain('"skills"."user_id" is null')
    expect(query.params).toEqual(['a2wave-memory'])
    expect(mockInsert).toHaveBeenCalledTimes(1)
    expect(mockUpdate).not.toHaveBeenCalled()
  })
})
