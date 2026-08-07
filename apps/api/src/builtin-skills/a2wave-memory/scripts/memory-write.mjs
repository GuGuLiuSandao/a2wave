#!/usr/bin/env node
// memory-write.mjs — server-routed explicit memory writer
// 用法：
//   node scripts/memory-write.mjs --remember < insight.json
//   node scripts/memory-write.mjs --replace <topic-id> < topic-body.md
//   node scripts/memory-write.mjs <filename> < content.txt
//   node scripts/memory-write.mjs <filename> --append < new_entry.txt
//   echo "content" | node scripts/memory-write.mjs <filename>

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

const args = process.argv.slice(2)
if (args.length === 0 || args[0] === '--help') {
  console.log('Usage:')
  console.log('  node memory-write.mjs --remember < insight.json')
  console.log('  node memory-write.mjs --replace <topic-id> < topic-body.md')
  console.log('  node memory-write.mjs <filename> [--append] < content')
  console.log('Examples:')
  console.log(
    '  echo \'{"title":"Build workflow","scope":"Repository build and validation","description":"Stable build conventions","keywords":["build","validation"],"section":"Workflows","items":["- Build the shared package before API typechecking."]}\' | node memory-write.mjs --remember',
  )
  console.log('  node memory-write.mjs --replace tpc_a1b2c3d4 < updated-topic.md')
  console.log('  echo "- User prefers X" | node memory-write.mjs MEMORY.md --append')
  console.log("  node memory-write.mjs memory/2026-04-21.md --append << 'EOF'")
  console.log('  ## 10:30 Task\n- Done\nEOF')
  process.exit(0)
}

const rememberMode = args[0] === '--remember'
const replaceMode = args[0] === '--replace'
const topicId = replaceMode ? args[1] : undefined
const filename = rememberMode || replaceMode ? undefined : args[0]
const isAppend = args.includes('--append')

if (replaceMode && !topicId) {
  console.error('Error: --replace requires a topic ID')
  process.exit(1)
}

const content = await new Promise((resolve, reject) => {
  let data = ''
  process.stdin.setEncoding('utf-8')
  process.stdin.on('data', (chunk) => {
    data += chunk
  })
  process.stdin.on('end', () => resolve(data.trim()))
  process.stdin.on('error', reject)
})

if (!content) {
  console.error('Error: no content provided via stdin')
  process.exit(1)
}

let url
let requestBody

if (rememberMode) {
  try {
    const insight = JSON.parse(content)
    url = `${API_URL}/api/memories/${encodeURIComponent(AGENT_ID)}/topics/remember`
    requestBody = { action: 'remember', ...insight }
  } catch (err) {
    console.error('Error: --remember expects valid JSON via stdin:', err.message)
    process.exit(1)
  }
} else if (replaceMode) {
  url = `${API_URL}/api/memories/${encodeURIComponent(AGENT_ID)}/topics/remember`
  requestBody = { action: 'replace', topicId, content }
} else {
  url = `${API_URL}/api/memories/${encodeURIComponent(AGENT_ID)}/files/${filename}`
  requestBody = { content, append: isAppend }
}

try {
  const res = await fetch(url, {
    method: rememberMode || replaceMode ? 'POST' : 'PUT',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${MEMORY_TOKEN}`,
    },
    body: JSON.stringify(requestBody),
  })
  if (!res.ok) {
    const body = await res.text().catch(() => '')
    console.error(`Write API error (${res.status}):`, body)
    process.exit(1)
  }
  const data = await res.json()
  if (rememberMode || replaceMode) {
    const topic = data.data?.topic
    console.log(
      `${data.data?.created ? 'Created' : 'Updated'} topic: ${topic?.topicId ?? topicId} (${topic?.tokenCount ?? 0} tokens)`,
    )
    if (data.data?.warning) console.log(`Warning: ${data.data.warning}`)
  } else {
    console.log(`Written: ${data.data?.filename} (${data.data?.size} bytes)`)
  }
} catch (err) {
  console.error('Failed to write:', err.message)
  process.exit(1)
}
