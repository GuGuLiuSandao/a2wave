/**
 * Covers the KB-document branch in buildAgentConfig — generating
 * resolvedKbDocs + auto-injecting the Knowledge Base skill.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const dbSelect = vi.fn()
vi.mock('../../db/client.js', () => ({
  db: { select: (...a: unknown[]) => dbSelect(...a) },
  // db/transaction.ts reads isPostgres + sqliteDatabase at module load, so the
  // mock must expose them or importing agent-helpers throws.
  isPostgres: false,
  sqliteDatabase: { inTransaction: false, exec: vi.fn() },
}))

vi.mock('../../db/schema.js', () => ({
  agents: {},
  providers: {},
  skills: { id: 'skills.id', groupId: 'skills.groupId' },
  skillGroups: { id: 'skillGroups.id' },
  mcpServers: {},
  kbDocuments: { id: 'kbDocuments.id' },
}))

import { kbDocFilename } from '../../engine/kb-sync.js'
import { asyncQuery } from '../../test/async-query.js'
import { buildAgentConfig } from '../agent-helpers.js'

function makeChain(cfg: { get?: unknown; all?: unknown }) {
  const c: Record<string, unknown> = {}
  // Only the configured terminator is exposed: the adapter consults `get`
  // before `all`, so an always-present `get` returning undefined would make
  // every list query resolve empty.
  if ('get' in cfg) c.get = vi.fn(() => cfg.get)
  if ('all' in cfg) c.all = vi.fn(() => cfg.all)
  // `from` is not one of the keys the adapter re-wraps, so it must hand back an
  // already-awaitable node itself.
  c.from = vi.fn(() => asyncQuery(c))
  c.where = vi.fn(() => asyncQuery(c))
  return c
}

function queueSelects(...returns: Array<{ get?: unknown; all?: unknown }>) {
  let i = 0
  dbSelect.mockImplementation(() => asyncQuery(makeChain(returns[i++] ?? {})))
}

function agent(overrides: Record<string, unknown> = {}) {
  return {
    id: 'agt_1',
    name: 'A',
    type: 'cursor',
    config: {},
    systemPrompt: null,
    skills: null,
    skillGroupIds: null,
    mcpServerIds: null,
    kbDocumentIds: null,
    providerId: null,
    env: null,
    a2aRouteTargets: null,
    ...overrides,
  } as never
}

beforeEach(() => {
  dbSelect.mockReset()
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('buildAgentConfig — KB injection', () => {
  it('resolves kbDocumentIds and injects the Knowledge Base skill content', async () => {
    queueSelects({
      all: [
        { id: 'kbd_AAA', name: 'Doc One', description: 'first doc', storagePath: 'kbd_AAA' },
        { id: 'kbd_BBB', name: '产品手册', description: null, storagePath: 'kbd_BBB' },
      ],
    })
    const cfg = buildAgentConfig(agent({ kbDocumentIds: ['kbd_AAA', 'kbd_BBB'] }))
    expect((await cfg).resolvedKbDocs).toEqual([
      { id: 'kbd_AAA', name: 'Doc One', storagePath: 'kbd_AAA' },
      { id: 'kbd_BBB', name: '产品手册', storagePath: 'kbd_BBB' },
    ])
    const skills = (await cfg).resolvedSkills as Array<{ name: string; content: string }>
    expect(skills?.[skills.length - 1].name).toBe('Knowledge Base')
    expect(skills?.[skills.length - 1].content).toContain('doc-one-AAA.md')
    expect(skills?.[skills.length - 1].content).toContain('产品手册-BBB.md')
  })

  it('lists the same filename the workspace writer produces for a long CJK name', async () => {
    // The skill tells the Agent which file to open, so this must be byte-identical to
    // what syncKbDocsToWorkspaceAsync writes. The two used to be separate copies of the
    // same expression, and only one got the 255-byte filesystem clamp.
    const longName = '知'.repeat(200)
    queueSelects({
      all: [{ id: 'kbd_LONG', name: longName, description: null, storagePath: 'kbd_LONG' }],
    })
    const cfg = buildAgentConfig(agent({ kbDocumentIds: ['kbd_LONG'] }))
    const skills = (await cfg).resolvedSkills as Array<{ name: string; content: string }>
    const listed = skills[skills.length - 1].content.match(/`([^`]+\.md)`/)?.[1]

    expect(listed).toBe(kbDocFilename('kbd_LONG', longName))
    expect(Buffer.byteLength(listed ?? '', 'utf-8')).toBeLessThanOrEqual(255)
  })

  it('omits docs without storagePath from the skill, not just from resolvedKbDocs', async () => {
    // A metadata-only row has no file in .kb/ yet; listing it tells the Agent to open a
    // path that was never written.
    queueSelects({
      all: [
        { id: 'kbd_OK', name: 'good', description: null, storagePath: 'kbd_OK' },
        { id: 'kbd_NO', name: 'pending', description: null, storagePath: null },
      ],
    })
    const cfg = buildAgentConfig(agent({ kbDocumentIds: ['kbd_OK', 'kbd_NO'] }))
    const skills = (await cfg).resolvedSkills as Array<{ name: string; content: string }>
    const content = skills[skills.length - 1].content

    expect(content).toContain('good-OK.md')
    expect(content).not.toContain('pending-NO.md')
  })

  it('drops docs without storagePath from resolvedKbDocs', async () => {
    queueSelects({
      all: [
        { id: 'kbd_OK', name: 'good', description: null, storagePath: 'kbd_OK' },
        { id: 'kbd_NO', name: 'pending', description: null, storagePath: null },
      ],
    })
    const cfg = buildAgentConfig(agent({ kbDocumentIds: ['kbd_OK', 'kbd_NO'] }))
    const ids = ((await cfg).resolvedKbDocs as unknown as Array<{ id: string }>).map((d) => d.id)
    expect(ids).toEqual(['kbd_OK'])
  })

  it('does not inject KB skill when no kbDocuments match', async () => {
    queueSelects({ all: [] })
    const cfg = buildAgentConfig(agent({ kbDocumentIds: ['kbd_X'] }))
    expect((await cfg).resolvedKbDocs).toBeUndefined()
    const skills = (await cfg).resolvedSkills as Array<{ name: string }> | undefined
    expect(skills?.some((s) => s.name === 'Knowledge Base')).not.toBe(true)
  })
})
