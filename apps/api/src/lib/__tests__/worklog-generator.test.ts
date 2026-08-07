import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// --- Mocks ---

vi.mock('../../env.js', () => ({
  env: { A2WAVE_MEMORY_STORAGE: '' },
}))

vi.mock('../logger.js', () => ({
  logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() },
}))

const mockDbStore: { _allResult: unknown[]; _getResult: unknown } = {
  _allResult: [],
  _getResult: undefined,
}
const mockDbSelect = vi.fn()
vi.mock('../../db/client.js', () => ({
  db: {
    select: () => ({
      from: (table: unknown) => {
        mockDbSelect(table)
        return {
          where: (cond: unknown) =>
            asyncQuery({
              orderBy: () =>
                asyncQuery({
                  all: () => mockDbStore._allResult,
                }),
              get: () => mockDbStore._getResult,
            }),
        }
      },
    }),
    insert: () => ({ values: () => asyncQuery({ run: vi.fn() }) }),
    update: () => ({ set: () => asyncQuery({ where: () => asyncQuery({ run: vi.fn() }) }) }),
  },
}))

vi.mock('../../db/schema.js', () => ({
  agents: 'agents',
  chatMessages: 'chatMessages',
  runSteps: 'runSteps',
}))

const mockBuildAgentConfig = vi.fn(
  (agent: { id: string; type?: string; config?: Record<string, unknown> }) => ({
    ...agent.config,
    agentId: agent.id,
    engineType: 'cursor',
    model: 'provider-model',
    providerApiKey: 'provider-key',
  }),
)
vi.mock('../agent-helpers.js', () => ({
  buildAgentConfig: (agent: { id: string; type?: string; config?: Record<string, unknown> }) =>
    mockBuildAgentConfig(agent),
}))

const mockExecuteWithRetry = vi.fn()
vi.mock('../execute-with-retry.js', () => ({
  executeWithRetry: (...args: unknown[]) => mockExecuteWithRetry(...args),
}))

const mockConsolidateMemory = vi.fn().mockResolvedValue(null)
vi.mock('../memory-consolidation.js', () => ({
  consolidateMemory: (...args: unknown[]) => mockConsolidateMemory(...args),
}))

const mockReindexAgentFts = vi.fn()
const mockReindexAgentVectors = vi.fn().mockResolvedValue(undefined)
vi.mock('../memory-index.js', () => ({
  reindexAgentFts: (...args: unknown[]) => mockReindexAgentFts(...args),
  reindexAgentVectors: (...args: unknown[]) => mockReindexAgentVectors(...args),
}))

const mockIsEmbeddingAvailable = vi.fn().mockReturnValue(false)
const mockGetEmbeddings = vi.fn().mockResolvedValue([])
vi.mock('../embedding-service.js', () => ({
  isEmbeddingAvailable: () => mockIsEmbeddingAvailable(),
  getEmbeddings: (...args: unknown[]) => mockGetEmbeddings(...args),
}))

import { env } from '../../env.js'
import { logger } from '../logger.js'
import {
  applyInsightToTopics,
  estimateMemoryTokens,
  listMemoryTopics,
  readMemoryTopic,
  replaceTopicBody,
} from '../memory-topics.js'
import {
  DEFAULT_INSIGHT_PROMPT,
  DEFAULT_WORKLOG_PROMPT,
  clearWriteQueues,
  generateWorkLog,
} from '../worklog-generator.js'

import { asyncQuery } from '../../test/async-query.js'

let testRoot: string

function setupTestDir() {
  testRoot = join(tmpdir(), `worklog-test-${Date.now()}-${Math.random().toString(36).slice(2)}`)
  mkdirSync(testRoot, { recursive: true })
  ;(env as { A2WAVE_MEMORY_STORAGE: string }).A2WAVE_MEMORY_STORAGE = testRoot
}

function setAgent(opts: {
  memoryEnabled: boolean
  apiKey?: string
  baseUrl?: string
  model?: string
  memoryModel?: string
  memoryWorklogEnabled?: boolean
  memoryAutoInsight?: boolean
  memoryWorklogPrompt?: string
  memoryInsightPrompt?: string
  memoryCompressionThresholdChars?: number
  memoryCompressionTargetChars?: number
}) {
  mockDbStore._getResult = {
    id: 'agt_test',
    type: 'cursor',
    name: 'Test Agent',
    memoryProviderApiKey: opts.apiKey ?? '',
    config: {
      memoryEnabled: opts.memoryEnabled,
      memoryProviderBaseUrl: opts.baseUrl ?? '',
      memoryProviderModel: opts.model ?? '',
      ...(opts.memoryModel !== undefined && { memoryModel: opts.memoryModel }),
      ...(opts.memoryWorklogEnabled !== undefined && {
        memoryWorklogEnabled: opts.memoryWorklogEnabled,
      }),
      ...(opts.memoryAutoInsight !== undefined && { memoryAutoInsight: opts.memoryAutoInsight }),
      ...(opts.memoryWorklogPrompt !== undefined && {
        memoryWorklogPrompt: opts.memoryWorklogPrompt,
      }),
      ...(opts.memoryInsightPrompt !== undefined && {
        memoryInsightPrompt: opts.memoryInsightPrompt,
      }),
      ...(opts.memoryCompressionThresholdChars !== undefined && {
        memoryCompressionThresholdChars: opts.memoryCompressionThresholdChars,
      }),
      ...(opts.memoryCompressionTargetChars !== undefined && {
        memoryCompressionTargetChars: opts.memoryCompressionTargetChars,
      }),
    },
  }
}

function setChatMessages(messages: Array<{ role: string; content: string }>) {
  mockDbStore._allResult = messages.map((m, i) => ({
    id: `msg_${i}`,
    runId: 'run_test',
    role: m.role,
    content: m.content,
    createdAt: new Date(),
  }))
}

function mockProviderSuccess(summary: string) {
  mockExecuteWithRetry.mockResolvedValue({
    result: { success: true, output: summary, durationMs: 1 },
    retries: [],
    logs: [],
  })
}

function mockProviderFailure(error: unknown = 'provider failed') {
  mockExecuteWithRetry.mockResolvedValue({
    result: { success: false, output: '', error, durationMs: 1 },
    retries: [],
    logs: [],
  })
}

function getMemoryProviderPayload() {
  return mockExecuteWithRetry.mock.calls[0]?.[1] as {
    prompt: string
    model?: string
    workDir: string
    agentConfig: { systemPrompt?: string; [key: string]: unknown }
  }
}

describe('worklog-generator', () => {
  beforeEach(() => {
    setupTestDir()
    clearWriteQueues()
    vi.clearAllMocks()
    mockProviderSuccess('## 10:00 Test')
    mockDbStore._getResult = undefined
    mockDbStore._allResult = []
  })

  afterEach(() => {
    if (existsSync(testRoot)) {
      rmSync(testRoot, { recursive: true })
    }
  })

  it('skips when agent memoryEnabled is false', async () => {
    setAgent({ memoryEnabled: false, apiKey: 'test-key' })
    setChatMessages([{ role: 'user', content: 'hello' }])
    mockProviderSuccess('## 10:00 Test')

    await generateWorkLog('agt_test', 'run_test', true)

    expect(mockExecuteWithRetry).not.toHaveBeenCalled()
  })

  it('uses the run provider path without requiring a memory-specific apiKey', async () => {
    setAgent({ memoryEnabled: true, apiKey: '' })
    setChatMessages([{ role: 'user', content: 'hello' }])
    mockProviderSuccess('## 10:00 Test')

    await generateWorkLog('agt_test', 'run_test', true)

    expect(mockExecuteWithRetry).toHaveBeenCalledTimes(1)
    const payload = getMemoryProviderPayload()
    expect(payload.model).toBe('provider-model')
    expect(payload.agentConfig.providerApiKey).toBe('provider-key')
    expect(payload.agentConfig.memoryEnabled).toBe(false)
    expect(payload.agentConfig.readOnly).toBe(true)
  })

  it('runs memory maintenance in a disposable workspace outside the configured Agent workspace', async () => {
    setAgent({ memoryEnabled: true, apiKey: '' })
    setChatMessages([{ role: 'user', content: 'I prefer TypeScript for new services.' }])
    mockProviderSuccess('## 10:00 Test')

    await generateWorkLog('agt_test', 'run_test', true)

    const payload = getMemoryProviderPayload()
    expect(payload.workDir).toContain('a2wave-memory-runtime')
    expect(payload.workDir).toContain('agt_test-')
    expect(existsSync(payload.workDir)).toBe(false)
  })

  it('skips when no chat messages exist', async () => {
    setAgent({ memoryEnabled: true, apiKey: 'test-key' })
    setChatMessages([])
    mockProviderSuccess('## 10:00 Test')

    await generateWorkLog('agt_test', 'run_test', true)

    expect(mockExecuteWithRetry).not.toHaveBeenCalled()
  })

  it('skips LLM call when both worklog and insight are disabled', async () => {
    setAgent({
      memoryEnabled: true,
      apiKey: 'test-key',
      memoryWorklogEnabled: false,
      memoryAutoInsight: false,
    })
    setChatMessages([{ role: 'user', content: 'hello' }])
    mockProviderSuccess('## 10:00 Test')

    await generateWorkLog('agt_test', 'run_test', true)

    expect(mockExecuteWithRetry).not.toHaveBeenCalled()
  })

  it('skips all background memory persistence for an explicit interactive mutation', async () => {
    setAgent({ memoryEnabled: true, apiKey: 'test-key' })
    setChatMessages([
      {
        role: 'user',
        content: '请把长期规则保存到名为“架构决策”的主题：所有架构变更必须先运行兼容性测试。',
      },
      { role: 'agent', content: '记忆写入失败，没有保存。' },
    ])

    const agentDir = join(testRoot, 'agt_test')
    mkdirSync(join(agentDir, 'memory'), { recursive: true })

    await generateWorkLog('agt_test', 'run_test', false)

    expect(mockExecuteWithRetry).not.toHaveBeenCalled()
    expect(existsSync(join(agentDir, 'MEMORY.md'))).toBe(false)
    expect(
      existsSync(join(agentDir, 'memory', `${new Date().toISOString().slice(0, 10)}.md`)),
    ).toBe(false)
  })

  it('skips all background memory persistence when the user opts out for this run', async () => {
    setAgent({ memoryEnabled: true, apiKey: 'test-key' })
    setChatMessages([
      { role: 'user', content: '不要修改任何记忆，只回答问题。' },
      { role: 'agent', content: '已回答问题。' },
    ])

    const agentDir = join(testRoot, 'agt_test')
    mkdirSync(join(agentDir, 'memory'), { recursive: true })

    await generateWorkLog('agt_test', 'run_test', true)

    expect(mockExecuteWithRetry).not.toHaveBeenCalled()
    expect(existsSync(join(agentDir, 'MEMORY.md'))).toBe(false)
    expect(
      existsSync(join(agentDir, 'memory', `${new Date().toISOString().slice(0, 10)}.md`)),
    ).toBe(false)
  })

  it('does not let an earlier turn opt-out suppress persistence for the current turn', async () => {
    setAgent({ memoryEnabled: true, apiKey: 'test-key' })
    setChatMessages([
      { role: 'user', content: '不要修改任何记忆，只回答 Silver-Quill 的问题。' },
      { role: 'agent', content: 'Silver-Quill 的答案是三个工作日。' },
      {
        role: 'user',
        content: '以后 Cedar-Ridge 发布评审固定先列风险，再列回滚方案。',
      },
      { role: 'agent', content: '理解。' },
    ])
    mockProviderSuccess('## 10:00 Captured the current preference')

    await generateWorkLog('agt_test', 'run_test', true)

    expect(mockExecuteWithRetry).toHaveBeenCalledTimes(1)
    const payload = getMemoryProviderPayload()
    expect(payload.prompt).toContain('Cedar-Ridge')
    expect(payload.prompt).not.toContain('Silver-Quill')
  })

  it('freezes each turn before it waits behind an earlier memory job', async () => {
    setAgent({ memoryEnabled: true, apiKey: 'test-key' })
    let resolveFirst: ((value: unknown) => void) | undefined
    mockExecuteWithRetry
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            resolveFirst = resolve
          }),
      )
      .mockResolvedValue({
        result: { success: true, output: '## 10:01 Second turn', durationMs: 1 },
        retries: [],
        logs: [],
      })

    setChatMessages([{ role: 'user', content: 'First queued turn.' }])
    // generateWorkLog resolves only when the queued job finishes, so hold the
    // promise instead of awaiting it — the first job is deliberately parked.
    const first = generateWorkLog('agt_test', 'run_test', true)
    await vi.waitFor(() => expect(resolveFirst).toBeDefined())
    setChatMessages([
      { role: 'user', content: 'First queued turn.' },
      { role: 'agent', content: 'First answer.' },
      { role: 'user', content: 'Second queued turn.' },
      { role: 'agent', content: 'Second answer.' },
    ])
    const second = generateWorkLog('agt_test', 'run_test', true)
    // The snapshot read is async now, so let those microtasks drain before the
    // messages change below — otherwise the second job would freeze the future
    // turn instead of its own.
    await Promise.resolve()
    await Promise.resolve()

    setChatMessages([{ role: 'user', content: 'Future turn must not leak backward.' }])
    resolveFirst?.({
      result: { success: true, output: '## 10:00 First turn', durationMs: 1 },
      retries: [],
      logs: [],
    })
    await Promise.all([first, second])

    expect(mockExecuteWithRetry).toHaveBeenCalledTimes(2)
    const firstPrompt = (mockExecuteWithRetry.mock.calls[0]?.[1] as { prompt: string }).prompt
    const secondPrompt = (mockExecuteWithRetry.mock.calls[1]?.[1] as { prompt: string }).prompt
    expect(firstPrompt).toContain('First queued turn.')
    expect(secondPrompt).toContain('Second queued turn.')
    expect(secondPrompt).not.toContain('First queued turn.')
    expect(secondPrompt).not.toContain('Future turn must not leak backward.')
  })

  it('writes daily log only when insight is disabled', async () => {
    setAgent({ memoryEnabled: true, apiKey: 'test-key', memoryAutoInsight: false })
    setChatMessages([{ role: 'user', content: 'Fix bug' }])
    mockProviderSuccess('## 10:00 Fixed bug\n- Details here')

    const agentDir = join(testRoot, 'agt_test')
    mkdirSync(join(agentDir, 'memory'), { recursive: true })

    await generateWorkLog('agt_test', 'run_test', true)

    expect(mockExecuteWithRetry).toHaveBeenCalledTimes(1)
    // Daily log should exist
    const today = new Date().toISOString().slice(0, 10)
    expect(existsSync(join(agentDir, 'memory', `${today}.md`))).toBe(true)
    // MEMORY.md should NOT be created
    expect(existsSync(join(agentDir, 'MEMORY.md'))).toBe(false)
  })

  it('writes structured insights to a topic when worklog is disabled', async () => {
    setAgent({ memoryEnabled: true, apiKey: 'test-key', memoryWorklogEnabled: false })
    setChatMessages([{ role: 'user', content: 'I prefer TypeScript' }])
    mockProviderSuccess(
      JSON.stringify({
        topics: [
          {
            title: 'TypeScript conventions',
            scope: 'Reusable TypeScript implementation conventions.',
            description: 'TypeScript implementation conventions.',
            keywords: ['typescript', 'conventions'],
            section: 'Decisions and Conventions',
            items: ['Prefer TypeScript.', 'Keep strict type checking enabled.'],
          },
        ],
        summary: [],
      }),
    )

    const agentDir = join(testRoot, 'agt_test')
    mkdirSync(join(agentDir, 'memory'), { recursive: true })

    await generateWorkLog('agt_test', 'run_test', true)

    expect(mockExecuteWithRetry).toHaveBeenCalledTimes(1)
    // MEMORY.md is a catalog, while durable details live in the topic body.
    expect(existsSync(join(agentDir, 'MEMORY.md'))).toBe(true)
    const main = readFileSync(join(agentDir, 'MEMORY.md'), 'utf-8')
    expect(main).toContain('TypeScript conventions')
    expect(main).not.toContain('Keep strict type checking enabled.')
    const topicDir = join(agentDir, 'memory', 'topics')
    const topicFiles = (await import('node:fs')).readdirSync(topicDir)
    const topic = readFileSync(join(topicDir, topicFiles[0]), 'utf-8')
    expect(topic).toContain('Keep strict type checking enabled.')
    // Daily log should NOT exist
    const today = new Date().toISOString().slice(0, 10)
    expect(existsSync(join(agentDir, 'memory', `${today}.md`))).toBe(false)
  })

  it('generates work log and writes to new daily file', async () => {
    setAgent({ memoryEnabled: true, apiKey: 'test-key' })
    setChatMessages([
      { role: 'user', content: 'Fix the login bug' },
      { role: 'agent', content: 'Fixed the login validation issue' },
    ])
    mockProviderSuccess('## 10:00 Fixed login bug\n- Fixed validation issue')

    const agentDir = join(testRoot, 'agt_test')
    mkdirSync(join(agentDir, 'memory'), { recursive: true })

    await generateWorkLog('agt_test', 'run_test', true)

    expect(mockExecuteWithRetry).toHaveBeenCalledTimes(1)
    expect(mockReindexAgentFts).toHaveBeenCalledWith('agt_test')
    expect(logger.info).toHaveBeenCalledWith(
      expect.objectContaining({ agentId: 'agt_test', runId: 'run_test' }),
      'Auto work log generated',
    )
  })

  it('appends to existing daily file', async () => {
    setAgent({ memoryEnabled: true, apiKey: 'test-key' })
    setChatMessages([{ role: 'user', content: 'Deploy to prod' }])
    mockProviderSuccess('## 14:00 Deployed\n- Deployed to production')

    const agentDir = join(testRoot, 'agt_test')
    mkdirSync(join(agentDir, 'memory'), { recursive: true })

    const today = new Date().toISOString().slice(0, 10)
    const dailyFile = join(agentDir, 'memory', `${today}.md`)
    const { writeFileSync } = await import('node:fs')
    writeFileSync(dailyFile, '## 09:00 Morning standup\n- Discussed priorities', 'utf-8')

    await generateWorkLog('agt_test', 'run_test', true)

    const content = readFileSync(dailyFile, 'utf-8')
    expect(content).toContain('## 09:00 Morning standup')
    expect(content).toContain('## 14:00 Deployed')
  })

  it('handles memory provider failure gracefully', async () => {
    setAgent({ memoryEnabled: true, apiKey: 'test-key' })
    setChatMessages([{ role: 'user', content: 'Do something' }])
    mockProviderFailure('provider failed')

    await generateWorkLog('agt_test', 'run_test', true)

    expect(logger.error).toHaveBeenCalledWith(
      expect.objectContaining({ agentId: 'agt_test', runId: 'run_test' }),
      'Memory provider summarization failed or returned empty',
    )
  })

  it('writes log for failed runs', async () => {
    setAgent({ memoryEnabled: true, apiKey: 'test-key' })
    setChatMessages([{ role: 'user', content: 'Run failed task' }])
    mockProviderSuccess('## 10:00 Failed task\n- Run failed due to timeout')

    const agentDir = join(testRoot, 'agt_test')
    mkdirSync(join(agentDir, 'memory'), { recursive: true })

    await generateWorkLog('agt_test', 'run_test', false)

    expect(getMemoryProviderPayload().prompt).toContain('error')
  })

  it('triggers reindex after writing', async () => {
    setAgent({ memoryEnabled: true, apiKey: 'test-key' })
    setChatMessages([{ role: 'user', content: 'hello' }])
    mockProviderSuccess('## 10:00 Test\n- Done')
    mockIsEmbeddingAvailable.mockReturnValue(true)

    const agentDir = join(testRoot, 'agt_test')
    mkdirSync(join(agentDir, 'memory'), { recursive: true })

    await generateWorkLog('agt_test', 'run_test', true)

    expect(mockReindexAgentFts).toHaveBeenCalledWith('agt_test')
    expect(mockReindexAgentVectors).toHaveBeenCalled()
  })

  it('inherits provider config from buildAgentConfig', async () => {
    setAgent({
      memoryEnabled: true,
      apiKey: 'custom-key',
      baseUrl: 'https://custom.api.com',
    })
    setChatMessages([{ role: 'user', content: 'hello' }])
    mockProviderSuccess('## 10:00 Test\n- Done')

    const agentDir = join(testRoot, 'agt_test')
    mkdirSync(join(agentDir, 'memory'), { recursive: true })

    await generateWorkLog('agt_test', 'run_test', true)

    const payload = getMemoryProviderPayload()
    expect(payload.model).toBe('provider-model')
    expect(payload.agentConfig.engineType).toBe('cursor')
    expect(payload.agentConfig.providerApiKey).toBe('provider-key')
  })

  it('allows auto memory to override the inherited provider model', async () => {
    setAgent({
      memoryEnabled: true,
      memoryModel: 'memory-fast-model',
    })
    setChatMessages([{ role: 'user', content: 'hello' }])
    mockProviderSuccess('## 10:00 Test\n- Done')

    const agentDir = join(testRoot, 'agt_test')
    mkdirSync(join(agentDir, 'memory'), { recursive: true })

    await generateWorkLog('agt_test', 'run_test', true)

    const payload = getMemoryProviderPayload()
    expect(payload.model).toBe('memory-fast-model')
    expect(payload.agentConfig.model).toBe('memory-fast-model')
    expect(payload.agentConfig.providerApiKey).toBe('provider-key')
  })

  it('extracts structured insights into a bounded topic and catalog', async () => {
    setAgent({ memoryEnabled: true, apiKey: 'test-key' })
    setChatMessages([
      { role: 'user', content: 'I prefer snake_case for all Python files' },
      { role: 'agent', content: 'Noted, I will use snake_case going forward' },
    ])
    mockProviderSuccess(`## 10:00 Code style discussion
- Discussed naming conventions
---INSIGHTS---
${JSON.stringify({
  topics: [
    {
      title: 'Python naming conventions',
      scope: 'Stable naming conventions for Python source files.',
      description: 'Python file naming conventions.',
      keywords: ['python', 'snake_case'],
      section: 'Decisions and Conventions',
      items: [
        'Use snake_case for Python files.',
        'Apply the naming rule consistently across packages.',
      ],
    },
  ],
  summary: [],
})}`)

    const agentDir = join(testRoot, 'agt_test')
    mkdirSync(join(agentDir, 'memory'), { recursive: true })

    await generateWorkLog('agt_test', 'run_test', true)

    const memoryMd = readFileSync(join(agentDir, 'MEMORY.md'), 'utf-8')
    expect(memoryMd).toContain('Python naming conventions')
    expect(memoryMd).not.toContain('Apply the naming rule consistently across packages.')

    const topicDir = join(agentDir, 'memory', 'topics')
    const topicFiles = (await import('node:fs')).readdirSync(topicDir)
    const topic = readFileSync(join(topicDir, topicFiles[0]), 'utf-8')
    expect(topic).toContain('Use snake_case for Python files.')
    expect(topic).toContain('Run `run_test`')

    const today = new Date().toISOString().slice(0, 10)
    const dailyFile = readFileSync(join(agentDir, 'memory', `${today}.md`), 'utf-8')
    expect(dailyFile).toContain('Code style discussion')
    expect(dailyFile).not.toContain('---INSIGHTS---')
  })

  it('retains only unprocessed facts when a later topic insight fails', async () => {
    setAgent({ memoryEnabled: true, apiKey: 'test-key' })
    setChatMessages([{ role: 'user', content: 'Record two durable policies.' }])
    mockProviderSuccess(`## 10:00 Durable policy update
- Captured two policies.
---INSIGHTS---
${JSON.stringify({
  topics: [
    {
      title: 'Validated deployment policy',
      scope: 'Stable deployment validation requirements.',
      description: 'Deployment validation policy.',
      keywords: ['deployment', 'validation'],
      section: 'Decisions and Conventions',
      items: ['Run focused tests before deployment.', 'Record the release owner.'],
    },
    {
      title: '',
      scope: 'A malformed insight that must remain in history.',
      description: 'Malformed insight fixture.',
      keywords: ['malformed'],
      section: 'Durable Knowledge',
      items: ['Retain this failed fact in history.', 'Do not lose this fallback evidence.'],
    },
  ],
  summary: [],
})}`)

    await generateWorkLog('agt_test', 'run_test', true)

    const topics = listMemoryTopics('agt_test').topics
    expect(topics).toHaveLength(1)
    expect(topics[0]?.body).toContain('Run focused tests before deployment.')

    const today = new Date().toISOString().slice(0, 10)
    const dailyFile = readFileSync(join(testRoot, 'agt_test', 'memory', `${today}.md`), 'utf-8')
    expect(dailyFile).toContain('Retain this failed fact in history.')
    expect(dailyFile).not.toContain('Run focused tests before deployment.')
  })

  it('retains an evidence pointer in history when the topic hard limit rejects it', async () => {
    setAgent({ memoryEnabled: true, apiKey: 'test-key' })
    setChatMessages([{ role: 'user', content: 'Confirm the deployment rule.' }])
    const created = applyInsightToTopics('agt_test', {
      title: 'Deployment evidence policy',
      scope: 'Stable deployment evidence requirements.',
      description: 'Deployment evidence policy.',
      keywords: ['deployment', 'evidence'],
      section: 'Durable Knowledge',
      items: ['Keep the deployment approval record.', 'Keep the rollback owner record.'],
    })
    const topicId = created.topic?.topicId as string
    let filler = ''
    let body = ''
    do {
      filler += 'x'.repeat(40)
      body = `# Deployment evidence policy\n\n## Durable Knowledge\n\n- Keep the deployment approval record.\n- ${filler}`
    } while (estimateMemoryTokens(body) < 1990)
    replaceTopicBody('agt_test', topicId, body)

    mockProviderSuccess(`## 10:00 Deployment policy confirmation
- Confirmed the existing rule.
---INSIGHTS---
${JSON.stringify({
  topics: [
    {
      topicId,
      title: 'Deployment evidence policy',
      scope: 'Stable deployment evidence requirements.',
      description: 'Deployment evidence policy.',
      keywords: ['deployment', 'evidence'],
      section: 'Durable Knowledge',
      items: ['Keep the deployment approval record.'],
    },
  ],
  summary: [],
})}`)

    await generateWorkLog('agt_test', 'run_test', true)

    const today = new Date().toISOString().slice(0, 10)
    const dailyFile = readFileSync(join(testRoot, 'agt_test', 'memory', `${today}.md`), 'utf-8')
    expect(dailyFile).toContain(`Run \`run_test\`; summarized in \`memory/${today}.md\`.`)
  })

  it('routes one durable fact into an existing topic when an entity anchor and two scope signals agree', async () => {
    setAgent({ memoryEnabled: true, apiKey: 'test-key' })
    setChatMessages([
      {
        role: 'user',
        content:
          'For every Cedar-Ridge release review, list risks first, then rollback, and end with the approving owner.',
      },
      { role: 'agent', content: 'Understood.' },
    ])

    const existing = applyInsightToTopics('agt_test', {
      title: 'Cedar-Ridge release governance',
      scope: 'Cedar-Ridge production release governance',
      description: 'Approval and rollback ownership for Cedar-Ridge releases.',
      keywords: ['Cedar-Ridge', 'releases', 'approvals', 'rollback'],
      section: 'Decisions and Conventions',
      items: [
        'Cedar-Ridge releases require two approvers before production deployment.',
        'The Platform Reliability team owns Cedar-Ridge rollback decisions.',
      ],
    })

    mockProviderSuccess(`## 10:00 Cedar-Ridge review preference
- Captured the stable review format.
---INSIGHTS---
${JSON.stringify({
  topics: [
    {
      title: 'Cedar-Ridge release review preference',
      scope: 'Cedar-Ridge release review response format',
      description: 'Stable response structure for Cedar-Ridge release reviews.',
      keywords: ['Cedar-Ridge', 'review', 'response format'],
      section: 'Decisions and Conventions',
      items: [
        'Cedar-Ridge release reviews list risks first, then the rollback plan, and end with the approving owner.',
      ],
    },
  ],
  summary: [],
})}`)

    await generateWorkLog('agt_test', 'run_test', true)

    const topics = listMemoryTopics('agt_test').topics
    expect(topics).toHaveLength(1)
    expect(topics[0]?.topicId).toBe(existing.topic?.topicId)
    expect(readMemoryTopic('agt_test', existing.topic?.topicId as string).body).toContain(
      'Cedar-Ridge release reviews list risks first, then the rollback plan',
    )

    const today = new Date().toISOString().slice(0, 10)
    const dailyFile = readFileSync(join(testRoot, 'agt_test', 'memory', `${today}.md`), 'utf-8')
    expect(dailyFile).not.toContain('Long-term insight fallback')
  })

  it('skips insights when memoryAutoInsight is false', async () => {
    mockDbStore._getResult = {
      id: 'agt_test',
      memoryProviderApiKey: 'test-key',
      config: {
        memoryEnabled: true,
        memoryAutoInsight: false,
      },
    }
    setChatMessages([{ role: 'user', content: 'hello' }])
    mockProviderSuccess('## 10:00 Test\n- Done\n---INSIGHTS---\n- Some insight')

    const agentDir = join(testRoot, 'agt_test')
    mkdirSync(join(agentDir, 'memory'), { recursive: true })

    await generateWorkLog('agt_test', 'run_test', true)

    expect(existsSync(join(agentDir, 'MEMORY.md'))).toBe(false)
  })

  it('does not write insights when no INSIGHTS section', async () => {
    setAgent({ memoryEnabled: true, apiKey: 'test-key' })
    setChatMessages([{ role: 'user', content: 'simple fix' }])
    mockProviderSuccess('## 10:00 Simple fix\n- Fixed a typo')

    const agentDir = join(testRoot, 'agt_test')
    mkdirSync(join(agentDir, 'memory'), { recursive: true })

    await generateWorkLog('agt_test', 'run_test', true)

    expect(existsSync(join(agentDir, 'MEMORY.md'))).toBe(false)
  })

  it('appends structured auto insights as Markdown for a legacy single-file Agent', async () => {
    setAgent({ memoryEnabled: true, apiKey: 'test-key' })
    setChatMessages([
      {
        role: 'user',
        content: 'Stellar-Pine reports always use ISO 8601 timestamps in UTC.',
      },
    ])
    mockProviderSuccess(`## 10:00 Reporting convention
- Confirmed the stable timestamp convention.
---INSIGHTS---
${JSON.stringify({
  topics: [
    {
      title: 'Stellar-Pine reporting',
      scope: 'Stellar-Pine project reports',
      description: 'Stable timestamp convention for reports.',
      keywords: ['Stellar-Pine', 'UTC', 'ISO 8601'],
      section: 'Decisions and Conventions',
      items: ['Stellar-Pine reports use ISO 8601 timestamps in UTC and never local time.'],
    },
  ],
  summary: [],
})}`)

    const agentDir = join(testRoot, 'agt_test')
    mkdirSync(join(agentDir, 'memory'), { recursive: true })
    const { writeFileSync } = await import('node:fs')
    writeFileSync(join(agentDir, 'MEMORY.md'), '# Legacy Agent Memory\n', 'utf-8')

    await generateWorkLog('agt_test', 'run_test', true)

    const content = readFileSync(join(agentDir, 'MEMORY.md'), 'utf-8')
    expect(content).toContain('## Stellar-Pine reporting')
    expect(content).toContain(
      '- Stellar-Pine reports use ISO 8601 timestamps in UTC and never local time.',
    )
    expect(content).not.toContain('{"topics"')
    expect(existsSync(join(agentDir, 'memory', 'topics'))).toBe(false)
  })

  it('triggers LLM compression and appends insights when MEMORY.md would exceed char limit', async () => {
    setAgent({ memoryEnabled: true, apiKey: 'test-key' })
    setChatMessages([{ role: 'user', content: 'hello' }])

    const longContent = 'x'.repeat(3570)
    const compressedContent = '- Compressed summary\n- New insight'

    // First provider run: worklog + insights; second provider run: compression result
    let callCount = 0
    mockExecuteWithRetry.mockImplementation(() => {
      callCount++
      const text =
        callCount === 1 ? '## 10:00 Test\n---INSIGHTS---\n- New insight' : compressedContent
      return Promise.resolve({
        result: { success: true, output: text, durationMs: 1 },
        retries: [],
        logs: [],
      })
    })

    const agentDir = join(testRoot, 'agt_test')
    mkdirSync(join(agentDir, 'memory'), { recursive: true })
    const { writeFileSync } = await import('node:fs')
    writeFileSync(join(agentDir, 'MEMORY.md'), longContent, 'utf-8')

    await generateWorkLog('agt_test', 'run_test', true)

    expect(callCount).toBe(2) // worklog call + compression call
    const content = readFileSync(join(agentDir, 'MEMORY.md'), 'utf-8')
    expect(content).toContain('New insight')
    expect(content).toContain('Compressed summary')
  })

  it('uses configured MEMORY.md compression threshold before triggering compression', async () => {
    setAgent({
      memoryEnabled: true,
      apiKey: 'test-key',
      memoryCompressionThresholdChars: 5000,
    })
    setChatMessages([{ role: 'user', content: 'hello' }])

    const longContent = 'x'.repeat(3570)
    let callCount = 0
    mockExecuteWithRetry.mockImplementation(() => {
      callCount++
      return Promise.resolve({
        result: {
          success: true,
          output: '## 10:00 Test\n---INSIGHTS---\n- New insight',
          durationMs: 1,
        },
        retries: [],
        logs: [],
      })
    })

    const agentDir = join(testRoot, 'agt_test')
    mkdirSync(join(agentDir, 'memory'), { recursive: true })
    const { writeFileSync } = await import('node:fs')
    writeFileSync(join(agentDir, 'MEMORY.md'), longContent, 'utf-8')

    await generateWorkLog('agt_test', 'run_test', true)

    expect(callCount).toBe(1)
    const content = readFileSync(join(agentDir, 'MEMORY.md'), 'utf-8')
    expect(content).toContain('New insight')
  })

  it('instructs memory compression to return final MEMORY.md content inline without plan files', async () => {
    setAgent({ memoryEnabled: true, apiKey: 'test-key' })
    setChatMessages([{ role: 'user', content: 'hello' }])

    const longContent = 'x'.repeat(3570)
    let callCount = 0
    mockExecuteWithRetry.mockImplementation(() => {
      callCount++
      return Promise.resolve({
        result: {
          success: true,
          output:
            callCount === 1
              ? '## 10:00 Test\n---INSIGHTS---\n- New insight'
              : '- Compressed summary\n- New insight',
          durationMs: 1,
        },
        retries: [],
        logs: [],
      })
    })

    const agentDir = join(testRoot, 'agt_test')
    mkdirSync(join(agentDir, 'memory'), { recursive: true })
    const { writeFileSync } = await import('node:fs')
    writeFileSync(join(agentDir, 'MEMORY.md'), longContent, 'utf-8')

    await generateWorkLog('agt_test', 'run_test', true)

    const compressionPayload = mockExecuteWithRetry.mock.calls[1]?.[1] as {
      agentConfig: { systemPrompt?: string }
    }
    const prompt = compressionPayload.agentConfig.systemPrompt ?? ''
    expect(prompt).toContain('Return the complete final MEMORY.md content directly')
    expect(prompt).toContain('Do not create, write to, reference, or rely on any plan file')
    expect(prompt).toContain('The first line must be an actual MEMORY.md memory entry')
    expect(prompt).toContain('Any explanatory text makes the result invalid')
  })

  it('uses configured MEMORY.md compression target in the compression prompt', async () => {
    setAgent({
      memoryEnabled: true,
      apiKey: 'test-key',
      memoryCompressionThresholdChars: 5000,
      memoryCompressionTargetChars: 1800,
    })
    setChatMessages([{ role: 'user', content: 'hello' }])

    const longContent = 'x'.repeat(4995)
    let callCount = 0
    mockExecuteWithRetry.mockImplementation(() => {
      callCount++
      return Promise.resolve({
        result: {
          success: true,
          output:
            callCount === 1
              ? '## 10:00 Test\n---INSIGHTS---\n- New insight'
              : '- Compressed summary\n- New insight',
          durationMs: 1,
        },
        retries: [],
        logs: [],
      })
    })

    const agentDir = join(testRoot, 'agt_test')
    mkdirSync(join(agentDir, 'memory'), { recursive: true })
    const { writeFileSync } = await import('node:fs')
    writeFileSync(join(agentDir, 'MEMORY.md'), longContent, 'utf-8')

    await generateWorkLog('agt_test', 'run_test', true)

    const compressionPayload = mockExecuteWithRetry.mock.calls[1]?.[1] as {
      agentConfig: { systemPrompt?: string }
    }
    const prompt = compressionPayload.agentConfig.systemPrompt ?? ''
    expect(prompt).toContain('5000-character limit')
    expect(prompt).toContain('under 1800 characters')
  })

  it('preserves MEMORY.md writes that happen while compression is running', async () => {
    setAgent({ memoryEnabled: true, apiKey: 'test-key' })
    setChatMessages([{ role: 'user', content: 'hello' }])

    const longContent = 'x'.repeat(3570)
    let resolveCompression:
      | ((value: {
          result: { success: true; output: string; durationMs: number }
          retries: []
          logs: []
        }) => void)
      | undefined

    let callCount = 0
    mockExecuteWithRetry.mockImplementation(() => {
      callCount++
      if (callCount === 1) {
        return Promise.resolve({
          result: {
            success: true,
            output: '## 10:00 Test\n---INSIGHTS---\n- New insight',
            durationMs: 1,
          },
          retries: [],
          logs: [],
        })
      }
      if (callCount === 2) {
        return new Promise((resolve) => {
          resolveCompression = () =>
            resolve({
              result: {
                success: true,
                output: '- Stale compression\n- New insight',
                durationMs: 1,
              },
              retries: [],
              logs: [],
            })
        })
      }
      return Promise.resolve({
        result: {
          success: true,
          output: '- Compressed summary\n- User added explicit memory\n- New insight',
          durationMs: 1,
        },
        retries: [],
        logs: [],
      })
    })

    const agentDir = join(testRoot, 'agt_test')
    mkdirSync(join(agentDir, 'memory'), { recursive: true })
    const { writeFileSync } = await import('node:fs')
    writeFileSync(join(agentDir, 'MEMORY.md'), longContent, 'utf-8')

    // Hold the promise rather than awaiting: it settles only once the compression
    // call this test deliberately parks has been released below.
    const worklogPromise = generateWorkLog('agt_test', 'run_test', true)
    await vi.waitFor(() => expect(resolveCompression).toBeDefined())

    writeFileSync(
      join(agentDir, 'MEMORY.md'),
      `${longContent}\n\n- User added explicit memory`,
      'utf-8',
    )
    resolveCompression?.({
      result: {
        success: true,
        output: '- Stale compression\n- New insight',
        durationMs: 1,
      },
      retries: [],
      logs: [],
    })

    await worklogPromise

    const content = readFileSync(join(agentDir, 'MEMORY.md'), 'utf-8')
    expect(content).toContain('User added explicit memory')
    expect(content).toContain('New insight')
  })

  it('preserves raw insights in daily work log when MEMORY.md compression fails', async () => {
    setAgent({ memoryEnabled: true, apiKey: 'test-key' })
    setChatMessages([{ role: 'user', content: 'hello' }])

    const longContent = 'x'.repeat(3570)

    let callCount = 0
    mockExecuteWithRetry.mockImplementation(() => {
      callCount++
      if (callCount === 1) {
        return Promise.resolve({
          result: {
            success: true,
            output: '## 10:00 Test\n---INSIGHTS---\n- New insight',
            durationMs: 1,
          },
          retries: [],
          logs: [],
        })
      }
      return Promise.resolve({
        result: { success: false, output: '', error: 'compression failed', durationMs: 1 },
        retries: [],
        logs: [],
      })
    })

    const agentDir = join(testRoot, 'agt_test')
    mkdirSync(join(agentDir, 'memory'), { recursive: true })
    const { writeFileSync } = await import('node:fs')
    writeFileSync(join(agentDir, 'MEMORY.md'), longContent, 'utf-8')

    await generateWorkLog('agt_test', 'run_test', true)

    const content = readFileSync(join(agentDir, 'MEMORY.md'), 'utf-8')
    expect(content).not.toContain('New insight')

    const dateStr = new Date().toISOString().slice(0, 10)
    const dailyLog = readFileSync(join(agentDir, 'memory', `${dateStr}.md`), 'utf-8')
    expect(dailyLog).toContain('New insight')
    expect(dailyLog).toContain('MEMORY.md 压缩失败')
  })

  it('uses default worklog prompt with {{time}} substitution', async () => {
    setAgent({ memoryEnabled: true, apiKey: 'test-key', memoryAutoInsight: false })
    setChatMessages([{ role: 'user', content: 'hello' }])
    mockProviderSuccess('## 10:00 Test')

    const agentDir = join(testRoot, 'agt_test')
    mkdirSync(join(agentDir, 'memory'), { recursive: true })

    await generateWorkLog('agt_test', 'run_test', true)

    const systemPrompt = getMemoryProviderPayload().agentConfig.systemPrompt ?? ''
    expect(systemPrompt).toContain('## ') // time substituted, no literal {{time}}
    expect(systemPrompt).not.toContain('{{time}}')
    expect(systemPrompt).toContain('目标')
    expect(systemPrompt).toContain('过程')
  })

  it('uses custom worklog prompt when memoryWorklogPrompt is configured', async () => {
    const customPrompt = 'You are a custom logger. Record task as "## {{time}} - Custom".'
    setAgent({
      memoryEnabled: true,
      apiKey: 'test-key',
      memoryAutoInsight: false,
      memoryWorklogPrompt: customPrompt,
    })
    setChatMessages([{ role: 'user', content: 'hello' }])
    mockProviderSuccess('## 10:00 - Custom')

    const agentDir = join(testRoot, 'agt_test')
    mkdirSync(join(agentDir, 'memory'), { recursive: true })

    await generateWorkLog('agt_test', 'run_test', true)

    const systemPrompt = getMemoryProviderPayload().agentConfig.systemPrompt ?? ''
    expect(systemPrompt).toContain('custom logger')
    expect(systemPrompt).not.toContain('{{time}}')
    expect(systemPrompt).not.toContain('Goal') // default prompt not used
  })

  it('keeps a custom insight prompt compatible with the topic-v2 output contract', async () => {
    const customPrompt = 'Extract key facts. Existing:\n{{existingMemory}}'
    setAgent({
      memoryEnabled: true,
      apiKey: 'test-key',
      memoryWorklogEnabled: false,
      memoryInsightPrompt: customPrompt,
    })
    setChatMessages([{ role: 'user', content: 'I prefer tabs' }])
    mockProviderSuccess(
      JSON.stringify({
        topics: [
          {
            title: 'Editor preferences',
            scope: 'Stable source-code editor preferences.',
            description: 'Stable editor formatting preferences.',
            keywords: ['editor', 'tabs'],
            section: 'Decisions and Conventions',
            items: ['Prefer tabs for indentation.', 'Keep tab width at four columns.'],
          },
        ],
        summary: [],
      }),
    )

    const agentDir = join(testRoot, 'agt_test')
    mkdirSync(join(agentDir, 'memory'), { recursive: true })

    await generateWorkLog('agt_test', 'run_test', true)

    const systemPrompt = getMemoryProviderPayload().agentConfig.systemPrompt ?? ''
    expect(systemPrompt).toContain('Extract key facts')
    expect(systemPrompt).not.toContain('{{existingMemory}}')
    expect(systemPrompt).not.toContain('用户偏好和工作风格') // default not used
    expect(systemPrompt).toContain('{"topics"')
    expect(readFileSync(join(agentDir, 'MEMORY.md'), 'utf-8')).toContain('Editor preferences')
  })

  it('DEFAULT_WORKLOG_PROMPT and DEFAULT_INSIGHT_PROMPT are exported and contain placeholders', async () => {
    expect(DEFAULT_WORKLOG_PROMPT).toContain('{{time}}')
    expect(DEFAULT_WORKLOG_PROMPT).toContain('目标')
    expect(DEFAULT_WORKLOG_PROMPT).toContain('过程')
    expect(DEFAULT_INSIGHT_PROMPT).toContain('{{existingMemory}}')
    expect(DEFAULT_INSIGHT_PROMPT).toContain('MEMORY.md')
  })

  it('default insight prompt separates long-term facts from transient worklog facts', async () => {
    expect(DEFAULT_INSIGHT_PROMPT).toContain('四问门槛')
    expect(DEFAULT_INSIGHT_PROMPT).toContain('长期性')
    expect(DEFAULT_INSIGHT_PROMPT).toContain('稳定性')
    expect(DEFAULT_INSIGHT_PROMPT).toContain('可行动性')
    expect(DEFAULT_INSIGHT_PROMPT).toContain('非显而易见')

    expect(DEFAULT_INSIGHT_PROMPT).toContain(
      '以后 / 默认 / 长期 / stable preference / 每次 / 固定 / 总是 / always',
    )
    expect(DEFAULT_INSIGHT_PROMPT).toContain('标题风格')
    expect(DEFAULT_INSIGHT_PROMPT).toContain('架构或方案选型的稳定理由')
    expect(DEFAULT_INSIGHT_PROMPT).toContain('项目特有约定或术语')

    expect(DEFAULT_INSIGHT_PROMPT).toContain('测试标识')
    expect(DEFAULT_INSIGHT_PROMPT).toContain('临时 marker')
    expect(DEFAULT_INSIGHT_PROMPT).toContain('一次性报告标题')
    expect(DEFAULT_INSIGHT_PROMPT).toContain('runId')
    expect(DEFAULT_INSIGHT_PROMPT).toContain('已完成 / 已确认 / 已测试 / 已推送')
    expect(DEFAULT_INSIGHT_PROMPT).toContain('{"topics":[],"summary":[]}')
    expect(DEFAULT_INSIGHT_PROMPT).toContain('稳定复用范围')
    expect(DEFAULT_INSIGHT_PROMPT).toContain('强制边界')
    expect(DEFAULT_INSIGHT_PROMPT).toContain('视为长期用户偏好，应保存')
    expect(DEFAULT_INSIGHT_PROMPT).toContain('只用于当前任务')
    expect(DEFAULT_INSIGHT_PROMPT).toContain('判定示例')
    expect(DEFAULT_INSIGHT_PROMPT).toContain('固定标题风格')
    expect(DEFAULT_INSIGHT_PROMPT).toContain('本次一次性报告标题')
  })

  it('serializes concurrent writes for same agent via Promise chain', async () => {
    setAgent({ memoryEnabled: true, apiKey: 'test-key' })

    let callCount = 0
    const providerFn = vi.fn().mockImplementation(() => {
      callCount++
      const n = callCount
      return Promise.resolve({
        result: { success: true, output: `## 10:0${n} Task ${n}\n- Done ${n}`, durationMs: 1 },
        retries: [],
        logs: [],
      })
    })
    mockExecuteWithRetry.mockImplementation(providerFn)

    const agentDir = join(testRoot, 'agt_test')
    mkdirSync(join(agentDir, 'memory'), { recursive: true })

    setChatMessages([{ role: 'user', content: 'task 1' }])

    const p1 = await generateWorkLog('agt_test', 'run_1', true)
    const p2 = await generateWorkLog('agt_test', 'run_2', true)

    await Promise.all([p1, p2])

    expect(providerFn).toHaveBeenCalledTimes(2)

    const today = new Date().toISOString().slice(0, 10)
    const dailyFile = join(agentDir, 'memory', `${today}.md`)
    if (existsSync(dailyFile)) {
      const content = readFileSync(dailyFile, 'utf-8')
      expect(content).toContain('Task 1')
      expect(content).toContain('Task 2')
    }
  })
})
