import { expect, test } from '@playwright/test'
import {
  type AgentDetail,
  createAgentWithPayload,
  deleteAgentAs,
  executeAgentChat,
  getAdminToken,
  listProviders,
} from '../../utils/api-helpers'
import { loginAsAdmin } from '../../utils/auth'
import { API_BASE } from '../../utils/test-constants'

test.setTimeout(120_000)

interface TopicMetadata {
  topicId: string
  title: string
  description: string
  path: string
  status: 'active' | 'archived'
  tokenCount: number
  needsReorganization: boolean
}

interface TopicList {
  mode: 'empty' | 'legacy_single_file' | 'topic_v2'
  topics: TopicMetadata[]
  invalidFiles: string[]
}

async function memoryRequest<T>(
  token: string,
  agentId: string,
  path: string,
  init?: RequestInit,
): Promise<{ response: Response; data?: T; body: Record<string, unknown> }> {
  const response = await fetch(`${API_BASE}/api/memories/${agentId}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${token}`,
      ...(init?.body ? { 'Content-Type': 'application/json' } : {}),
      ...init?.headers,
    },
  })
  const body = (await response.json().catch(() => ({}))) as Record<string, unknown>
  return { response, data: body.data as T | undefined, body }
}

async function memoryData<T>(
  token: string,
  agentId: string,
  path: string,
  init?: RequestInit,
): Promise<T> {
  const result = await memoryRequest<T>(token, agentId, path, init)
  if (!result.response.ok) {
    throw new Error(
      `Memory request ${init?.method ?? 'GET'} ${path} failed: ${result.response.status} ${JSON.stringify(result.body)}`,
    )
  }
  return result.data as T
}

async function createMemoryAgent(token: string, suffix: string): Promise<AgentDetail> {
  const providers = await listProviders(token)
  const provider = providers.find((item) => item.name === 'Codex CLI')
  if (!provider) throw new Error('Codex CLI provider fixture is missing')
  // Providers store no model catalog any more (models are probed per
  // credential), so the fixture names the model directly.
  const model = process.env.E2E_CODEX_MODEL ?? 'gpt-5.3-codex'

  return createAgentWithPayload(token, {
    name: `e2e-memory-${suffix}-${Date.now()}`,
    type: 'cursor',
    providerId: provider.id,
    authMode: 'localSession',
    config: {
      engineType: 'codex',
      model,
      timeoutMinutes: 2,
      readOnly: true,
      memoryEnabled: true,
      memoryContextMode: 'memory',
      memoryRecallLevel: 'medium',
      memoryWorklogEnabled: true,
      memoryAutoInsight: true,
      memoryConsolidationEnabled: true,
    },
  })
}

async function listTopics(
  token: string,
  agentId: string,
  status: 'active' | 'archived' | 'all' = 'active',
): Promise<TopicList> {
  return memoryData<TopicList>(token, agentId, `/topics?status=${status}`)
}

async function waitForTopics(token: string, agentId: string): Promise<TopicList> {
  await expect
    .poll(
      async () => {
        const result = await listTopics(token, agentId)
        return result.mode === 'topic_v2' ? result.topics.length : 0
      },
      { timeout: 20_000, intervals: [200, 400, 800, 1200] },
    )
    .toBeGreaterThan(0)
  return listTopics(token, agentId)
}

test.beforeEach(async ({ page }) => {
  await loginAsAdmin(page)
})

test.describe('Memory V2 progressive disclosure', () => {
  test('explicit topic write exposes metadata first, then one body, and preserves archive search', async ({
    page,
  }) => {
    const token = await getAdminToken()
    const agent = await createMemoryAgent(token, 'explicit')

    try {
      const write = await memoryData<{
        topic: TopicMetadata & { body: string }
        created: boolean
      }>(token, agent.id, '/topics/remember', {
        method: 'POST',
        body: JSON.stringify({
          title: 'Campaign mail delivery',
          scope: 'Campaign mail creation, validation, and release behavior.',
          description: 'Campaign mail contracts and release checks.',
          keywords: ['campaign', 'send_mail', 'serialization'],
          section: 'Durable Knowledge',
          items: ['Validate item_id serialization before release.'],
        }),
      })
      expect(write.created).toBe(true)

      const listed = await listTopics(token, agent.id)
      expect(listed.mode).toBe('topic_v2')
      expect(listed.topics).toHaveLength(1)
      expect(listed.topics[0]).not.toHaveProperty('body')
      expect(listed.topics[0]).not.toHaveProperty('content')

      const topic = await memoryData<TopicMetadata & { content: string }>(
        token,
        agent.id,
        `/topics/${write.topic.topicId}`,
      )
      expect(topic.content).toContain('Validate item_id serialization before release.')

      const main = await memoryData<{ filename: string; content: string }>(
        token,
        agent.id,
        '/files/MEMORY.md',
      )
      expect(main.content).toContain('## Topic Catalog')
      expect(main.content).toContain('Campaign mail contracts and release checks.')
      expect(main.content).not.toContain('Validate item_id serialization before release.')

      await page.goto(`/agents/${agent.id}?tab=memory`)
      await expect(page.getByTestId('memory-topic-directory')).toBeVisible({ timeout: 10_000 })
      await expect(page.getByText('Campaign mail contracts and release checks.')).toBeVisible()
      await expect(page.getByText(/Validate item_id serialization before release/)).toHaveCount(0)
      await page.getByRole('button', { name: /Campaign mail delivery/ }).click()
      await expect(page.getByText(/Validate item_id serialization before release/)).toBeVisible()

      await memoryData(token, agent.id, '/topics/reorganize', {
        method: 'POST',
        body: JSON.stringify({ action: 'archive', topicId: write.topic.topicId }),
      })
      expect((await listTopics(token, agent.id)).topics).toHaveLength(0)
      expect((await listTopics(token, agent.id, 'archived')).topics[0].status).toBe('archived')

      const archivedSearch = await memoryData<{
        results: Array<{ fileKind: string; topicId: string; snippet: string }>
      }>(token, agent.id, '/search?q=item_id&mode=keyword&limit=5')
      expect(archivedSearch.results[0]).toMatchObject({
        fileKind: 'archived_topic',
        topicId: write.topic.topicId,
      })

      await memoryData(token, agent.id, '/topics/reorganize', {
        method: 'POST',
        body: JSON.stringify({ action: 'reactivate', topicId: write.topic.topicId }),
      })
      expect((await listTopics(token, agent.id)).topics[0].topicId).toBe(write.topic.topicId)
    } finally {
      await deleteAgentAs(token, agent.id)
    }
  })

  test('completed Runs create a topic, inject only the compact catalog, and retain hard-limit overflow in history', async () => {
    const token = await getAdminToken()
    const agent = await createMemoryAgent(token, 'automatic')

    try {
      await executeAgentChat(token, agent.id, 'Start the E2E memory learning run.')
      const topics = await waitForTopics(token, agent.id)
      const topic = topics.topics[0]
      expect(topic.title).toBe('E2E memory delivery')

      const secondRun = await executeAgentChat(
        token,
        agent.id,
        'Verify that startup memory remains compact.',
      )
      expect(secondRun.reply).toContain('## Topic Catalog')
      expect(secondRun.reply).toContain('E2E memory delivery')
      expect(secondRun.reply).not.toContain('E2E durable topic detail alpha.')

      const nearLimitBody = `# E2E memory delivery\n\n## Workflows\n\n- ${'知'.repeat(1975)}`
      const replace = await memoryRequest<{
        topic: TopicMetadata
        warning: string | null
      }>(token, agent.id, '/topics/remember', {
        method: 'POST',
        body: JSON.stringify({ action: 'replace', topicId: topic.topicId, content: nearLimitBody }),
      })
      expect(replace.response.status).toBe(200)
      expect(replace.data?.warning).toBe('needs_reorganization')

      await executeAgentChat(token, agent.id, 'Generate another durable E2E memory insight.')
      const files = await memoryData<Array<{ name: string }>>(token, agent.id, '')
      const daily = files.find((file) => /^memory\/\d{4}-\d{2}-\d{2}\.md$/.test(file.name))
      expect(daily, 'daily worklog created').toBeTruthy()

      await expect
        .poll(
          async () => {
            const file = await memoryData<{ content: string }>(
              token,
              agent.id,
              `/files/${daily?.name}`,
            )
            return file.content.includes('E2E durable topic detail alpha.')
          },
          { timeout: 20_000, intervals: [200, 400, 800, 1200] },
        )
        .toBe(true)

      const unchanged = await memoryData<TopicMetadata & { content: string }>(
        token,
        agent.id,
        `/topics/${topic.topicId}`,
      )
      expect(unchanged.content).toBe(nearLimitBody)
      expect(unchanged.needsReorganization).toBe(true)
    } finally {
      await deleteAgentAs(token, agent.id)
    }
  })

  test('legacy memory migrates through UI preview and commit with verbatim coverage', async ({
    page,
  }) => {
    const token = await getAdminToken()
    const agent = await createMemoryAgent(token, 'migration')
    const legacy = `# Legacy Agent Memory

## Delivery workflow

- Preserve the first exact legacy block.
- Preserve the second exact legacy block.

## Recovery boundary

- Preserve the third exact legacy block.`

    try {
      await memoryData(token, agent.id, '/files/MEMORY.md', {
        method: 'PUT',
        body: JSON.stringify({ content: legacy }),
      })
      expect((await listTopics(token, agent.id)).mode).toBe('legacy_single_file')

      await page.goto(`/agents/${agent.id}?tab=memory`)
      await expect(page.getByTestId('memory-topic-directory')).toBeVisible({ timeout: 10_000 })
      await expect(page.getByText(/旧版单文件记忆|Legacy single-file memory/)).toBeVisible()
      await page.getByRole('button', { name: /预览主题化|Preview Topicization/ }).click()
      await expect(page.getByText(/覆盖：3 \/ 3 个源块，共 2 个主题|Coverage: 3 \/ 3/)).toBeVisible(
        {
          timeout: 15_000,
        },
      )
      await page.getByRole('button', { name: /提交主题化|Commit Topicization/ }).click()

      await expect(page.getByText('Delivery workflow').first()).toBeVisible({ timeout: 15_000 })
      await expect
        .poll(async () => (await listTopics(token, agent.id)).mode, {
          timeout: 15_000,
          intervals: [200, 400, 800, 1200],
        })
        .toBe('topic_v2')
      const migrated = await listTopics(token, agent.id)
      expect(migrated.topics).toHaveLength(2)

      const bodies = await Promise.all(
        migrated.topics.map((topic) =>
          memoryData<TopicMetadata & { content: string }>(
            token,
            agent.id,
            `/topics/${topic.topicId}`,
          ),
        ),
      )
      const combined = bodies.map((topic) => topic.content).join('\n')
      expect(combined).toContain('- Preserve the first exact legacy block.')
      expect(combined).toContain('- Preserve the second exact legacy block.')
      expect(combined).toContain('- Preserve the third exact legacy block.')

      const main = await memoryData<{ content: string }>(token, agent.id, '/files/MEMORY.md')
      expect(main.content).toContain('## Topic Catalog')
      expect(main.content).not.toContain('Preserve the first exact legacy block.')
      const files = await memoryData<Array<{ name: string }>>(token, agent.id, '')
      expect(files.some((file) => file.name.includes('migration-backups'))).toBe(false)
    } finally {
      await deleteAgentAs(token, agent.id)
    }
  })
})
