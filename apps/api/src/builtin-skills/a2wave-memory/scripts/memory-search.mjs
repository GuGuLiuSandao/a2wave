#!/usr/bin/env node
// memory-search.mjs — zero-dependency progressive memory reader
//
// 用法：
//   node memory-search.mjs <query> [--mode keyword|vector|hybrid] [--limit n]
//   node memory-search.mjs --recall <query>
//   node memory-search.mjs --topics
//   node memory-search.mjs --topic <topic-id>
//   node memory-search.mjs --read <filePath> --grep <pattern> [-C n]

const API_URL = process.env.A2WAVE_API_URL || 'http://localhost:3502'
const AGENT_ID = process.env.A2WAVE_AGENT_ID
const MEMORY_TOKEN = process.env.A2WAVE_MEMORY_TOKEN

if (!AGENT_ID) {
  console.error('Error: A2WAVE_AGENT_ID environment variable is required')
  process.exit(1)
}

if (!MEMORY_TOKEN) {
  console.error('Error: A2WAVE_MEMORY_TOKEN environment variable is required')
  process.exit(1)
}

const AUTH_HEADERS = { Authorization: `Bearer ${MEMORY_TOKEN}` }

const args = process.argv.slice(2)
if (args.length === 0 || args[0] === '--help') {
  console.log('Usage:')
  console.log('  node memory-search.mjs --recall <query>                 选择并读取一个最相关主题')
  console.log('  node memory-search.mjs --topics                         列出主题元数据')
  console.log('  node memory-search.mjs --topic <topic-id>               精确读取一个主题')
  console.log('  node memory-search.mjs <query> [options]                 搜索记忆与历史')
  console.log('  node memory-search.mjs --read <file> --grep <pattern> [-C n]  读取文件片段')
  console.log('')
  console.log('搜索选项:')
  console.log('  --mode <keyword|vector|hybrid>  搜索模式（默认 hybrid）')
  console.log('  --limit <n>                     返回结果数（默认 5）')
  console.log('')
  console.log('读取选项:')
  console.log('  --read <filePath>               文件路径（如 memory/2026-05-11.md）')
  console.log('  --grep <pattern>                过滤关键词（大小写不敏感）')
  console.log('  -C <n>                          匹配行前后各显示 n 行（默认 5）')
  process.exit(0)
}

function getArg(name, defaultValue) {
  const idx = args.indexOf(name)
  if (idx === -1) return defaultValue
  return args[idx + 1] || defaultValue
}

function hasFlag(name) {
  return args.includes(name)
}

// ── Progressive topic disclosure ────────────────────────────────────────────

if (hasFlag('--recall')) {
  const query = getArg('--recall', '').trim()
  if (!query) {
    console.error('Error: --recall requires a query')
    process.exit(1)
  }
  const params = new URLSearchParams({ q: query })
  const url = `${API_URL}/api/memories/${encodeURIComponent(AGENT_ID)}/topics/recall?${params.toString()}`
  try {
    const res = await fetch(url, { headers: AUTH_HEADERS })
    if (!res.ok) {
      const body = await res.text()
      console.error(`Topic recall API error (${res.status}):`, body)
      process.exit(1)
    }
    const payload = await res.json()
    const topic = payload.data
    if (!topic) {
      console.log(`No active topic matched: ${query}`)
      process.exit(0)
    }
    console.log(`=== ${topic.topicId}: ${topic.title} ===`)
    console.log(topic.content ?? '')
    if (topic.budget) {
      console.log('')
      console.log(
        `[Disclosure budget remaining: ${topic.budget.remainingReads} topic reads, ${topic.budget.remainingTokens} tokens]`,
      )
    }
  } catch (err) {
    console.error('Failed to recall topic:', err.message)
    process.exit(1)
  }
  process.exit(0)
}

if (hasFlag('--topics')) {
  const url = `${API_URL}/api/memories/${encodeURIComponent(AGENT_ID)}/topics`
  try {
    const res = await fetch(url, { headers: AUTH_HEADERS })
    if (!res.ok) {
      const body = await res.text()
      console.error(`Topic API error (${res.status}):`, body)
      process.exit(1)
    }
    const payload = await res.json()
    const data = payload.data ?? {}
    const topics = data.topics ?? []
    console.log(`Memory mode: ${data.mode ?? 'unknown'}`)
    if (topics.length === 0) {
      console.log('No active topics.')
      process.exit(0)
    }
    console.log(`Active topics (${topics.length}):`)
    console.log('')
    for (const topic of topics) {
      const warning = topic.needsReorganization ? ' [needs reorganization]' : ''
      console.log(`- ${topic.topicId}: ${topic.title}${warning}`)
      console.log(`  ${topic.description}`)
      console.log(`  scope: ${topic.scope}`)
      console.log(`  keywords: ${(topic.keywords ?? []).join(', ')}`)
      console.log(`  tokens: ${topic.tokenCount}`)
    }
  } catch (err) {
    console.error('Failed to list topics:', err.message)
    process.exit(1)
  }
  process.exit(0)
}

if (hasFlag('--topic')) {
  const topicId = getArg('--topic', '')
  if (!topicId) {
    console.error('Error: --topic requires a topic ID')
    process.exit(1)
  }
  const url = `${API_URL}/api/memories/${encodeURIComponent(AGENT_ID)}/topics/${encodeURIComponent(topicId)}`
  try {
    const res = await fetch(url, { headers: AUTH_HEADERS })
    if (!res.ok) {
      const body = await res.text()
      console.error(`Topic API error (${res.status}):`, body)
      process.exit(1)
    }
    const payload = await res.json()
    const topic = payload.data ?? {}
    console.log(`=== ${topic.topicId}: ${topic.title} ===`)
    console.log(topic.content ?? '')
    if (topic.budget) {
      console.log('')
      console.log(
        `[Disclosure budget remaining: ${topic.budget.remainingReads} topic reads, ${topic.budget.remainingTokens} tokens]`,
      )
    }
  } catch (err) {
    console.error('Failed to read topic:', err.message)
    process.exit(1)
  }
  process.exit(0)
}

// ── --read 模式 ──────────────────────────────────────────────────────────────

if (hasFlag('--read')) {
  const filePath = getArg('--read', '')
  const pattern = getArg('--grep', '')
  const contextLines = Number.parseInt(getArg('-C', '5'), 10)

  if (!filePath) {
    console.error('Error: --read requires a file path')
    process.exit(1)
  }

  const url = `${API_URL}/api/memories/${AGENT_ID}/files/${filePath}`

  try {
    const res = await fetch(url, { headers: AUTH_HEADERS })
    if (!res.ok) {
      const body = await res.text()
      console.error(`File API error (${res.status}):`, body)
      process.exit(1)
    }
    const data = await res.json()
    const content = data.data?.content ?? ''

    if (!pattern) {
      console.log(`=== ${filePath} ===`)
      console.log(content)
      process.exit(0)
    }

    const lines = content.split('\n')
    let regex
    try {
      regex = new RegExp(pattern, 'i')
    } catch {
      // Invalid regex — fall back to literal substring match
      regex = new RegExp(pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i')
    }
    const matchedRanges = []

    for (let i = 0; i < lines.length; i++) {
      if (regex.test(lines[i])) {
        const start = Math.max(0, i - contextLines)
        const end = Math.min(lines.length - 1, i + contextLines)
        if (matchedRanges.length > 0 && start <= matchedRanges.at(-1).end + 1) {
          matchedRanges.at(-1).end = end
        } else {
          matchedRanges.push({ start, end })
        }
      }
    }

    if (matchedRanges.length === 0) {
      console.log(`No matches for "${pattern}" in ${filePath}`)
      process.exit(0)
    }

    console.log(`=== ${filePath} (grep: "${pattern}", -C ${contextLines}) ===`)
    console.log(`Found ${matchedRanges.length} match section(s):`)
    console.log('')

    for (const { start, end } of matchedRanges) {
      console.log(`-- lines ${start + 1}-${end + 1} --`)
      console.log(lines.slice(start, end + 1).join('\n'))
      console.log('')
    }
  } catch (err) {
    console.error('Failed to read file:', err.message)
    process.exit(1)
  }

  process.exit(0)
}

// ── 搜索模式 ─────────────────────────────────────────────────────────────────

const query = args[0]
const mode = getArg('--mode', 'hybrid')
const limit = getArg('--limit', '5')

const params = new URLSearchParams({ q: query, mode, limit })
const url = `${API_URL}/api/memories/${AGENT_ID}/search?${params.toString()}`

try {
  const res = await fetch(url, { headers: AUTH_HEADERS })
  if (!res.ok) {
    const body = await res.text()
    console.error(`Search API error (${res.status}):`, body)
    process.exit(1)
  }
  const data = await res.json()
  const results = data.data?.results || []

  if (results.length === 0) {
    console.log(`No results found for: ${query}`)
    process.exit(0)
  }

  console.log(`Found ${results.length} results:`)
  console.log('')
  for (const r of results) {
    const topicLabel = r.topicId ? `, topic: ${r.topicId}` : ''
    const kindLabel = r.fileKind ? `, layer: ${r.fileKind}` : ''
    console.log(`--- ${r.filePath} (score: ${r.score.toFixed(3)}${kindLabel}${topicLabel}) ---`)
    console.log(r.snippet)
    console.log('')
  }

  if (data.data?.vectorIndexReady === false) {
    console.log('[Note: Vector index not yet ready, results are keyword-only]')
  }
} catch (err) {
  console.error('Failed to search:', err.message)
  process.exit(1)
}
