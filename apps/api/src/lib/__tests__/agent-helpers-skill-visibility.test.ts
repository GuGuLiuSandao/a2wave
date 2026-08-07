import { beforeEach, describe, expect, it, vi } from 'vitest'

const mockDbFrom = vi.fn()

vi.mock('../../db/client.js', () => {
  const dbMock = {
    select: () => ({ from: mockDbFrom }),
    update: () => ({ set: () => ({ where: () => ({ run: () => ({ changes: 1 }) }) }) }),
    insert: () => ({ values: () => ({ run: () => ({ changes: 1 }) }) }),
    transaction: (callback: (tx: unknown) => unknown) => callback(dbMock),
  }
  // db/transaction.ts reads isPostgres + sqliteDatabase at module load, so the
  // mock must expose them or importing agent-helpers throws.
  return { db: dbMock, isPostgres: false, sqliteDatabase: { inTransaction: false, exec: vi.fn() } }
})

vi.mock('../../db/schema.js', () => ({
  agents: { id: 'agents.id' },
  providers: { id: 'providers.id' },
  skills: { id: 'skills.id', groupId: 'skills.groupId' },
  scmSources: { id: 'scmSources.id' },
  mcpServers: { id: 'mcpServers.id' },
  kbDocuments: { id: 'kbDocuments.id' },
  users: { id: 'users.id', role: 'users.role', isActive: 'users.isActive' },
  auditLogs: {},
  runs: { id: 'runs.id', workDir: 'runs.workDir', status: 'runs.status' },
  settings: {},
}))

vi.mock('../scm-source.js', () => ({ createScmSource: vi.fn() }))
vi.mock('../p4-sync.js', () => ({ executeSetupScript: vi.fn() }))
vi.mock('../../engine/mcp-sync.js', () => ({}))
vi.mock('../seed-builtin-mcp.js', () => ({
  resolveBuiltinMcpConfig: vi.fn().mockReturnValue({
    command: '/usr/local/bin/node',
    args: ['dist/mcp-servers/a2wave-mcp-group-proxy.js'],
    env: {},
  }),
  isOwnerSafeBuiltinMcp: (name: string, userId: string | null) =>
    userId === null && name === 'a2wave-agent-router',
}))
vi.mock('../settings.js', () => ({
  getCategorySettings: vi.fn().mockReturnValue({ workspacePath: '/workspace' }),
}))
vi.mock('../slug.js', () => ({
  slugify: vi.fn((name: string) => name.toLowerCase().replace(/\s+/g, '-')),
}))

import { asyncQuery } from '../../test/async-query.js'
import { buildAgentConfig } from '../agent-helpers.js'

function chainResult(value: unknown) {
  // An array stands for a multi-row result and must surface through `all`;
  // routing it through `get` too would wrap the whole array as one row.
  const terminator = Array.isArray(value)
    ? { all: () => value }
    : { get: () => value, all: () => [] }
  return asyncQuery({ where: () => asyncQuery(terminator) })
}

describe('buildAgentConfig Skill visibility', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockDbFrom.mockReturnValue(chainResult(undefined))
  })

  it('drops foreign private Skills at runtime for direct and group mounts', async () => {
    const directRows = [
      {
        id: 'skl_foreign_direct',
        name: 'foreign-direct',
        content: 'private',
        storagePath: null,
        userId: 'usr_other',
        visibility: 'private',
      },
      {
        id: 'skl_owned',
        name: 'owned',
        content: 'owned',
        storagePath: null,
        userId: 'usr_owner',
        visibility: 'private',
      },
    ]
    const groupRows = [
      {
        id: 'skl_foreign_group',
        name: 'foreign-group',
        content: 'private',
        storagePath: null,
        userId: 'usr_other',
        visibility: 'private',
      },
      {
        id: 'skl_shared',
        name: 'shared',
        content: 'shared',
        storagePath: null,
        userId: 'usr_admin',
        visibility: 'all-users',
      },
      {
        id: 'skl_memory',
        name: 'a2wave-memory',
        content: 'builtin',
        storagePath: null,
        userId: null,
        visibility: 'all-users',
      },
      {
        id: 'skl_spoofed_memory',
        name: 'a2wave-memory',
        content: 'user-created same-name Skill',
        storagePath: null,
        userId: 'usr_other',
        visibility: 'private',
      },
    ]
    mockDbFrom
      .mockReturnValueOnce(chainResult(directRows))
      .mockReturnValueOnce(chainResult(groupRows))

    const result = buildAgentConfig({
      id: 'agt_1',
      name: 'Test',
      config: {},
      providerId: null,
      systemPrompt: null,
      skills: ['skl_foreign_direct', 'skl_owned'],
      skillGroupIds: ['skg_1'],
      env: null,
      workspaceType: 'temp',
      scmSourceId: null,
      userId: 'usr_owner',
    } as any)

    expect((await result).resolvedSkills?.map((skill) => skill.name).sort()).toEqual([
      'a2wave-memory',
      'owned',
      'shared',
    ])
  })

  it("preserves an active admin Agent owner's runtime Skill access", async () => {
    mockDbFrom
      .mockReturnValueOnce(
        chainResult([
          {
            id: 'skl_foreign',
            name: 'foreign-private',
            content: 'admin-managed',
            storagePath: null,
            userId: 'usr_other',
            visibility: 'private',
          },
        ]),
      )
      .mockReturnValueOnce(chainResult({ role: 'admin', isActive: true }))

    const result = buildAgentConfig({
      id: 'agt_admin',
      name: 'Admin Agent',
      config: {},
      providerId: null,
      systemPrompt: null,
      skills: ['skl_foreign'],
      skillGroupIds: [],
      env: null,
      workspaceType: 'temp',
      scmSourceId: null,
      userId: 'usr_admin',
    } as any)

    expect((await result).resolvedSkills?.map((skill) => skill.name)).toEqual(['foreign-private'])
  })
})
