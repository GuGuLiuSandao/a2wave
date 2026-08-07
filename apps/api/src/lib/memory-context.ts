/**
 * 主动记忆上下文注入
 * Run 启动时根据 memoryContextMode 决定注入内容：
 *   off    → 不注入（返回 null）
 *   memory → 全量注入 MEMORY.md（长期记忆：用户偏好、领域约定、历史决策）
 * 工作日志不在此注入，由 agent 按需通过 a2wave-memory skill 主动搜索。
 * 回想策略行为指令由 buildRecallInstruction 单独返回，注入 <recall_strategy> 标签。
 */
import { logger } from './logger.js'
import { type MemoryRecallLevel, getRecallBehaviorInstruction } from './memory-storage.js'
import { getValidatedMemoryMain } from './memory-topics.js'

/** Check if a config value is explicitly set to false (handles string "false" from frontend) */
function isConfigDisabled(value: unknown): boolean {
  return value === false || value === 'false'
}

const VALID_RECALL_LEVELS = new Set<string>(['weak', 'medium', 'strong'])
const VALID_CONTEXT_MODES = new Set<string>(['off', 'memory'])
const MEMORY_MD = 'MEMORY.md'

const SKILL_SLUG = 'a2wave-memory'
const SEARCH_SCRIPT = 'scripts/memory-search.mjs'

/** 根据 agentConfig 返回当前档位的回想策略指令文本，供独立注入 <recall_strategy> 标签 */
export function buildRecallInstruction(agentConfig: Record<string, unknown>): string {
  const raw = agentConfig.memoryRecallLevel as string
  const recallLevel: MemoryRecallLevel = VALID_RECALL_LEVELS.has(raw)
    ? (raw as MemoryRecallLevel)
    : 'medium'
  const skillsDir = agentConfig.skillsDir as string | undefined
  const scriptPath = skillsDir ? `${skillsDir}/${SKILL_SLUG}/${SEARCH_SCRIPT}` : undefined

  const rawMode = agentConfig.memoryContextMode as string
  const legacyDisabled =
    !VALID_CONTEXT_MODES.has(rawMode) &&
    rawMode !== 'full' &&
    isConfigDisabled(agentConfig.memoryContextInjection)
  const memoryInjected = rawMode !== 'off' && !legacyDisabled

  return getRecallBehaviorInstruction(recallLevel, scriptPath, memoryInjected)
}

type MemoryContextMode = 'off' | 'memory'

export async function buildMemoryContext(
  agentId: string,
  agentConfig: Record<string, unknown>,
): Promise<string | null> {
  const rawMode = agentConfig.memoryContextMode as string
  // 'full' 已废弃，视同 'memory'；backward compat: 尊重旧 memoryContextInjection=false
  const legacyDisabled =
    !VALID_CONTEXT_MODES.has(rawMode) &&
    rawMode !== 'full' &&
    isConfigDisabled(agentConfig.memoryContextInjection)
  const contextMode: MemoryContextMode =
    rawMode === 'off' ? 'off' : legacyDisabled ? 'off' : 'memory'

  if (contextMode === 'off') return null

  let memoryMdContent: string | null = null
  try {
    memoryMdContent = getValidatedMemoryMain(agentId)
  } catch (err) {
    if (err instanceof Error && err.message === 'File not found') {
      // 文件不存在，跳过
    } else {
      logger.warn({ agentId, err }, 'Failed to read MEMORY.md for context injection')
    }
  }

  if (!memoryMdContent) return null

  return [
    '以下是本次会话注入的长期记忆（MEMORY.md），包含用户偏好、领域约定和历史决策，作为固定背景知识使用。',
    '如需搜索历史工作日志或按用户明确指示维护长期记忆，请主动调用 a2wave-memory skill。',
    '',
    `--- ${MEMORY_MD} ---`,
    memoryMdContent,
  ].join('\n')
}
