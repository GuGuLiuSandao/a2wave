/**
 * Embedding 服务
 * 通过 fetch() 调用 OpenAI 兼容的 Embedding API
 * 优先使用 Agent 级配置，回退到全局 Settings 配置
 */
import { eq } from 'drizzle-orm'
import { db } from '../db/client.js'
import { agents } from '../db/schema.js'
import { logger } from './logger.js'
import { isConfigDisabled } from './memory-provider.js'
import { getCategorySettings } from './settings.js'

export interface EmbeddingConfig {
  enabled: boolean
  apiKey: string
  baseUrl: string
  model: string
}

/** 从 Agent config 或全局 Settings 读取 Embedding 配置（Agent 优先） */
export async function getEmbeddingConfig(agentId?: string): Promise<EmbeddingConfig> {
  // 1. 尝试从 Agent config 读取
  if (agentId) {
    const agent = (
      await db
        .select({ config: agents.config, embeddingApiKey: agents.embeddingApiKey })
        .from(agents)
        .where(eq(agents.id, agentId))
        .limit(1)
    )[0]
    const cfg = (agent?.config ?? {}) as Record<string, unknown>
    if (cfg.embeddingEnabled !== undefined) {
      return {
        enabled: !isConfigDisabled(cfg.embeddingEnabled),
        apiKey: agent?.embeddingApiKey || '',
        baseUrl: (cfg.embeddingBaseUrl as string) || '',
        model: (cfg.embeddingModel as string) || 'text-embedding-3-large',
      }
    }
  }

  // 2. 回退到全局 Settings
  const s = getCategorySettings('embedding')
  return {
    enabled: s.enabled === 'true',
    apiKey: s.apiKey || '',
    baseUrl: s.baseUrl || '',
    model: s.model || 'text-embedding-3-large',
  }
}

/** 检查 Embedding 是否可用（需要 enabled + apiKey + baseUrl） */
export async function isEmbeddingAvailable(agentId?: string): Promise<boolean> {
  const config = await getEmbeddingConfig(agentId)
  return config.enabled && !!config.apiKey && !!config.baseUrl
}

/** 获取 API 端点 */
function getApiUrl(config: EmbeddingConfig): string {
  const base = config.baseUrl.replace(/\/+$/, '')
  return `${base}/v1/embeddings`
}

/** 调用 Embedding API */
export async function getEmbeddings(texts: string[], agentId?: string): Promise<number[][]> {
  if (texts.length === 0) return []

  const config = await getEmbeddingConfig(agentId)
  if (!config.enabled || !config.apiKey || !config.baseUrl) {
    return []
  }

  const url = getApiUrl(config)

  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${config.apiKey}`,
      },
      body: JSON.stringify({
        model: config.model,
        input: texts,
      }),
    })

    if (!response.ok) {
      const errorBody = await response.text().catch(() => '')
      logger.error({ status: response.status, body: errorBody }, 'Embedding API request failed')
      return []
    }

    const data = (await response.json()) as {
      data: Array<{ embedding: number[]; index: number }>
    }

    if (!Array.isArray(data?.data)) return []
    const sorted = data.data.sort((a, b) => a.index - b.index)
    return sorted.map((d) => d.embedding)
  } catch (err) {
    logger.error({ err }, 'Embedding API call failed')
    return []
  }
}
