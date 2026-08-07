import { createHash } from 'node:crypto'
import { resolve } from 'node:path'
/**
 * Memory 索引服务
 * 独立 SQLite 数据库 + FTS5 关键字索引 + 向量索引
 * 参考 task-queue-db.ts 的独立 DB 模式
 */
import Database from 'better-sqlite3'
import { env } from '../env.js'
import { logger } from './logger.js'
import { getAllMemoryContent, listMemoryFiles } from './memory-storage.js'
import { isMemoryTopicPath, parseMemoryTopicFile } from './memory-topics.js'

// --- Types ---

export interface SearchResult {
  filePath: string
  snippet: string
  score: number
  mtime: number
  fileKind?: MemoryFileKind
  topicId?: string | null
  topicStatus?: 'active' | 'archived' | null
}

export type MemoryFileKind = 'main' | 'topic' | 'archived_topic' | 'weekly' | 'daily' | 'other'

export interface SearchResponse {
  results: SearchResult[]
  vectorIndexReady: boolean
}

// --- Singleton DB ---

let _db: Database.Database | null = null

const CHUNK_SIZE = 500
const CHUNK_OVERLAP = 100

export function deriveMemoryFileMetadata(
  filePath: string,
  content: string,
): {
  fileKind: MemoryFileKind
  topicId: string | null
  topicStatus: 'active' | 'archived' | null
  indexableContent: string
} {
  if (filePath === 'MEMORY.md') {
    return { fileKind: 'main', topicId: null, topicStatus: null, indexableContent: content }
  }
  if (isMemoryTopicPath(filePath)) {
    try {
      const topic = parseMemoryTopicFile(filePath, content)
      return {
        fileKind: topic.status === 'active' ? 'topic' : 'archived_topic',
        topicId: topic.topicId,
        topicStatus: topic.status,
        indexableContent: topic.body,
      }
    } catch {
      return {
        fileKind: filePath.includes('/archive/') ? 'archived_topic' : 'topic',
        topicId: null,
        topicStatus: null,
        indexableContent: '',
      }
    }
  }
  if (/^memory\/weekly\/\d{4}-W\d{2}\.md$/.test(filePath)) {
    return { fileKind: 'weekly', topicId: null, topicStatus: null, indexableContent: content }
  }
  if (/^memory\/\d{4}-\d{2}-\d{2}\.md$/.test(filePath)) {
    return { fileKind: 'daily', topicId: null, topicStatus: null, indexableContent: content }
  }
  return { fileKind: 'other', topicId: null, topicStatus: null, indexableContent: content }
}

/** 获取/初始化独立 SQLite 实例（懒加载单例） */
export function getMemoryIndexDb(): Database.Database {
  if (_db) return _db

  const dbPath = resolve(process.cwd(), env.A2WAVE_MEMORY_STORAGE, '..', 'memory-index.db')
  _db = new Database(dbPath)
  _db.pragma('journal_mode = WAL')

  // FTS5 关键字索引
  // chunk_text: UNINDEXED（原文，用于 snippet 显示）
  // chunk_text_search: 索引列（CJK 字符间加空格，使 unicode61 能正确分词）
  _db.exec(`
    CREATE VIRTUAL TABLE IF NOT EXISTS memory_chunks_fts USING fts5(
      agent_id UNINDEXED,
      file_path UNINDEXED,
      file_kind UNINDEXED,
      topic_id UNINDEXED,
      topic_status UNINDEXED,
      chunk_text UNINDEXED,
      chunk_text_search,
      tokenize='unicode61'
    )
  `)

  // Schema migration: drop old FTS5 table if it lacks chunk_text_search column
  const ftsColumns = (_db.pragma('table_info(memory_chunks_fts)') as Array<{ name: string }>).map(
    (c) => c.name,
  )
  if (
    ftsColumns.length > 0 &&
    (!ftsColumns.includes('chunk_text_search') || !ftsColumns.includes('file_kind'))
  ) {
    _db.exec('DROP TABLE IF EXISTS memory_chunks_fts')
    _db.exec(`
      CREATE VIRTUAL TABLE memory_chunks_fts USING fts5(
        agent_id UNINDEXED,
        file_path UNINDEXED,
        file_kind UNINDEXED,
        topic_id UNINDEXED,
        topic_status UNINDEXED,
        chunk_text UNINDEXED,
        chunk_text_search,
        tokenize='unicode61'
      )
    `)
    logger.info('FTS5 schema migrated to include chunk_text_search column')
  }

  // 向量索引
  _db.exec(`
    CREATE TABLE IF NOT EXISTS memory_chunks_vec (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      agent_id TEXT NOT NULL,
      file_path TEXT NOT NULL,
      file_kind TEXT NOT NULL DEFAULT 'other',
      topic_id TEXT,
      topic_status TEXT,
      chunk_text TEXT NOT NULL,
      content_hash TEXT NOT NULL,
      embedding BLOB,
      created_at INTEGER NOT NULL
    )
  `)
  const vecColumns = (_db.pragma('table_info(memory_chunks_vec)') as Array<{ name: string }>).map(
    (column) => column.name,
  )
  if (!vecColumns.includes('file_kind')) {
    _db.exec("ALTER TABLE memory_chunks_vec ADD COLUMN file_kind TEXT NOT NULL DEFAULT 'other'")
  }
  if (!vecColumns.includes('topic_id')) {
    _db.exec('ALTER TABLE memory_chunks_vec ADD COLUMN topic_id TEXT')
  }
  if (!vecColumns.includes('topic_status')) {
    _db.exec('ALTER TABLE memory_chunks_vec ADD COLUMN topic_status TEXT')
  }
  _db.exec('CREATE INDEX IF NOT EXISTS idx_memory_vec_agent ON memory_chunks_vec(agent_id)')
  _db.exec('CREATE INDEX IF NOT EXISTS idx_memory_vec_hash ON memory_chunks_vec(content_hash)')

  // 索引元数据
  _db.exec(`
    CREATE TABLE IF NOT EXISTS memory_index_meta (
      agent_id TEXT PRIMARY KEY,
      last_fts_indexed_at INTEGER NOT NULL,
      last_vec_indexed_at INTEGER
    )
  `)

  return _db
}

/** 关闭 DB（测试用） */
export function closeMemoryIndexDb(): void {
  if (_db) {
    _db.close()
    _db = null
  }
}

// --- CJK tokenization helper ---

/**
 * 在 CJK 字符之间插入空格，使 unicode61 tokenizer 能逐字分词。
 * 保留原始非 CJK 内容（英文/数字/标点）不变。
 * 示例："修复飞书webhook" → "修 复 飞 书 webhook"
 */
export function expandCjkForFts(text: string): string {
  // CJK Unified Ideographs + Extensions + Katakana/Hiragana
  return text
    .replace(/[\u3000-\u9fff\uac00-\ud7af\uf900-\ufaff]/g, ' $& ')
    .replace(/\s+/g, ' ')
    .trim()
}

// --- Chunking ---

/** 按段落分块，每块约 CHUNK_SIZE 字符，CHUNK_OVERLAP 字符重叠 */
export function chunkText(text: string): string[] {
  if (!text.trim()) return []

  const chunks: string[] = []
  let start = 0
  while (start < text.length) {
    const end = Math.min(start + CHUNK_SIZE, text.length)
    chunks.push(text.slice(start, end))
    if (end >= text.length) break
    start = end - CHUNK_OVERLAP
  }
  return chunks
}

/** 计算 chunk 内容 hash */
export function contentHash(text: string): string {
  return createHash('sha256').update(text).digest('hex')
}

// --- Reindex ---

/** Per-agent Promise queue for async vector reindex */
const vecReindexQueues = new Map<string, Promise<void>>()

/** 清除所有 reindex 队列（测试用） */
export function clearReindexQueues(): void {
  vecReindexQueues.clear()
}

/** 重建某 Agent 的 FTS5 索引（同步） */
export function reindexAgentFts(agentId: string): void {
  const db = getMemoryIndexDb()
  const files = getAllMemoryContent(agentId)

  // 清除旧索引
  db.prepare('DELETE FROM memory_chunks_fts WHERE agent_id = ?').run(agentId)

  // 插入新索引
  const insert = db.prepare(
    'INSERT INTO memory_chunks_fts (agent_id, file_path, file_kind, topic_id, topic_status, chunk_text, chunk_text_search) VALUES (?, ?, ?, ?, ?, ?, ?)',
  )
  const insertMany = db.transaction(() => {
    for (const file of files) {
      const metadata = deriveMemoryFileMetadata(file.filename, file.content)
      const chunks = chunkText(metadata.indexableContent)
      for (const chunk of chunks) {
        insert.run(
          agentId,
          file.filename,
          metadata.fileKind,
          metadata.topicId,
          metadata.topicStatus,
          chunk,
          expandCjkForFts(chunk),
        )
      }
    }
  })
  insertMany()

  // 更新元数据
  db.prepare(`
    INSERT INTO memory_index_meta (agent_id, last_fts_indexed_at, last_vec_indexed_at)
    VALUES (?, ?, NULL)
    ON CONFLICT(agent_id) DO UPDATE SET last_fts_indexed_at = excluded.last_fts_indexed_at
  `).run(agentId, Date.now())

  logger.info({ agentId }, 'FTS5 reindex completed')
}

/** 检查是否需要 FTS reindex（文件 mtime > last_fts_indexed_at） */
export function needsFtsReindex(agentId: string): boolean {
  const db = getMemoryIndexDb()
  const meta = db
    .prepare('SELECT last_fts_indexed_at FROM memory_index_meta WHERE agent_id = ?')
    .get(agentId) as { last_fts_indexed_at: number } | undefined

  if (!meta) return true

  const files = listMemoryFiles(agentId)
  return files.some((f) => f.mtime > meta.last_fts_indexed_at)
}

/** 重建某 Agent 的向量索引（异步，串行队列防并发丢弃） */
export function reindexAgentVectors(
  agentId: string,
  getEmbeddings: (texts: string[]) => Promise<number[][]>,
): Promise<void> {
  const prev = vecReindexQueues.get(agentId) ?? Promise.resolve()
  const next = prev
    .then(() => doReindexVectors(agentId, getEmbeddings))
    .catch((err) => {
      logger.error({ agentId, err }, 'Vector reindex failed')
    })
    .finally(() => {
      if (vecReindexQueues.get(agentId) === next) {
        vecReindexQueues.delete(agentId)
      }
    })
  vecReindexQueues.set(agentId, next)
  return next
}

async function doReindexVectors(
  agentId: string,
  getEmbeddings: (texts: string[]) => Promise<number[][]>,
): Promise<void> {
  const db = getMemoryIndexDb()
  const files = getAllMemoryContent(agentId)

  // 收集所有 chunks 和 hash
  const allChunks: Array<{
    filePath: string
    fileKind: MemoryFileKind
    topicId: string | null
    topicStatus: 'active' | 'archived' | null
    text: string
    hash: string
  }> = []
  for (const file of files) {
    const metadata = deriveMemoryFileMetadata(file.filename, file.content)
    const chunks = chunkText(metadata.indexableContent)
    for (const chunk of chunks) {
      allChunks.push({
        filePath: file.filename,
        fileKind: metadata.fileKind,
        topicId: metadata.topicId,
        topicStatus: metadata.topicStatus,
        text: chunk,
        hash: contentHash(chunk),
      })
    }
  }

  // Preserve both reusable embeddings and unchanged rows. Matching includes path and topic
  // metadata so moves between memory layers replace only the affected rows.
  const existingRows = db
    .prepare(
      'SELECT id, file_path, file_kind, topic_id, topic_status, chunk_text, content_hash, embedding FROM memory_chunks_vec WHERE agent_id = ?',
    )
    .all(agentId) as Array<{
    id: number
    file_path: string
    file_kind: MemoryFileKind
    topic_id: string | null
    topic_status: 'active' | 'archived' | null
    chunk_text: string
    content_hash: string
    embedding: Buffer | null
  }>
  const rowKey = (row: {
    filePath: string
    fileKind: MemoryFileKind
    topicId: string | null
    topicStatus: 'active' | 'archived' | null
    text: string
    hash: string
  }) =>
    JSON.stringify([row.filePath, row.fileKind, row.topicId, row.topicStatus, row.text, row.hash])
  const reusableRows = new Map<string, Array<(typeof existingRows)[number]>>()
  const embeddingByHash = new Map<string, Buffer>()
  for (const row of existingRows) {
    if (!row.embedding) continue
    embeddingByHash.set(row.content_hash, row.embedding)
    const key = rowKey({
      filePath: row.file_path,
      fileKind: row.file_kind,
      topicId: row.topic_id,
      topicStatus: row.topic_status,
      text: row.chunk_text,
      hash: row.content_hash,
    })
    const matches = reusableRows.get(key) ?? []
    matches.push(row)
    reusableRows.set(key, matches)
  }

  const retainedRowIds = new Set<number>()
  const chunksToInsert: typeof allChunks = []
  for (const chunk of allChunks) {
    const matches = reusableRows.get(rowKey(chunk))
    const existing = matches?.pop()
    if (existing) retainedRowIds.add(existing.id)
    else chunksToInsert.push(chunk)
  }

  const missingByHash = new Map<string, (typeof allChunks)[number]>()
  for (const chunk of chunksToInsert) {
    if (!embeddingByHash.has(chunk.hash) && !missingByHash.has(chunk.hash)) {
      missingByHash.set(chunk.hash, chunk)
    }
  }
  const newChunks = [...missingByHash.values()]

  if (newChunks.length > 0) {
    const texts = newChunks.map((chunk) => chunk.text)
    const embeddings = await getEmbeddings(texts)
    for (let index = 0; index < newChunks.length; index++) {
      const embedding = embeddings[index]
      if (embedding) {
        embeddingByHash.set(newChunks[index].hash, Buffer.from(new Float32Array(embedding).buffer))
      }
    }
  }

  const staleRowIds = existingRows.filter((row) => !retainedRowIds.has(row.id)).map((row) => row.id)
  const updateRows = db.transaction(() => {
    const deleteRow = db.prepare('DELETE FROM memory_chunks_vec WHERE agent_id = ? AND id = ?')
    for (const rowId of staleRowIds) deleteRow.run(agentId, rowId)

    const insert = db.prepare(
      'INSERT INTO memory_chunks_vec (agent_id, file_path, file_kind, topic_id, topic_status, chunk_text, content_hash, embedding, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
    )
    for (const chunk of chunksToInsert) {
      insert.run(
        agentId,
        chunk.filePath,
        chunk.fileKind,
        chunk.topicId,
        chunk.topicStatus,
        chunk.text,
        chunk.hash,
        embeddingByHash.get(chunk.hash) ?? null,
        Date.now(),
      )
    }
  })
  updateRows()

  // 更新元数据（INSERT 时 last_fts_indexed_at 设为 0，避免跳过 FTS reindex）
  db.prepare(`
    INSERT INTO memory_index_meta (agent_id, last_fts_indexed_at, last_vec_indexed_at)
    VALUES (?, 0, ?)
    ON CONFLICT(agent_id) DO UPDATE SET last_vec_indexed_at = excluded.last_vec_indexed_at
  `).run(agentId, Date.now())

  logger.info(
    {
      agentId,
      newEmbeddings: newChunks.length,
      updatedChunks: chunksToInsert.length,
      removedChunks: staleRowIds.length,
    },
    'Vector reindex completed',
  )
}

/** FTS5 关键字搜索 */
export function searchByKeyword(agentId: string, query: string, limit = 5): SearchResult[] {
  // 搜索前自动 reindex
  if (needsFtsReindex(agentId)) {
    reindexAgentFts(agentId)
  }

  const db = getMemoryIndexDb()

  // 转义 FTS5 特殊字符，并对 CJK 字符展开（与 reindex 保持一致）
  const safeQuery = expandCjkForFts(query)
    .replace(/['"*(){}[\]^~!@#$%&\\|<>?/;:.,+=\-]/g, ' ')
    .trim()
  if (!safeQuery) return []

  const rows = db
    .prepare(`
    SELECT file_path, file_kind, topic_id, topic_status, chunk_text, rank
    FROM memory_chunks_fts
    WHERE agent_id = ? AND chunk_text_search MATCH ?
    ORDER BY rank
    LIMIT ?
  `)
    .all(agentId, safeQuery, limit * 3) as Array<{
    file_path: string
    file_kind: MemoryFileKind
    topic_id: string | null
    topic_status: 'active' | 'archived' | null
    chunk_text: string
    rank: number
  }>

  return rows.map((r) => ({
    filePath: r.file_path,
    snippet: r.chunk_text.slice(0, 200),
    score: -r.rank, // rank is negative in FTS5 (more negative = better)
    mtime: 0,
    fileKind: r.file_kind,
    topicId: r.topic_id,
    topicStatus: r.topic_status,
  }))
}

/** 余弦相似度 */
function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length !== b.length || a.length === 0) return 0
  let dot = 0
  let normA = 0
  let normB = 0
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i]
    normA += a[i] * a[i]
    normB += b[i] * b[i]
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB)
  return denom === 0 ? 0 : dot / denom
}

/** 向量搜索（余弦相似度低于阈值的结果会被过滤） */
export function searchByVector(
  agentId: string,
  queryEmbedding: number[],
  limit = 5,
  minScore = 0.3,
): SearchResult[] {
  const db = getMemoryIndexDb()

  const rows = db
    .prepare(
      'SELECT file_path, file_kind, topic_id, topic_status, chunk_text, embedding FROM memory_chunks_vec WHERE agent_id = ? AND embedding IS NOT NULL',
    )
    .all(agentId) as Array<{
    file_path: string
    file_kind: MemoryFileKind
    topic_id: string | null
    topic_status: 'active' | 'archived' | null
    chunk_text: string
    embedding: Buffer
  }>

  if (rows.length === 0) return []

  const scored = rows.map((r) => {
    const embedding = Array.from(
      new Float32Array(r.embedding.buffer, r.embedding.byteOffset, r.embedding.byteLength / 4),
    )
    return {
      filePath: r.file_path,
      snippet: r.chunk_text.slice(0, 200),
      score: cosineSimilarity(queryEmbedding, embedding),
      mtime: 0,
      fileKind: r.file_kind,
      topicId: r.topic_id,
      topicStatus: r.topic_status,
    }
  })

  return scored
    .filter((r) => r.score >= minScore)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
}

/** 混合搜索（Reciprocal Rank Fusion） */
export function hybridSearch(
  agentId: string,
  query: string,
  limit = 5,
  options?: { queryEmbedding?: number[]; ftsQuery?: string; k?: number },
): SearchResponse {
  const k = options?.k ?? 20 // RRF 常数；k=20 适合小语料（≤20文件），分数范围更大
  const effectiveFtsQuery = options?.ftsQuery ?? query

  const keywordResults = searchByKeyword(agentId, effectiveFtsQuery, limit * 3)
  let vectorResults: SearchResult[] = []
  let vectorIndexReady = false

  if (options?.queryEmbedding) {
    vectorResults = searchByVector(agentId, options.queryEmbedding, limit * 3)
    vectorIndexReady = vectorResults.length > 0
  }

  if (vectorResults.length === 0) {
    return { results: keywordResults.slice(0, limit), vectorIndexReady }
  }
  if (keywordResults.length === 0) {
    return { results: vectorResults.slice(0, limit), vectorIndexReady }
  }

  // RRF: score = sum( 1 / (k + rank_i) ) for each result list
  // 用 filePath + snippet 全文 hash 作为去重 key，避免截断碰撞
  const scoreMap = new Map<string, SearchResult & { rrfScore: number }>()
  const makeKey = (r: SearchResult) => `${r.filePath}:${contentHash(r.snippet)}`

  for (let rank = 0; rank < keywordResults.length; rank++) {
    const r = keywordResults[rank]
    const key = makeKey(r)
    const existing = scoreMap.get(key)
    const rrfContrib = 1 / (k + rank + 1)
    if (existing) {
      existing.rrfScore += rrfContrib
    } else {
      scoreMap.set(key, { ...r, rrfScore: rrfContrib })
    }
  }

  for (let rank = 0; rank < vectorResults.length; rank++) {
    const r = vectorResults[rank]
    const key = makeKey(r)
    const existing = scoreMap.get(key)
    const rrfContrib = 1 / (k + rank + 1)
    if (existing) {
      existing.rrfScore += rrfContrib
    } else {
      scoreMap.set(key, { ...r, rrfScore: rrfContrib })
    }
  }

  const merged = Array.from(scoreMap.values())
    .sort((a, b) => b.rrfScore - a.rrfScore)
    .slice(0, limit)
    .map(({ rrfScore, ...rest }) => ({ ...rest, score: rrfScore }))

  return { results: merged, vectorIndexReady }
}

const FILE_KIND_RANK: Record<MemoryFileKind, number> = {
  topic: 0,
  archived_topic: 1,
  weekly: 2,
  daily: 3,
  main: 4,
  other: 5,
}

export function rankMemoryResults(results: SearchResult[]): SearchResult[] {
  const seen = new Set<string>()
  return [...results]
    .sort((a, b) => {
      const kindA = FILE_KIND_RANK[a.fileKind ?? 'other']
      const kindB = FILE_KIND_RANK[b.fileKind ?? 'other']
      return kindA - kindB || b.score - a.score
    })
    .filter((result) => {
      const normalized = result.snippet.toLowerCase().replace(/\s+/g, ' ').trim()
      if (!normalized) return false
      const key = contentHash(normalized)
      if (seen.has(key)) return false
      seen.add(key)
      return true
    })
}

// --- Post-processing ---

/**
 * 时间衰减：对搜索结果应用指数衰减权重。
 *
 * `halfLifeDays = 0` 表示不衰减（见 memory-provider.ts 的 resolveNumericConfig），
 * 搜索路由会原样透传该值。负值与 NaN 同样按不衰减处理：`Math.LN2 / 0` 是 Infinity，
 * 会把所有日期记忆压成 0；负值则反转指数，让越旧的记忆排得越靠前。两者都会静默
 * 破坏排序而非报错，所以在此统一兜底。
 */
export function applyTemporalDecay(results: SearchResult[], halfLifeDays = 14): SearchResult[] {
  const sortByScoreDesc = (a: SearchResult, b: SearchResult) => b.score - a.score
  if (!(halfLifeDays > 0)) return [...results].sort(sortByScoreDesc)

  const lambda = Math.LN2 / halfLifeDays
  const now = Date.now()

  return results
    .map((r) => {
      // 常青文件豁免：仅对日期命名的文件（如 2026-03-31.md）做衰减
      const dateMatch = r.filePath.match(/(\d{4}-\d{2}-\d{2})\.md$/)
      if (!dateMatch) return r
      const fileDate = new Date(dateMatch[1])
      const ageInDays = (now - fileDate.getTime()) / (1000 * 60 * 60 * 24)
      const decayFactor = Math.exp(-lambda * ageInDays)
      return { ...r, score: r.score * decayFactor }
    })
    .sort(sortByScoreDesc)
}

/** 文本相似度（字符 bigram Jaccard，兼容中文） */
function bigramSimilarity(a: string, b: string): number {
  const bigrams = (s: string): Set<string> => {
    const lower = s.toLowerCase()
    const set = new Set<string>()
    for (let i = 0; i < lower.length - 1; i++) {
      set.add(lower.slice(i, i + 2))
    }
    return set
  }
  const setA = bigrams(a)
  const setB = bigrams(b)
  if (setA.size === 0 && setB.size === 0) return 0
  let intersection = 0
  for (const bg of setA) {
    if (setB.has(bg)) intersection++
  }
  return intersection / (setA.size + setB.size - intersection)
}

/** MMR 去重（Maximal Marginal Relevance） */
export function applyMMR(results: SearchResult[], lambda = 0.7): SearchResult[] {
  if (results.length <= 1) return results

  const selected: SearchResult[] = [results[0]]
  const remaining = results.slice(1)

  while (selected.length < results.length && remaining.length > 0) {
    let bestIdx = 0
    let bestScore = Number.NEGATIVE_INFINITY

    for (let i = 0; i < remaining.length; i++) {
      const candidate = remaining[i]
      const relevance = candidate.score
      const maxSim = Math.max(
        ...selected.map((s) => bigramSimilarity(candidate.snippet, s.snippet)),
      )
      const mmrScore = lambda * relevance - (1 - lambda) * maxSim
      if (mmrScore > bestScore) {
        bestScore = mmrScore
        bestIdx = i
      }
    }

    selected.push(remaining[bestIdx])
    remaining.splice(bestIdx, 1)
  }

  return selected
}

/** 清理指定 Agent 的所有索引 */
export function clearAgentIndex(agentId: string): void {
  const db = getMemoryIndexDb()
  db.prepare('DELETE FROM memory_chunks_fts WHERE agent_id = ?').run(agentId)
  db.prepare('DELETE FROM memory_chunks_vec WHERE agent_id = ?').run(agentId)
  db.prepare('DELETE FROM memory_index_meta WHERE agent_id = ?').run(agentId)
}
