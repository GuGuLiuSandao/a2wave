import { createHash, randomBytes } from 'node:crypto'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { reindexAgentFts } from './memory-index.js'
import type { MemoryProviderConfig } from './memory-provider.js'
import { callMemoryProvider } from './memory-provider.js'
import {
  deleteMemoryFile,
  getMemoryStorageRoot,
  readMemoryFile,
  writeMemoryFile,
} from './memory-storage.js'
import {
  MEMORY_ACTIVE_TOPIC_LIMIT,
  MEMORY_MAIN_FILE,
  MemoryTopicError,
  type MemoryTopicMetadata,
  type MemoryTopicSection,
  createTopicId,
  detectMemoryHierarchyMode,
  estimateMemoryTokens,
  hashMemoryBlock,
  listMemoryTopics,
  parseMemoryTopicFile,
  renderMemoryMain,
  renderMemoryTopicFile,
  topicPath,
} from './memory-topics.js'

const PROPOSAL_TTL_MS = 30 * 60 * 1000
const migrationProposals = new Map<string, InternalTopicizationProposal>()
const MIGRATION_SECTIONS = new Set<MemoryTopicSection>([
  'Durable Knowledge',
  'Decisions and Conventions',
  'Workflows',
  'Failure Patterns',
])

export interface LegacyMemoryBlock {
  id: string
  hash: string
  sectionHint: string | null
  content: string
}

interface ProposedSection {
  section: MemoryTopicSection
  items: Array<{ sourceHash: string; content: string }>
}

interface ProposedTopic {
  title: string
  scope: string
  description: string
  keywords: string[]
  sections: ProposedSection[]
}

interface ProviderTopicizationPlan {
  summary: string[]
  topics: ProposedTopic[]
}

interface InternalTopicizationTopic extends MemoryTopicMetadata {
  path: string
  body: string
  sourceHashes: string[]
}

interface InternalTopicizationProposal {
  proposalId: string
  agentId: string
  legacyHash: string
  legacyContent: string
  expiresAt: number
  summary: string[]
  topics: InternalTopicizationTopic[]
  manifest: Array<{
    sourceBlockHash: string
    destinationTopicId: string
    destinationBlockHash: string
  }>
}

export interface TopicizationPreview {
  proposalId: string
  expiresAt: string
  sourceBlockCount: number
  topics: Array<{
    topicId: string
    title: string
    scope: string
    description: string
    keywords: string[]
    sourceBlockCount: number
    tokenCount: number
  }>
  summary: string[]
  manifest: InternalTopicizationProposal['manifest']
}

function normalizeBlockContent(content: string): string {
  return content.trim().replace(/\r\n/g, '\n')
}

export function splitLegacyMemoryBlocks(content: string): LegacyMemoryBlock[] {
  const lines = content.replace(/\r\n/g, '\n').split('\n')
  const blocks: LegacyMemoryBlock[] = []
  let sectionHint: string | null = null
  let buffer: string[] = []

  const flush = () => {
    const value = normalizeBlockContent(buffer.join('\n'))
    buffer = []
    if (!value) return
    const hash = hashMemoryBlock(value)
    blocks.push({ id: `src_${blocks.length + 1}`, hash, sectionHint, content: value })
  }

  for (const line of lines) {
    const heading = line.match(/^#{1,3}\s+(.+)$/)
    if (heading) {
      flush()
      sectionHint = heading[1].trim()
      continue
    }
    if (!line.trim()) {
      flush()
      continue
    }
    if (/^[-*]\s+/.test(line) && buffer.length > 0) flush()
    buffer.push(line)
  }
  flush()
  return blocks
}

function extractJsonObject(raw: string): Record<string, unknown> | null {
  const text = raw
    .trim()
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/, '')
  const start = text.indexOf('{')
  const end = text.lastIndexOf('}')
  if (start === -1 || end <= start) return null
  try {
    const value = JSON.parse(text.slice(start, end + 1))
    return value && typeof value === 'object' ? (value as Record<string, unknown>) : null
  } catch {
    return null
  }
}

function parseTopicizationPlan(raw: string): ProviderTopicizationPlan {
  const value = extractJsonObject(raw)
  if (!value || !Array.isArray(value.topics) || !Array.isArray(value.summary)) {
    throw new MemoryTopicError('INVALID_TOPICIZATION_PLAN', 'Invalid topicization provider output')
  }
  return {
    summary: value.summary.filter((item): item is string => typeof item === 'string'),
    topics: value.topics as ProposedTopic[],
  }
}

function topicBody(title: string, sections: ProposedSection[]): string {
  const parts = [`# ${title}`]
  for (const section of sections) {
    if (!Array.isArray(section.items) || section.items.length === 0) continue
    parts.push(
      `## ${section.section}`,
      section.items.map((item) => normalizeBlockContent(item.content)).join('\n\n'),
    )
  }
  return parts.join('\n\n')
}

function normalizedSummaryItems(summary: string[], legacyContent: string): string[] {
  const normalizedLegacy = normalizeBlockContent(legacyContent)
  return summary
    .map((item) => item.trim().replace(/^[-*]\s+/, ''))
    .filter(Boolean)
    .map((item) => {
      if (!normalizedLegacy.includes(item)) {
        throw new MemoryTopicError(
          'TOPICIZATION_COVERAGE_FAILED',
          'A startup summary item is not an exact excerpt from legacy MEMORY.md',
        )
      }
      return item
    })
}

function validateAndBuildProposal(
  agentId: string,
  legacyContent: string,
  blocks: LegacyMemoryBlock[],
  plan: ProviderTopicizationPlan,
): InternalTopicizationProposal {
  if (blocks.length === 0) {
    throw new MemoryTopicError('EMPTY_LEGACY_MEMORY', 'Legacy MEMORY.md has no semantic blocks')
  }
  if (!Array.isArray(plan.topics) || plan.topics.length === 0) {
    throw new MemoryTopicError('INVALID_TOPICIZATION_PLAN', 'At least one topic is required')
  }
  if (plan.topics.length > MEMORY_ACTIVE_TOPIC_LIMIT) {
    throw new MemoryTopicError(
      'ACTIVE_TOPIC_LIMIT',
      `Topicization cannot create more than ${MEMORY_ACTIVE_TOPIC_LIMIT} active topics`,
    )
  }

  const sourceByHash = new Map(blocks.map((block) => [block.hash, block]))
  const assigned = new Map<string, string>()
  const manifest: InternalTopicizationProposal['manifest'] = []
  const now = new Date().toISOString()
  const topics: InternalTopicizationTopic[] = []

  for (const rawTopic of plan.topics) {
    if (!rawTopic || typeof rawTopic !== 'object' || !Array.isArray(rawTopic.sections)) {
      throw new MemoryTopicError('INVALID_TOPICIZATION_PLAN', 'Invalid proposed topic')
    }
    const topicId = createTopicId()
    const metadata: MemoryTopicMetadata = {
      topicId,
      title: rawTopic.title,
      scope: rawTopic.scope,
      description: rawTopic.description,
      keywords: rawTopic.keywords,
      status: 'active',
      updatedAt: now,
    }
    const sourceHashes: string[] = []
    for (const section of rawTopic.sections) {
      if (!MIGRATION_SECTIONS.has(section.section) || !Array.isArray(section.items)) {
        throw new MemoryTopicError('INVALID_TOPICIZATION_PLAN', 'Invalid topic section')
      }
      for (const item of section.items) {
        const source = sourceByHash.get(item.sourceHash)
        if (!source) {
          throw new MemoryTopicError(
            'TOPICIZATION_COVERAGE_FAILED',
            'Topicization references an unknown source block',
          )
        }
        if (assigned.has(source.hash)) {
          throw new MemoryTopicError(
            'TOPICIZATION_COVERAGE_FAILED',
            'A source block was assigned to more than one topic',
          )
        }
        const destinationContent = normalizeBlockContent(item.content)
        if (!destinationContent) {
          throw new MemoryTopicError('TOPICIZATION_COVERAGE_FAILED', 'A destination block is empty')
        }
        if (destinationContent !== source.content) {
          throw new MemoryTopicError(
            'TOPICIZATION_COVERAGE_FAILED',
            'Topicization must copy every legacy source block verbatim',
          )
        }
        assigned.set(source.hash, topicId)
        sourceHashes.push(source.hash)
        manifest.push({
          sourceBlockHash: source.hash,
          destinationTopicId: topicId,
          destinationBlockHash: hashMemoryBlock(destinationContent),
        })
      }
    }
    const body = topicBody(metadata.title, rawTopic.sections)
    const path = topicPath(metadata)
    parseMemoryTopicFile(path, renderMemoryTopicFile(metadata, body))
    topics.push({ ...metadata, path, body, sourceHashes })
  }

  const missing = blocks.filter((block) => !assigned.has(block.hash))
  if (missing.length > 0) {
    throw new MemoryTopicError(
      'TOPICIZATION_COVERAGE_FAILED',
      `${missing.length} source block(s) have no destination`,
    )
  }

  const renderedTopics = topics.map((topic) =>
    parseMemoryTopicFile(topic.path, renderMemoryTopicFile(topic, topic.body)),
  )
  const summary = normalizedSummaryItems(plan.summary, legacyContent)
  renderMemoryMain(summary.map((item) => `- ${item}`).join('\n'), renderedTopics)

  return {
    proposalId: `mtp_${randomBytes(12).toString('hex')}`,
    agentId,
    legacyHash: createHash('sha256').update(legacyContent).digest('hex'),
    legacyContent,
    expiresAt: Date.now() + PROPOSAL_TTL_MS,
    summary,
    topics,
    manifest,
  }
}

function toPreview(
  proposal: InternalTopicizationProposal,
  sourceBlockCount: number,
): TopicizationPreview {
  return {
    proposalId: proposal.proposalId,
    expiresAt: new Date(proposal.expiresAt).toISOString(),
    sourceBlockCount,
    topics: proposal.topics.map((topic) => ({
      topicId: topic.topicId,
      title: topic.title,
      scope: topic.scope,
      description: topic.description,
      keywords: topic.keywords,
      sourceBlockCount: topic.sourceHashes.length,
      tokenCount: estimateMemoryTokens(topic.body),
    })),
    summary: proposal.summary,
    manifest: proposal.manifest,
  }
}

export async function proposeLegacyTopicization(
  agentId: string,
  provider: MemoryProviderConfig,
): Promise<TopicizationPreview> {
  if (detectMemoryHierarchyMode(agentId) !== 'legacy_single_file') {
    throw new MemoryTopicError('TOPICIZATION_NOT_REQUIRED', 'Agent is not in legacy memory mode')
  }
  const legacyContent = readMemoryFile(agentId, MEMORY_MAIN_FILE)
  const blocks = splitLegacyMemoryBlocks(legacyContent)
  const result = await callMemoryProvider(
    provider,
    `a2wave-memory-v2-topicization

Group every source block into a bounded topic by stable reuse scope. Do not group by date, generic
fact type, or one Run. Copy every source block verbatim, exactly once, into topics. Do not paraphrase,
shorten, combine, or split a source block. Summary entries are optional exact excerpts from source
blocks and do not count as coverage.

Return one JSON object only:
{"summary":["exact source excerpt"],"topics":[{"title":"title","scope":"stable scope","description":"max 100 characters","keywords":["1-6 keywords"],"sections":[{"section":"Durable Knowledge","items":[{"sourceHash":"sha256","content":"exact source block content"}]}]}]}

Allowed sections: Durable Knowledge, Decisions and Conventions, Workflows, Failure Patterns.
Do not include markdown fences or commentary.`,
    JSON.stringify({ blocks }),
    4096,
  )
  if (!result) {
    throw new MemoryTopicError('TOPICIZATION_PROVIDER_FAILED', 'Topicization provider failed')
  }
  const proposal = validateAndBuildProposal(
    agentId,
    legacyContent,
    blocks,
    parseTopicizationPlan(result),
  )
  migrationProposals.set(proposal.proposalId, proposal)
  return toPreview(proposal, blocks.length)
}

export function commitLegacyTopicization(agentId: string, proposalId: string): TopicizationPreview {
  const proposal = migrationProposals.get(proposalId)
  if (!proposal || proposal.agentId !== agentId || proposal.expiresAt < Date.now()) {
    migrationProposals.delete(proposalId)
    throw new MemoryTopicError('TOPICIZATION_PROPOSAL_EXPIRED', 'Topicization proposal expired')
  }
  if (detectMemoryHierarchyMode(agentId) !== 'legacy_single_file') {
    throw new MemoryTopicError('TOPICIZATION_CONFLICT', 'Memory hierarchy changed after preview')
  }
  const current = readMemoryFile(agentId, MEMORY_MAIN_FILE)
  if (createHash('sha256').update(current).digest('hex') !== proposal.legacyHash) {
    throw new MemoryTopicError('TOPICIZATION_CONFLICT', 'Legacy MEMORY.md changed after preview')
  }
  if (listMemoryTopics(agentId, 'all').topics.length > 0) {
    throw new MemoryTopicError(
      'TOPICIZATION_CONFLICT',
      'Unexpected topic files exist while the Agent is in legacy mode',
    )
  }

  const backupDir = join(getMemoryStorageRoot(), '.migration-backups', agentId)
  mkdirSync(backupDir, { recursive: true })
  const backupPath = join(backupDir, `${Date.now()}-${proposal.legacyHash.slice(0, 12)}.md`)
  writeFileSync(backupPath, proposal.legacyContent, 'utf8')

  const writtenPaths: string[] = []
  try {
    for (const topic of proposal.topics) {
      writeMemoryFile(agentId, topic.path, renderMemoryTopicFile(topic, topic.body))
      writtenPaths.push(topic.path)
    }
    const records = listMemoryTopics(agentId, 'active').topics
    const main = renderMemoryMain(proposal.summary.map((item) => `- ${item}`).join('\n'), records)
    writeMemoryFile(agentId, MEMORY_MAIN_FILE, main)
    reindexAgentFts(agentId)
  } catch (err) {
    for (const path of writtenPaths) {
      try {
        deleteMemoryFile(agentId, path)
      } catch {
        // Best effort cleanup; the unchanged legacy main remains authoritative.
      }
    }
    writeMemoryFile(agentId, MEMORY_MAIN_FILE, proposal.legacyContent)
    try {
      reindexAgentFts(agentId)
    } catch {
      // The next search will detect stale mtimes and rebuild from the restored legacy file.
    }
    throw err
  }

  migrationProposals.delete(proposalId)
  return toPreview(proposal, proposal.manifest.length)
}

export function clearTopicizationProposalsForTest(): void {
  migrationProposals.clear()
}
