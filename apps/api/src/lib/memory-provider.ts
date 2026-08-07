import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { agents } from '../db/schema.js'
import { type AgentConfig, buildAgentConfig } from './agent-helpers.js'
import { executeWithRetry } from './execute-with-retry.js'
import { logger } from './logger.js'

type AgentRow = typeof agents.$inferSelect

export interface MemoryProviderConfig {
  agent: AgentRow
}

/** Check if a config value is explicitly set to false (handles string "false" from frontend) */
export function isConfigDisabled(value: unknown): boolean {
  return value === false || value === 'false'
}

/**
 * Resolve a numeric config value, falling back only when it is genuinely unset
 * or unparseable.
 *
 * `Number(value) || fallback` cannot express this: 0 is falsy, so it discards a
 * legitimate 0 — and 0 is a first-class value for these settings (`mmrLambda=0`
 * is pure-diversity MMR, `halfLife=0` is no temporal decay), not a synonym for
 * "unset". Accepts numeric strings because the web UI submits these fields raw.
 */
export function resolveNumericConfig(value: unknown, fallback: number): number {
  if (typeof value === 'number') return Number.isFinite(value) ? value : fallback
  if (typeof value === 'string' && value.trim()) {
    const parsed = Number(value)
    return Number.isFinite(parsed) ? parsed : fallback
  }
  return fallback
}

async function buildMemoryAgentConfig(agent: AgentRow, systemPrompt: string): Promise<AgentConfig> {
  const agentConfig = await buildAgentConfig(agent)
  if (!agentConfig.engineType) {
    agentConfig.engineType = agent.type
  }
  const cfg = (agent.config ?? {}) as Record<string, unknown>
  const memoryModel =
    typeof cfg.memoryModel === 'string' && cfg.memoryModel.trim()
      ? cfg.memoryModel.trim()
      : typeof cfg.memoryProviderModel === 'string' && cfg.memoryProviderModel.trim()
        ? cfg.memoryProviderModel.trim()
        : null
  if (memoryModel) {
    agentConfig.model = memoryModel
    if (Array.isArray(agentConfig.providerChain)) {
      agentConfig.providerChain = agentConfig.providerChain.map((binding, index) =>
        index === 0 && binding && typeof binding === 'object'
          ? { ...binding, model: memoryModel }
          : binding,
      )
    }
  }

  return {
    ...agentConfig,
    systemPrompt,
    memoryEnabled: false,
    memoryContextMode: 'off',
    resolvedSkills: undefined,
    resolvedMcpServers: undefined,
    resolvedKbDocs: undefined,
    availableAgentsSummary: undefined,
    readOnly: true,
    force: false,
  }
}

let memoryTaskSeq = 0

function nextMemoryTaskId(agentId: string): string {
  memoryTaskSeq += 1
  return `mem_${agentId}_${Date.now()}_${memoryTaskSeq}`
}

function createMemoryRuntimeDir(agentId: string): string {
  const root = join(tmpdir(), 'a2wave-memory-runtime')
  mkdirSync(root, { recursive: true })
  const safeAgentId = agentId.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 80) || 'agent'
  return mkdtempSync(join(root, `${safeAgentId}-`))
}

/**
 * Runs memory maintenance through the same provider/engine path as normal Runs.
 *
 * Returns provider output text, or null on failure.
 */
export async function callMemoryProvider(
  provider: MemoryProviderConfig,
  systemPrompt: string,
  userContent: string,
  _maxTokens?: number,
): Promise<string | null> {
  const agentConfig = buildMemoryAgentConfig(provider.agent, systemPrompt)
  const taskId = nextMemoryTaskId(provider.agent.id)
  const workDir = createMemoryRuntimeDir(provider.agent.id)

  try {
    const { result } = await executeWithRetry(taskId, {
      taskId,
      prompt: userContent,
      model: (await agentConfig).model,
      workDir,
      agentConfig: await agentConfig,
    })

    if (!result.success) {
      logger.warn(
        { agentId: provider.agent.id, taskId, error: result.error },
        'Memory provider execution failed',
      )
      return null
    }

    const output = result.output.trim()
    return output || null
  } finally {
    try {
      rmSync(workDir, { recursive: true, force: true })
    } catch (error) {
      logger.warn(
        { agentId: provider.agent.id, taskId, workDir, error },
        'Failed to remove memory runtime workspace',
      )
    }
  }
}
