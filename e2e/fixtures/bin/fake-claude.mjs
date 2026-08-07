#!/usr/bin/env node

const args = process.argv.slice(2)

function argAfter(flag) {
  const i = args.indexOf(flag)
  return i >= 0 ? args[i + 1] : undefined
}

function line(value) {
  process.stdout.write(`${JSON.stringify(value)}\n`)
}

function fail(message) {
  console.error(`[fake-claude] ${message}`)
  console.error(`[fake-claude] argv: ${JSON.stringify(args)}`)
  process.exit(64)
}

function decodeXml(value) {
  return value
    .replaceAll('&quot;', '"')
    .replaceAll('&apos;', "'")
    .replaceAll('&lt;', '<')
    .replaceAll('&gt;', '>')
    .replaceAll('&amp;', '&')
}

function topicizationOutput(prompt) {
  const start = prompt.lastIndexOf('<user_query>')
  const end = prompt.indexOf('</user_query>', start)
  if (start === -1 || end === -1) fail('topicization prompt has no user_query')
  const source = JSON.parse(decodeXml(prompt.slice(start + '<user_query>'.length, end)).trim())
  const grouped = new Map()
  for (const block of source.blocks ?? []) {
    const title = block.sectionHint || 'Legacy Memory'
    const values = grouped.get(title) ?? []
    values.push(block)
    grouped.set(title, values)
  }
  return JSON.stringify({
    summary: [],
    topics: [...grouped.entries()].map(([title, blocks], index) => ({
      title,
      scope: `Stable reuse scope for ${title}.`,
      description: `Migrated legacy memory group ${index + 1}.`,
      keywords: ['legacy', `group-${index + 1}`],
      sections: [
        {
          section: 'Durable Knowledge',
          items: blocks.map((block) => ({
            sourceHash: block.hash,
            content: block.content,
          })),
        },
      ],
    })),
  })
}

function memoryMaintenanceOutput(prompt) {
  const insight = JSON.stringify({
    topics: [
      {
        title: 'E2E memory delivery',
        scope: 'Stable end-to-end memory delivery and validation behavior.',
        description: 'End-to-end memory routing and validation knowledge.',
        keywords: ['e2e-memory', 'routing', 'validation'],
        section: 'Workflows',
        items: ['E2E durable topic detail alpha.', 'E2E durable topic detail beta.'],
      },
    ],
    summary: [],
  })
  return prompt.includes('---INSIGHTS---')
    ? `## E2E memory worklog\n\n- Completed the deterministic memory chain.\n\n---INSIGHTS---\n${insight}`
    : insight
}

const prompt = argAfter('-p')
if (prompt === undefined || prompt.length === 0) fail('expected prompt after -p')
if (argAfter('--output-format') !== 'stream-json') fail('expected --output-format stream-json')
if (!args.includes('--verbose')) fail('expected --verbose with stream-json output')
const resumed = argAfter('--resume')
const sessionId = resumed ?? `sess_e2e_${Date.now()}`

if (prompt.includes('fail-provider') || argAfter('--model') === '__a2wave_e2e_invalid_model__') {
  line({
    type: 'result',
    subtype: 'error',
    is_error: true,
    result: 'E2E provider failure',
    duration_ms: 10,
    session_id: sessionId,
  })
  process.exit(1)
}

if (prompt.trim().startsWith('/compact')) {
  line({ type: 'system', subtype: 'status', status: 'compacting', session_id: sessionId })
  line({
    type: 'system',
    subtype: 'compact_boundary',
    compact_metadata: {
      trigger: 'manual',
      pre_tokens: 2048,
      post_tokens: 512,
      duration_ms: 1560,
    },
    session_id: sessionId,
  })
  line({
    type: 'user',
    isSynthetic: true,
    message: {
      role: 'user',
      content:
        'This session is being continued from a previous conversation that ran out of context. Summary:\n- E2E compact summary from Claude.',
    },
    session_id: sessionId,
  })
  line({ type: 'result', subtype: 'success', result: '', duration_ms: 1560, session_id: sessionId })
  process.exit(0)
}

if (prompt.includes('a2wave-memory-v2-topicization')) {
  const output = topicizationOutput(prompt)
  line({
    type: 'assistant',
    message: { role: 'assistant', content: [{ type: 'text', text: output }] },
    session_id: sessionId,
  })
  line({
    type: 'result',
    subtype: 'success',
    result: output,
    duration_ms: 10,
    session_id: sessionId,
  })
  process.exit(0)
}

if (prompt.includes('---INSIGHTS---') || prompt.includes('稳定复用范围')) {
  const output = memoryMaintenanceOutput(prompt)
  line({
    type: 'assistant',
    message: { role: 'assistant', content: [{ type: 'text', text: output }] },
    session_id: sessionId,
  })
  line({
    type: 'result',
    subtype: 'success',
    result: output,
    duration_ms: 10,
    session_id: sessionId,
  })
  process.exit(0)
}

const mode = resumed ? `resume:${resumed}` : 'fresh'
const output = `${mode}:${prompt}`
line({
  type: 'assistant',
  message: { role: 'assistant', content: [{ type: 'text', text: output }] },
  session_id: sessionId,
})
line({ type: 'result', subtype: 'success', result: output, duration_ms: 10, session_id: sessionId })
