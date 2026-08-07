/**
 * 自动工作日志生成器
 * Run 完成后，用 Agent Provider 总结 ChatMessages，追加写入 memory/YYYY-MM-DD.md
 */
import { DEFAULT_MEMORY_INSIGHT_PROMPT, DEFAULT_MEMORY_WORKLOG_PROMPT } from '@a2wave/shared'
import { eq } from 'drizzle-orm'
import { db } from '../db/client.js'
import { agents, chatMessages, runSteps } from '../db/schema.js'
import type { StreamLogEntry } from '../engine/types.js'
import {
  isExplicitMemoryMutationRequest,
  isMemoryPersistenceOptOutRequest,
} from './agent-memory-token.js'
import { getEmbeddings, isEmbeddingAvailable } from './embedding-service.js'
import { logger } from './logger.js'
import { consolidateMemory } from './memory-consolidation.js'
import { reindexAgentFts, reindexAgentVectors } from './memory-index.js'
import { isConfigDisabled } from './memory-provider.js'
import { type MemoryProviderConfig, callMemoryProvider } from './memory-provider.js'
import {
  checkSizeLimit,
  enforceCapacity,
  getMemoryStats,
  queueAgentWrite,
  readMemoryFile,
  writeMemoryFile,
} from './memory-storage.js'
import {
  type MemoryTopicInsight,
  appendAgentSummaryItems,
  applyInsightToTopics,
  detectMemoryHierarchyMode,
} from './memory-topics.js'

const MAX_CONTENT_CHARS = 8000

const DEFAULT_MEMORY_MD_CHAR_LIMIT = 3575
const DEFAULT_MEMORY_MD_COMPRESS_TARGET = 2400
const MAX_MEMORY_COMPRESSION_ATTEMPTS = 3
const MEMORY_MD_CHAR_LIMIT_MIN = 1000
const MEMORY_MD_CHAR_LIMIT_MAX = 200_000
const MEMORY_MD_COMPRESS_TARGET_MIN = 500

function clampNumber(value: unknown, fallback: number, min: number, max: number): number {
  const parsed =
    typeof value === 'number'
      ? value
      : typeof value === 'string' && value.trim()
        ? Number(value)
        : Number.NaN
  if (!Number.isFinite(parsed)) return fallback
  return Math.max(min, Math.min(max, Math.floor(parsed)))
}

function getMemoryCompressionConfig(agentCfg: Record<string, unknown>): {
  charLimit: number
  compressTarget: number
} {
  const charLimit = clampNumber(
    agentCfg.memoryCompressionThresholdChars,
    DEFAULT_MEMORY_MD_CHAR_LIMIT,
    MEMORY_MD_CHAR_LIMIT_MIN,
    MEMORY_MD_CHAR_LIMIT_MAX,
  )
  const compressTarget = clampNumber(
    agentCfg.memoryCompressionTargetChars,
    Math.min(DEFAULT_MEMORY_MD_COMPRESS_TARGET, charLimit - 1),
    MEMORY_MD_COMPRESS_TARGET_MIN,
    Math.max(MEMORY_MD_COMPRESS_TARGET_MIN, charLimit - 1),
  )
  return { charLimit, compressTarget }
}

/**
 * 工作日志 system prompt 默认模板。
 * 支持占位符 {{time}}（替换为 HH:MM 时间字符串）。
 * 可通过 agent 配置 memoryWorklogPrompt 覆盖。
 */
export const DEFAULT_WORKLOG_PROMPT = DEFAULT_MEMORY_WORKLOG_PROMPT

/**
 * 洞察提取 system prompt 默认模板。
 * 支持占位符 {{existingMemory}}（替换为现有 MEMORY.md 内容，用于去重）。
 * 可通过 agent 配置 memoryInsightPrompt 覆盖。
 */
export const DEFAULT_INSIGHT_PROMPT = DEFAULT_MEMORY_INSIGHT_PROMPT

const CUSTOM_INSIGHT_OUTPUT_CONTRACT = `Platform output contract (required; overrides any output-format instruction above):
- The insight section must be a single JSON object and nothing else.
- Use exactly this shape: {"topics":[{"title":"bounded topic title","scope":"stable reuse boundary","description":"short catalog description","keywords":["keyword"],"section":"Durable Knowledge","items":["stable fact"]}],"summary":["cross-topic startup fact"]}
- section must be one of Durable Knowledge, Decisions and Conventions, Workflows, or Failure Patterns.
- If nothing qualifies, output {"topics":[],"summary":[]}.`

function getMemoryProvider(agent: typeof agents.$inferSelect): MemoryProviderConfig {
  return { agent }
}

/** Per-agent Promise chain to serialize concurrent writes */
const writeQueues = new Map<string, Promise<void>>()

interface WorkLogSnapshot {
  messages: Array<{ role: string; content: string }>
  steps: Array<{ output: unknown }>
}

/** Exported for testing */
export function clearWriteQueues(): void {
  writeQueues.clear()
}

/**
 * Generate a work log entry for a completed Run.
 * Serializes writes per-agent to prevent concurrent read-append-write data loss.
 */
export async function generateWorkLog(
  agentId: string,
  runId: string,
  success: boolean,
  stepId?: string,
): Promise<void> {
  let snapshot: WorkLogSnapshot
  try {
    const messages = await db
      .select()
      .from(chatMessages)
      .where(eq(chatMessages.runId, runId))
      .orderBy(chatMessages.createdAt)
    let currentTurnStart = -1
    for (let index = messages.length - 1; index >= 0; index--) {
      if (messages[index]?.role === 'user') {
        currentTurnStart = index
        break
      }
    }
    snapshot = {
      messages: currentTurnStart === -1 ? messages : messages.slice(currentTurnStart),
      steps: stepId
        ? await db.select({ output: runSteps.output }).from(runSteps).where(eq(runSteps.id, stepId))
        : [],
    }
  } catch (err) {
    return Promise.reject(err)
  }

  const prev = writeQueues.get(agentId) ?? Promise.resolve()
  const next = prev
    .then(() => doGenerateWorkLog(agentId, runId, success, snapshot))
    .catch((err) => {
      logger.error({ err, agentId, runId }, 'Work log generation failed')
    })
    .finally(() => {
      if (writeQueues.get(agentId) === next) {
        writeQueues.delete(agentId)
      }
    })
  writeQueues.set(agentId, next)
  return next
}

/** 根据启用的功能组合动态构建 Provider system prompt */
function buildSystemPrompt(opts: {
  worklogEnabled: boolean
  insightEnabled: boolean
  timeStr: string
  existingMemoryMd: string
  customWorklogPrompt?: string | null
  customInsightPrompt?: string | null
}): string {
  const {
    worklogEnabled,
    insightEnabled,
    timeStr,
    existingMemoryMd,
    customWorklogPrompt,
    customInsightPrompt,
  } = opts

  const worklogSection = (customWorklogPrompt ?? DEFAULT_WORKLOG_PROMPT).replace(
    '{{time}}',
    timeStr,
  )

  const configuredInsightSection = (customInsightPrompt ?? DEFAULT_INSIGHT_PROMPT).replace(
    '{{existingMemory}}',
    existingMemoryMd,
  )
  const insightSection = customInsightPrompt
    ? `${configuredInsightSection}\n\n${CUSTOM_INSIGHT_OUTPUT_CONTRACT}`
    : configuredInsightSection

  if (worklogEnabled && insightEnabled) {
    return `${worklogSection}

---

此外，${insightSection}

如果有值得新增的洞察，在日志之后另起一行输出：
---INSIGHTS---
{"topics":[...],"summary":[...]}

JSON 的字段和约束以洞察提取指令为准。如果没有值得新增的内容，可以不输出
---INSIGHTS--- 段，也可以输出 {"topics":[],"summary":[]}。`
  }

  if (worklogEnabled) {
    return worklogSection
  }

  // insight only
  return `你是一个记忆提取助手。${insightSection}`
}

async function doGenerateWorkLog(
  agentId: string,
  runId: string,
  success: boolean,
  snapshot: WorkLogSnapshot,
): Promise<void> {
  // 1. Check agent memoryEnabled + feature flags
  const agent = (await db.select().from(agents).where(eq(agents.id, agentId)).limit(1))[0]
  if (!agent) return
  const agentCfg = (agent.config || {}) as Record<string, unknown>
  if (!agentCfg.memoryEnabled) return

  const worklogEnabled = !isConfigDisabled(agentCfg.memoryWorklogEnabled)
  const insightEnabled = !isConfigDisabled(agentCfg.memoryAutoInsight)
  if (!worklogEnabled && !insightEnabled) return

  const customWorklogPrompt = (agentCfg.memoryWorklogPrompt as string | null | undefined) || null
  const customInsightPrompt = (agentCfg.memoryInsightPrompt as string | null | undefined) || null
  const memoryCompression = getMemoryCompressionConfig(agentCfg)

  const provider = getMemoryProvider(agent)

  // 2. Use the current-turn snapshot captured before this job entered the per-Agent queue.
  // A Run may contain several chat turns, and later turns can arrive while an earlier memory
  // job is still waiting. Reading the full Run here would let an old opt-out suppress every
  // future turn and could leak later messages into an earlier summary.
  const { messages, steps } = snapshot
  if (messages.length === 0) return

  const userPrompts = messages
    .filter((message) => message.role === 'user')
    .map((message) => message.content)
  const skipReason = userPrompts.some(isMemoryPersistenceOptOutRequest)
    ? 'user-opt-out'
    : userPrompts.some(isExplicitMemoryMutationRequest)
      ? 'explicit-interactive-mutation'
      : null
  if (skipReason) {
    logger.info(
      { agentId, runId, reason: skipReason },
      'Background memory persistence skipped for Run',
    )
    return
  }

  // 2b. Include only the current execution step's process details.
  const processLines: string[] = []
  for (const step of steps) {
    const logs = (step.output as Record<string, unknown> | null)?.logs as
      | StreamLogEntry[]
      | undefined
    if (!logs) continue
    for (const entry of logs) {
      if (entry.type === 'assistant' && entry.text) {
        processLines.push(`[assistant-thought]: ${entry.text}`)
      } else if (entry.type === 'tool_call' && entry.subtype === 'started') {
        processLines.push(`[tool-call]: ${entry.toolName}`)
      }
    }
  }

  // 3. Build conversation text, truncate if too long
  let conversationText = messages.map((m) => `[${m.role}]: ${m.content}`).join('\n\n')

  if (processLines.length > 0) {
    conversationText += `\n\n--- Process Details ---\n${processLines.join('\n')}`
  }

  if (conversationText.length > MAX_CONTENT_CHARS) {
    conversationText = `[Conversation truncated: only the latest ${MAX_CONTENT_CHARS} characters are shown; earlier messages and process details were omitted.]\n\n${conversationText.slice(-MAX_CONTENT_CHARS)}`
  }

  const now = new Date()
  const timeStr = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`
  const statusNote = success ? '' : '\n\n> Note: This run ended with an error.'

  // 4. Read MEMORY.md for insight dedup (only needed when insight is enabled)
  let existingMemoryMd = ''
  const hierarchyMode = detectMemoryHierarchyMode(agentId)
  if (insightEnabled) {
    try {
      existingMemoryMd = readMemoryFile(agentId, 'MEMORY.md')
    } catch {
      /* not yet created */
    }
  }

  // 5. Invoke the configured agent provider through the same engine path as normal runs.
  const rawSummary = await callMemoryProvider(
    provider,
    buildSystemPrompt({
      worklogEnabled,
      insightEnabled,
      timeStr,
      existingMemoryMd,
      customWorklogPrompt,
      customInsightPrompt,
    }),
    `${conversationText}${statusNote}`,
    1024,
  )

  if (!rawSummary) {
    logger.error({ agentId, runId }, 'Memory provider summarization failed or returned empty')
    return
  }

  // 6. Parse response based on what was requested
  let dailyLog: string | null = null
  let insightsRaw: string | null = null

  if (worklogEnabled && insightEnabled) {
    const [log, ...insightParts] = rawSummary.split(/---\s*INSIGHTS\s*---/i)
    dailyLog = log?.trim() || null
    insightsRaw = insightParts.join('\n---INSIGHTS---\n').trim() || null
  } else if (worklogEnabled) {
    dailyLog = rawSummary.trim()
  } else {
    // insight only: LLM outputs raw bullets, strip optional marker if present
    insightsRaw = rawSummary.replace(/^---\s*INSIGHTS\s*---\s*/i, '').trim() || null
  }

  // 7. Write daily log (independent of insight write)
  const dateStr = now.toISOString().slice(0, 10)
  const filename = `memory/${dateStr}.md`

  if (worklogEnabled && dailyLog) {
    const logContent = dailyLog
    await queueAgentWrite(
      agentId,
      () => {
        let existing = ''
        try {
          existing = readMemoryFile(agentId, filename)
        } catch {
          /* not yet created */
        }

        const newContent = existing ? `${existing}\n\n${logContent}` : logContent
        const contentSize = Buffer.byteLength(newContent, 'utf-8')
        if (!checkSizeLimit(agentId, contentSize, filename)) {
          logger.warn(
            { agentId, runId, filename },
            'Work log skipped: memory storage limit exceeded',
          )
          return
        }
        writeMemoryFile(agentId, filename, newContent)
      },
      { operation: 'append-daily-worklog', filename, runId },
    )
  }

  // 8. Route insights to topics. Legacy single-file Agents keep their existing behavior until
  // an editor completes topicization, avoiding a half-migrated hierarchy.
  if (insightEnabled && insightsRaw) {
    if (hierarchyMode === 'legacy_single_file') {
      await writeLegacyInsights(
        agentId,
        runId,
        filename,
        timeStr,
        insightsRaw,
        provider,
        memoryCompression,
      )
    } else {
      await writeTopicInsights(
        agentId,
        runId,
        filename,
        timeStr,
        insightsRaw,
        worklogEnabled && !!dailyLog,
      )
    }
  }

  // 9. Enforce capacity before reindex so deleted files are not indexed
  enforceCapacity(agentId)

  // 10. Reindex
  reindexAgentFts(agentId)
  if (await isEmbeddingAvailable(agentId)) {
    void reindexAgentVectors(agentId, (texts) => getEmbeddings(texts, agentId))
  }

  // 11. Consolidate old daily logs if threshold exceeded
  if (!isConfigDisabled(agentCfg.memoryConsolidationEnabled)) {
    const stats = getMemoryStats(agentId)
    if (stats.dailyFileCount > 30) {
      void consolidateMemory(agentId, provider, { maxAgeDays: 30 })
    }
  }

  logger.info({ agentId, runId }, 'Auto work log generated')
}

interface TopicInsightEnvelope {
  topics: MemoryTopicInsight[]
  summary: string[]
}

export function parseTopicInsightEnvelope(raw: string): TopicInsightEnvelope | null {
  const unfenced = raw
    .trim()
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/, '')
  const start = unfenced.indexOf('{')
  const end = unfenced.lastIndexOf('}')
  if (start === -1 || end <= start) return null

  try {
    const parsed = JSON.parse(unfenced.slice(start, end + 1)) as Record<string, unknown>
    if (!Array.isArray(parsed.topics) || !Array.isArray(parsed.summary)) return null
    const topics: MemoryTopicInsight[] = []
    for (const value of parsed.topics) {
      if (!value || typeof value !== 'object') return null
      const item = value as Record<string, unknown>
      if (
        typeof item.title !== 'string' ||
        typeof item.scope !== 'string' ||
        typeof item.description !== 'string' ||
        !Array.isArray(item.keywords) ||
        typeof item.section !== 'string' ||
        !Array.isArray(item.items)
      ) {
        return null
      }
      topics.push({
        ...(typeof item.topicId === 'string' ? { topicId: item.topicId } : {}),
        title: item.title,
        scope: item.scope,
        description: item.description,
        keywords: item.keywords.filter((entry): entry is string => typeof entry === 'string'),
        section: item.section as MemoryTopicInsight['section'],
        items: item.items.filter((entry): entry is string => typeof entry === 'string'),
      })
    }
    return {
      topics,
      summary: parsed.summary.filter((entry): entry is string => typeof entry === 'string'),
    }
  } catch {
    return null
  }
}

function renderLegacyInsights(raw: string): string {
  const envelope = parseTopicInsightEnvelope(raw)
  if (!envelope) return raw.trim()

  const sections: string[] = []
  const summaryItems = envelope.summary.map((item) => item.trim()).filter(Boolean)
  if (summaryItems.length > 0) {
    sections.push(
      [
        '## Durable Summary',
        '',
        ...summaryItems.map((item) => `- ${item.replace(/^[-*]\s+/, '')}`),
      ].join('\n'),
    )
  }

  for (const topic of envelope.topics) {
    const items = topic.items.map((item) => item.trim()).filter(Boolean)
    if (items.length === 0) continue
    const title = topic.title.trim().replace(/\s+/g, ' ')
    sections.push(
      [`## ${title}`, '', ...items.map((item) => `- ${item.replace(/^[-*]\s+/, '')}`)].join('\n'),
    )
  }

  return sections.join('\n\n')
}

async function writeTopicInsights(
  agentId: string,
  runId: string,
  filename: string,
  timeStr: string,
  insightsRaw: string,
  hasDailyLog: boolean,
): Promise<void> {
  const envelope = parseTopicInsightEnvelope(insightsRaw)
  if (!envelope) {
    logger.warn({ agentId, runId }, 'Topic insight output was invalid; retaining it in history')
    await appendInsightFallbackLog(
      agentId,
      runId,
      filename,
      timeStr,
      insightsRaw,
      '主题路由输出无效，本次洞察只保留在历史层。',
    )
    return
  }
  if (envelope.topics.length === 0 && envelope.summary.length === 0) return

  const retained: string[] = []
  let nextTopicIndex = 0
  let pendingEvidence: string | null = null
  let summaryPending = envelope.summary.length > 0
  try {
    await queueAgentWrite(
      agentId,
      () => {
        while (nextTopicIndex < envelope.topics.length) {
          const insight = envelope.topics[nextTopicIndex]
          const result = applyInsightToTopics(agentId, insight)
          if (result.retainedInHistory || !result.topic) {
            retained.push(...insight.items)
            nextTopicIndex++
            continue
          }
          nextTopicIndex++
          pendingEvidence = hasDailyLog
            ? `Run \`${runId}\`; summarized in \`${filename}\`.`
            : `Run \`${runId}\`.`
          const evidenceResult = applyInsightToTopics(
            agentId,
            {
              ...insight,
              topicId: result.topic.topicId,
              title: result.topic.title,
              scope: result.topic.scope,
              description: result.topic.description,
              keywords: result.topic.keywords,
              section: 'Evidence Pointers',
              items: [pendingEvidence],
            },
            { allowSingleNewTopicItem: true },
          )
          if (evidenceResult.retainedInHistory || !evidenceResult.topic) {
            retained.push(pendingEvidence)
          }
          if (evidenceResult.warning) {
            logger.warn(
              { agentId, runId, topicId: result.topic.topicId },
              'Memory topic reached its soft limit',
            )
          }
          pendingEvidence = null
        }

        if (envelope.summary.length > 0) {
          const summaryResult = appendAgentSummaryItems(agentId, envelope.summary)
          retained.push(...summaryResult.rejected)
        }
        summaryPending = false
      },
      { operation: 'route-auto-insights', runId },
    )
  } catch (err) {
    logger.warn({ agentId, runId, err }, 'Topic insight routing failed; retaining it in history')
    if (pendingEvidence) retained.push(pendingEvidence)
    for (const insight of envelope.topics.slice(nextTopicIndex)) retained.push(...insight.items)
    if (summaryPending) retained.push(...envelope.summary)
  }

  if (retained.length > 0) {
    await appendInsightFallbackLog(
      agentId,
      runId,
      filename,
      timeStr,
      retained.join('\n'),
      '主题达到限制或不满足创建条件，本次洞察只保留在历史层。',
    )
  }
}

async function writeLegacyInsights(
  agentId: string,
  runId: string,
  filename: string,
  timeStr: string,
  insights: string,
  provider: MemoryProviderConfig,
  memoryCompression: { charLimit: number; compressTarget: number },
): Promise<void> {
  const renderedInsights = renderLegacyInsights(insights)
  if (!renderedInsights) return
  let needsCompress = false
  let compressBase = ''

  await queueAgentWrite(
    agentId,
    () => {
      let currentMemoryMd = ''
      try {
        currentMemoryMd = readMemoryFile(agentId, 'MEMORY.md')
      } catch {
        /* not yet created */
      }

      const candidate = currentMemoryMd
        ? `${currentMemoryMd}\n\n${renderedInsights}`
        : renderedInsights
      if (candidate.length <= memoryCompression.charLimit) {
        writeMemoryFile(agentId, 'MEMORY.md', candidate)
        logger.info({ agentId, runId }, 'Auto insights appended to legacy MEMORY.md')
      } else {
        needsCompress = true
        compressBase = currentMemoryMd
      }
    },
    { operation: 'append-legacy-auto-insights', filename: 'MEMORY.md', runId },
  )

  if (!needsCompress) return
  let compressedWritten = false
  let currentCompressBase = compressBase

  for (let attempt = 1; attempt <= MAX_MEMORY_COMPRESSION_ATTEMPTS; attempt++) {
    logger.info({ agentId, attempt }, 'Legacy MEMORY.md near limit, compressing before append')
    const compressed = await compressMemoryMd(
      currentCompressBase,
      renderedInsights,
      provider,
      memoryCompression,
    )
    if (!compressed) break

    let retryBase: string | null = null
    await queueAgentWrite(
      agentId,
      () => {
        let latestMemoryMd = ''
        try {
          latestMemoryMd = readMemoryFile(agentId, 'MEMORY.md')
        } catch {
          /* not yet created */
        }

        if (latestMemoryMd !== currentCompressBase) {
          const latestCandidate = latestMemoryMd
            ? `${latestMemoryMd}\n\n${renderedInsights}`
            : renderedInsights
          if (latestCandidate.length <= memoryCompression.charLimit) {
            writeMemoryFile(agentId, 'MEMORY.md', latestCandidate)
            compressedWritten = true
            return
          }
          retryBase = latestMemoryMd
          return
        }

        writeMemoryFile(agentId, 'MEMORY.md', compressed)
        compressedWritten = true
      },
      { operation: 'compress-legacy-memory-md', filename: 'MEMORY.md', runId },
    )

    if (compressedWritten) break
    if (retryBase === null) break
    currentCompressBase = retryBase
  }

  if (!compressedWritten) {
    logger.warn({ agentId, runId }, 'Legacy MEMORY.md compression failed; retaining history')
    await appendInsightFallbackLog(
      agentId,
      runId,
      filename,
      timeStr,
      renderedInsights,
      'Legacy MEMORY.md 压缩失败，本次自动洞察未写入长期记忆。',
    )
  }
}

/**
 * 当 MEMORY.md 即将超过字数上限时，先让 Agent Provider 压缩现有内容，再追加新 insights。
 * 返回压缩后的完整内容，失败返回 null。
 */
async function compressMemoryMd(
  currentContent: string,
  newInsights: string,
  provider: MemoryProviderConfig,
  compression: { charLimit: number; compressTarget: number },
): Promise<string | null> {
  try {
    const result = await callMemoryProvider(
      provider,
      `You are a memory curator. MEMORY.md is nearing its ${compression.charLimit}-character limit (current: ${currentContent.length} chars).

Return contract:
- Return the complete final MEMORY.md content directly in this response/stdout.
- Do not create, write to, reference, or rely on any plan file, draft file, tool file, patch, or external artifact.
- Do not describe what you changed.
- Do not say the content is ready elsewhere.
- Do not include markdown fences.
- The first line must be an actual MEMORY.md memory entry, not commentary.

Compress the existing content to under ${compression.compressTarget} characters by:
- Merging similar or related entries into a single concise statement
- Removing outdated or superseded information
- Condensing verbose entries without losing meaning
- Preserving all unique facts, user preferences, and key decisions

Then append the new insights at the end.

Output only the final MEMORY.md body. Any explanatory text makes the result invalid.`,
      `Existing MEMORY.md:\n${currentContent}\n\n---NEW INSIGHTS TO APPEND---\n${newInsights}`,
      1024,
    )
    if (!result) return null
    const trimmed = result.trim()
    if (trimmed.length > compression.charLimit) return null
    return trimmed
  } catch {
    return null
  }
}

async function appendInsightFallbackLog(
  agentId: string,
  runId: string,
  filename: string,
  timeStr: string,
  insights: string,
  reason: string,
): Promise<void> {
  const fallbackLog = [
    `## ${timeStr} Long-term insight fallback`,
    `- **问题 / 发现**：${reason}`,
    '',
    insights,
  ].join('\n')

  await queueAgentWrite(
    agentId,
    () => {
      let existing = ''
      try {
        existing = readMemoryFile(agentId, filename)
      } catch {
        /* not yet created */
      }

      const newContent = existing ? `${existing}\n\n${fallbackLog}` : fallbackLog
      const contentSize = Buffer.byteLength(newContent, 'utf-8')
      if (!checkSizeLimit(agentId, contentSize, filename)) {
        logger.warn(
          { agentId, runId, filename },
          'Insight fallback skipped: memory storage limit exceeded',
        )
        return
      }
      writeMemoryFile(agentId, filename, newContent)
    },
    { operation: 'append-insight-fallback', filename, runId },
  )
}
