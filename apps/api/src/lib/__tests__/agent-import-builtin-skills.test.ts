import AdmZip from 'adm-zip'
import type { SQL } from 'drizzle-orm'
import { SQLiteSyncDialect } from 'drizzle-orm/sqlite-core'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const selectResults: unknown[] = []
const selectConditions: SQL<unknown>[] = []
const insertedRows: Array<Record<string, unknown>> = []
const persistedSkillFiles: Array<{ path: string; content: Buffer }> = []
let idCounter = 0

const txStub = {
  select: vi.fn(() =>
    asyncQuery({
      from: vi.fn(() =>
        asyncQuery({
          where: vi.fn((condition: SQL<unknown>) =>
            asyncQuery({
              get: vi.fn(() => {
                selectConditions.push(condition)
                return selectResults.shift()
              }),
            }),
          ),
        }),
      ),
    }),
  ),
  insert: vi.fn(() =>
    asyncQuery({
      values: vi.fn((values: Record<string, unknown>) => {
        insertedRows.push(values)
        return asyncQuery({ run: vi.fn() })
      }),
    }),
  ),
}

// `isPostgres: true` keeps `withTransaction` on the branch that calls
// `db.transaction`, so the callback still receives `txStub`. The SQLite branch
// would hand it the shared `db`, which here only carries `transaction`.
vi.mock('../../db/client.js', () => ({
  db: { transaction: (fn: (tx: unknown) => unknown) => fn(txStub) },
  isPostgres: true,
}))
vi.mock('../skill-storage.js', () => ({
  ensureDir: vi.fn(),
  getSkillStoragePath: (id: string) => `/tmp/skills/${id}`,
  readAllSkillFiles: vi.fn(() => persistedSkillFiles),
}))
vi.mock('../id.js', () => ({
  createId: (prefix: string) => `${prefix}_${++idCounter}`,
}))
vi.mock('../url-safety.js', () => ({ isBlockedHost: () => false }))
vi.mock('node:fs', async () => {
  const actual = await vi.importActual<typeof import('node:fs')>('node:fs')
  return { ...actual, writeFileSync: vi.fn() }
})

import { asyncQuery } from '../../test/async-query.js'
import { computeExportedSkillPackageDigest } from '../agent-export.js'
import { importAgentFromZip } from '../agent-import.js'

function buildZip(
  skillName: string,
  options: {
    origin?: 'system-builtin' | 'user-owned' | 'legacy'
    includeMemoryRuntimeFiles?: boolean
    tamperSkillMdAfterDigest?: boolean
  } = {},
): Buffer {
  const dirName = skillName.replace(/[^a-z0-9-]/g, '-').toLowerCase()
  const skillMd = Buffer.from(`# ${skillName}`)
  const packageFiles = [{ path: 'SKILL.md', data: skillMd }]
  if (options.includeMemoryRuntimeFiles) {
    packageFiles.push(
      { path: 'scripts/memory-search.mjs', data: Buffer.from('search') },
      { path: 'scripts/memory-write.mjs', data: Buffer.from('write') },
    )
  }
  const zip = new AdmZip()
  zip.addFile(
    'manifest.json',
    Buffer.from(JSON.stringify({ version: '1.0', exportedAt: '2026-01-01' })),
  )
  zip.addFile(
    'agent.json',
    Buffer.from(
      JSON.stringify({
        name: 'Imported',
        type: 'cursor',
        config: { memoryEnabled: skillName === 'a2wave-memory' },
        mcpServerRefs: [],
        skillRefs: [`${dirName}/`],
        kbDocumentRefs: [],
        providerRef: null,
        scmSourceRef: null,
      }),
    ),
  )
  zip.addFile(
    `skills/${dirName}/skill.json`,
    Buffer.from(
      JSON.stringify({
        name: skillName,
        description: null,
        ...(options.origin === 'system-builtin'
          ? {
              origin: {
                kind: 'system-builtin',
                name: skillName,
                digest: computeExportedSkillPackageDigest(
                  { name: skillName, description: null },
                  packageFiles,
                ),
              },
            }
          : options.origin === 'legacy'
            ? {}
            : { origin: { kind: 'user-owned' } }),
      }),
    ),
  )
  for (const file of packageFiles) {
    const data =
      options.tamperSkillMdAfterDigest && file.path === 'SKILL.md'
        ? Buffer.from('# tampered after digest')
        : file.data
    zip.addFile(`skills/${dirName}/${file.path}`, data)
  }
  return zip.toBuffer()
}

function buildAgentOnlyZip(memoryEnabled: boolean): Buffer {
  const zip = new AdmZip()
  zip.addFile(
    'manifest.json',
    Buffer.from(JSON.stringify({ version: '1.0', exportedAt: '2026-01-01' })),
  )
  zip.addFile(
    'agent.json',
    Buffer.from(
      JSON.stringify({
        name: 'Imported public share',
        type: 'cursor',
        config: { memoryEnabled },
        mcpServerRefs: [],
        skillRefs: [],
        kbDocumentRefs: [],
        providerRef: null,
        scmSourceRef: null,
      }),
    ),
  )
  return zip.toBuffer()
}

function insertedAgent(): Record<string, unknown> {
  const row = insertedRows.find((candidate) => String(candidate.id).startsWith('agt_'))
  if (!row) throw new Error('Expected imported Agent insert')
  return row
}

function trustedBuiltinLookupSql(): { sql: string; params: unknown[] } {
  const condition = selectConditions[0]
  if (!condition) throw new Error('Expected trusted built-in lookup')
  return new SQLiteSyncDialect().sqlToQuery(condition)
}

beforeEach(() => {
  vi.clearAllMocks()
  selectResults.length = 0
  selectConditions.length = 0
  insertedRows.length = 0
  persistedSkillFiles.length = 0
  idCounter = 0
})

describe('agent import trusted built-in Skills', () => {
  it('rebinds a2wave-memory to the existing system-owned all-users row', async () => {
    selectResults.push(
      {
        id: 'skl_builtin_memory',
        name: 'a2wave-memory',
        description: null,
        content: '# a2wave-memory',
        storagePath: 'skl_builtin_memory',
        userId: null,
        visibility: 'all-users',
      },
      undefined,
    )
    persistedSkillFiles.push(
      { path: 'SKILL.md', content: Buffer.from('stored frontmatter is not exported') },
      { path: 'scripts/memory-search.mjs', content: Buffer.from('search') },
      { path: 'scripts/memory-write.mjs', content: Buffer.from('write') },
    )

    const result = await importAgentFromZip(
      buildZip('a2wave-memory', {
        origin: 'system-builtin',
        includeMemoryRuntimeFiles: true,
      }),
      'usr_importer',
      false,
    )

    expect(result.skills).toEqual([{ id: 'skl_builtin_memory', name: 'a2wave-memory' }])
    expect(insertedAgent().skills).toEqual(['skl_builtin_memory'])
    expect(insertedRows.some((row) => String(row.id).startsWith('skl_'))).toBe(false)

    const query = trustedBuiltinLookupSql()
    expect(query.sql).toContain('"skills"."name" = ?')
    expect(query.sql).toContain('"skills"."user_id" is null')
    expect(query.sql).toContain('"skills"."visibility" = ?')
    expect(query.params).toEqual(['a2wave-memory', 'all-users'])
  })

  it('preserves a user-owned same-name copy while binding the required system memory Skill', async () => {
    const targetMemorySkill = {
      id: 'skl_builtin_memory',
      name: 'a2wave-memory',
      userId: null,
      visibility: 'all-users',
    }
    selectResults.push(targetMemorySkill, undefined, targetMemorySkill)

    const result = await importAgentFromZip(
      buildZip('a2wave-memory', { includeMemoryRuntimeFiles: true }),
      'usr_importer',
      false,
    )
    const importedSkill = insertedRows.find((row) => String(row.id).startsWith('skl_'))

    expect(importedSkill).toMatchObject({
      name: 'a2wave-memory (Imported)',
      content: '# a2wave-memory',
      userId: 'usr_importer',
      visibility: 'private',
    })
    expect(insertedAgent().skills).toEqual([importedSkill?.id, 'skl_builtin_memory'])
    expect(result.skills).toEqual([
      { id: importedSkill?.id, name: 'a2wave-memory (Imported)' },
      { id: 'skl_builtin_memory', name: 'a2wave-memory' },
    ])
    expect(selectConditions).toHaveLength(3)
  })

  it('binds the target memory built-in when a public share omitted all Skill references', async () => {
    selectResults.push(undefined, {
      id: 'skl_builtin_memory',
      name: 'a2wave-memory',
      userId: null,
      visibility: 'all-users',
    })

    const result = await importAgentFromZip(buildAgentOnlyZip(true), 'usr_importer', false)

    expect(insertedAgent()).toMatchObject({
      skills: ['skl_builtin_memory'],
      config: { memoryEnabled: true },
    })
    expect(result.skills).toEqual([{ id: 'skl_builtin_memory', name: 'a2wave-memory' }])
    expect(result.warnings).toEqual([])
  })

  it('disables public-share memory when the target built-in is unavailable', async () => {
    selectResults.push(undefined, undefined)

    const result = await importAgentFromZip(buildAgentOnlyZip(true), 'usr_importer', false)

    expect(insertedAgent()).toMatchObject({ skills: [], config: { memoryEnabled: false } })
    expect(result.skills).toEqual([])
    expect(result.warnings).toContain(
      'Long-term memory was disabled because the target built-in Skill "a2wave-memory" is unavailable',
    )
  })

  it('imports an unmarked legacy memory package privately even when runtime scripts exist', async () => {
    selectResults.push(
      {
        id: 'skl_builtin_memory',
        name: 'a2wave-memory',
        userId: null,
        visibility: 'all-users',
      },
      undefined,
    )

    const result = await importAgentFromZip(
      buildZip('a2wave-memory', { origin: 'legacy', includeMemoryRuntimeFiles: true }),
      'usr_importer',
      false,
    )

    const importedSkill = insertedRows.find((row) => String(row.id).startsWith('skl_'))
    expect(importedSkill).toMatchObject({
      name: 'a2wave-memory (Imported)',
      content: '# a2wave-memory',
      userId: 'usr_importer',
      visibility: 'private',
    })
    expect(insertedAgent().skills).toEqual(['skl_builtin_memory'])
    expect(result.skills).toEqual([{ id: 'skl_builtin_memory', name: 'a2wave-memory' }])
    expect(result.warnings).toContain(
      'Skill "a2wave-memory" has no verifiable built-in provenance; its packaged contents were preserved as a private copy and the target built-in Skill was bound',
    )
  })

  it('does not trust a claimed built-in digest when the target package differs', async () => {
    const targetBuiltin = {
      id: 'skl_builtin_memory',
      name: 'a2wave-memory',
      description: null,
      content: '# target builtin',
      storagePath: null,
      userId: null,
      visibility: 'all-users',
    }
    selectResults.push(targetBuiltin, undefined)

    const result = await importAgentFromZip(
      buildZip('a2wave-memory', { origin: 'system-builtin' }),
      'usr_importer',
      false,
    )
    const importedSkill = insertedRows.find((row) => String(row.id).startsWith('skl_'))

    expect(importedSkill).toMatchObject({
      name: 'a2wave-memory (Imported)',
      content: '# a2wave-memory',
      userId: 'usr_importer',
      visibility: 'private',
    })
    expect(insertedAgent().skills).toEqual(['skl_builtin_memory'])
    expect(result.skills).toEqual([{ id: 'skl_builtin_memory', name: 'a2wave-memory' }])
    expect(result.warnings).toContain(
      'Skill "a2wave-memory" could not verify its built-in provenance against the target instance; its packaged contents were preserved as a private copy and the target built-in Skill was bound',
    )
  })

  it('does not trust a declared built-in digest when the archive bytes differ', async () => {
    const targetBuiltin = {
      id: 'skl_builtin_memory',
      name: 'a2wave-memory',
      description: null,
      content: '# a2wave-memory',
      storagePath: null,
      userId: null,
      visibility: 'all-users',
    }
    selectResults.push(targetBuiltin, undefined)

    const result = await importAgentFromZip(
      buildZip('a2wave-memory', {
        origin: 'system-builtin',
        tamperSkillMdAfterDigest: true,
      }),
      'usr_importer',
      false,
    )
    const importedSkill = insertedRows.find((row) => String(row.id).startsWith('skl_'))

    expect(importedSkill).toMatchObject({
      content: '# tampered after digest',
      userId: 'usr_importer',
      visibility: 'private',
    })
    expect(insertedAgent().skills).toEqual(['skl_builtin_memory'])
    expect(result.skills).toEqual([{ id: 'skl_builtin_memory', name: 'a2wave-memory' }])
    expect(result.warnings).toContain(
      'Skill "a2wave-memory" could not verify its built-in provenance against the target instance; its packaged contents were preserved as a private copy and the target built-in Skill was bound',
    )
  })

  it('leaves downgraded memory unbound and disables memory when the target built-in is missing', async () => {
    selectResults.push(undefined, undefined, undefined)

    const result = await importAgentFromZip(
      buildZip('a2wave-memory', { origin: 'legacy', includeMemoryRuntimeFiles: true }),
      'usr_importer',
      false,
    )
    const importedSkill = insertedRows.find((row) => String(row.id).startsWith('skl_'))

    expect(importedSkill).toMatchObject({
      name: 'a2wave-memory',
      userId: 'usr_importer',
      visibility: 'private',
    })
    expect(insertedAgent()).toMatchObject({ skills: [], config: { memoryEnabled: false } })
    expect(result.skills).toEqual([{ id: importedSkill?.id, name: 'a2wave-memory' }])
    expect(result.warnings).toContain(
      'Skill "a2wave-memory" has no verifiable built-in provenance and the target built-in Skill is unavailable; its packaged contents were preserved as an unbound private copy and long-term memory was disabled',
    )
  })

  it('always creates an ordinary imported Skill as importer-owned private', async () => {
    selectResults.push(undefined, undefined)

    await importAgentFromZip(buildZip('custom-skill'), 'usr_importer', false)
    const importedSkill = insertedRows.find((row) => String(row.id).startsWith('skl_'))

    expect(importedSkill).toMatchObject({
      name: 'custom-skill',
      userId: 'usr_importer',
      visibility: 'private',
    })
    expect(insertedAgent().skills).toEqual([importedSkill?.id])
    expect(selectConditions).toHaveLength(2)
  })
})
