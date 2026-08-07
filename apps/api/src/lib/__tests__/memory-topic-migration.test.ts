import { existsSync, mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../../env.js', () => ({
  env: { A2WAVE_MEMORY_STORAGE: '' },
}))

vi.mock('../logger.js', () => ({
  logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() },
}))

const mockCallMemoryProvider = vi.fn()
vi.mock('../memory-provider.js', () => ({
  callMemoryProvider: (...args: unknown[]) => mockCallMemoryProvider(...args),
}))

const mockReindexAgentFts = vi.fn()
vi.mock('../memory-index.js', () => ({
  reindexAgentFts: (...args: unknown[]) => mockReindexAgentFts(...args),
}))

import { env } from '../../env.js'
import { listMemoryFiles, readMemoryFile, writeMemoryFile } from '../memory-storage.js'
import {
  clearTopicizationProposalsForTest,
  commitLegacyTopicization,
  proposeLegacyTopicization,
  splitLegacyMemoryBlocks,
} from '../memory-topic-migration.js'
import { detectMemoryHierarchyMode, listMemoryTopics } from '../memory-topics.js'

let testRoot: string

const legacy = `# Legacy Memory

## Campaign mail

- Use the V3 adapter for new mail templates.
- Validate item_id serialization before release.

## Cashier recovery

- DND wins over request preference.
- Missing DND opens the selection page.`

function completePlan(userContent: string): string {
  const parsed = JSON.parse(userContent) as {
    blocks: Array<{ hash: string; sectionHint: string | null; content: string }>
  }
  const groups = new Map<string, typeof parsed.blocks>()
  for (const block of parsed.blocks) {
    const key = block.sectionHint ?? 'General'
    const group = groups.get(key) ?? []
    group.push(block)
    groups.set(key, group)
  }
  return JSON.stringify({
    summary: ['Use the V3 adapter for new mail templates.'],
    topics: [...groups.entries()].map(([title, blocks]) => ({
      title,
      scope: `Reusable knowledge for ${title}.`,
      description: `${title} knowledge.`,
      keywords: title.toLowerCase().split(/\s+/),
      sections: [
        {
          section: 'Durable Knowledge',
          items: blocks.map((block) => ({ sourceHash: block.hash, content: block.content })),
        },
      ],
    })),
  })
}

describe('memory-topic-migration', () => {
  beforeEach(() => {
    testRoot = join(
      tmpdir(),
      `memory-migration-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    )
    mkdirSync(testRoot, { recursive: true })
    ;(env as { A2WAVE_MEMORY_STORAGE: string }).A2WAVE_MEMORY_STORAGE = testRoot
    clearTopicizationProposalsForTest()
    vi.clearAllMocks()
    mockCallMemoryProvider.mockImplementation(
      (_provider: unknown, _systemPrompt: string, userContent: string) =>
        Promise.resolve(completePlan(userContent)),
    )
  })

  afterEach(() => {
    clearTopicizationProposalsForTest()
    if (existsSync(testRoot)) rmSync(testRoot, { recursive: true })
  })

  it('splits legacy memory into stable coverage blocks without structural headings', async () => {
    const blocks = splitLegacyMemoryBlocks(legacy)

    expect(blocks).toHaveLength(4)
    expect(blocks.map((block) => block.sectionHint)).toEqual([
      'Campaign mail',
      'Campaign mail',
      'Cashier recovery',
      'Cashier recovery',
    ])
    expect(new Set(blocks.map((block) => block.hash)).size).toBe(4)
  })

  it('previews and commits a coverage-checked topicization', async () => {
    writeMemoryFile('agt_test', 'MEMORY.md', legacy)

    const preview = await proposeLegacyTopicization('agt_test', { agent: {} as never })
    expect(preview.sourceBlockCount).toBe(4)
    expect(preview.topics).toHaveLength(2)
    expect(preview.manifest).toHaveLength(4)
    expect(detectMemoryHierarchyMode('agt_test')).toBe('legacy_single_file')

    commitLegacyTopicization('agt_test', preview.proposalId)

    expect(detectMemoryHierarchyMode('agt_test')).toBe('topic_v2')
    expect(listMemoryTopics('agt_test').topics).toHaveLength(2)
    expect(readMemoryFile('agt_test', 'MEMORY.md')).toContain('## Topic Catalog')
    expect(mockReindexAgentFts).toHaveBeenCalledWith('agt_test')
    expect(
      listMemoryFiles('agt_test').some((file) => file.name.includes('migration-backups')),
    ).toBe(false)
    expect(existsSync(join(testRoot, '.migration-backups', 'agt_test'))).toBe(true)
  })

  it('rejects a proposal that omits a source block', async () => {
    writeMemoryFile('agt_test', 'MEMORY.md', legacy)
    mockCallMemoryProvider.mockImplementation(
      (_provider: unknown, _systemPrompt: string, userContent: string) => {
        const full = JSON.parse(completePlan(userContent)) as {
          summary: string[]
          topics: Array<{ sections: Array<{ items: unknown[] }> }>
        }
        full.topics[0].sections[0].items.pop()
        return Promise.resolve(JSON.stringify(full))
      },
    )

    await expect(
      proposeLegacyTopicization('agt_test', { agent: {} as never }),
    ).rejects.toMatchObject({ code: 'TOPICIZATION_COVERAGE_FAILED' })
    expect(detectMemoryHierarchyMode('agt_test')).toBe('legacy_single_file')
  })

  it('rejects paraphrased source content during a non-lossy topicization', async () => {
    writeMemoryFile('agt_test', 'MEMORY.md', legacy)
    mockCallMemoryProvider.mockImplementation(
      (_provider: unknown, _systemPrompt: string, userContent: string) => {
        const full = JSON.parse(completePlan(userContent)) as {
          topics: Array<{ sections: Array<{ items: Array<{ content: string }> }> }>
        }
        full.topics[0].sections[0].items[0].content = '- Use a newer mail adapter.'
        return Promise.resolve(JSON.stringify(full))
      },
    )

    await expect(
      proposeLegacyTopicization('agt_test', { agent: {} as never }),
    ).rejects.toMatchObject({ code: 'TOPICIZATION_COVERAGE_FAILED' })
    expect(detectMemoryHierarchyMode('agt_test')).toBe('legacy_single_file')
  })

  it('rejects a topicization proposal above the active-topic limit before commit', async () => {
    const oversizedLegacy = Array.from(
      { length: 17 },
      (_, index) => `## Stable scope ${index + 1}\n\n- Durable fact ${index + 1}.`,
    ).join('\n\n')
    writeMemoryFile('agt_test', 'MEMORY.md', `# Legacy Memory\n\n${oversizedLegacy}`)
    mockCallMemoryProvider.mockImplementation(
      (_provider: unknown, _systemPrompt: string, userContent: string) => {
        const { blocks } = JSON.parse(userContent) as {
          blocks: Array<{ hash: string; sectionHint: string | null; content: string }>
        }
        return Promise.resolve(
          JSON.stringify({
            summary: [],
            topics: blocks.map((block, index) => ({
              title: block.sectionHint ?? `Stable scope ${index + 1}`,
              scope: `Reusable scope ${index + 1}.`,
              description: `Stable scope ${index + 1}.`,
              keywords: ['stable', `scope-${index + 1}`],
              sections: [
                {
                  section: 'Durable Knowledge',
                  items: [{ sourceHash: block.hash, content: block.content }],
                },
              ],
            })),
          }),
        )
      },
    )

    await expect(
      proposeLegacyTopicization('agt_test', { agent: {} as never }),
    ).rejects.toMatchObject({ code: 'ACTIVE_TOPIC_LIMIT' })

    expect(detectMemoryHierarchyMode('agt_test')).toBe('legacy_single_file')
    expect(listMemoryTopics('agt_test', 'all').topics).toHaveLength(0)
  })

  it('restores the legacy file when commit-time indexing fails', async () => {
    writeMemoryFile('agt_test', 'MEMORY.md', legacy)
    const preview = await proposeLegacyTopicization('agt_test', { agent: {} as never })
    mockReindexAgentFts.mockImplementationOnce(() => {
      throw new Error('index failed')
    })

    expect(() => commitLegacyTopicization('agt_test', preview.proposalId)).toThrow('index failed')
    expect(readMemoryFile('agt_test', 'MEMORY.md')).toBe(legacy)
    expect(listMemoryTopics('agt_test', 'all').topics).toHaveLength(0)
  })
})
