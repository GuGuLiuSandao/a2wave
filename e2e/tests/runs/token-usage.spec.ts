import { expect, test } from '@playwright/test'
import {
  createAgentWithPayload,
  deleteAgentAs,
  executeAgentChat,
  getAdminToken,
  getRunDetail,
  listProviders,
} from '../../utils/api-helpers'
import { loginAsAdmin } from '../../utils/auth'
import { ROUTES } from '../../utils/test-constants'

test.beforeEach(async ({ page }) => {
  await loginAsAdmin(page)
})

test('persists and displays token usage from a Codex execution', async ({ page }) => {
  const token = await getAdminToken()
  const providers = await listProviders(token)
  const provider = providers.find((candidate) => candidate.name === 'Codex CLI')
  expect(provider, 'Codex CLI provider fixture').toBeTruthy()

  const suffix = Date.now()
  const agent = await createAgentWithPayload(token, {
    name: `e2e-token-usage-${suffix}`,
    type: 'cursor',
    providerId: provider?.id,
    authMode: 'localSession',
    config: {
      engineType: 'codex',
      model: 'gpt-5.3-codex',
      timeoutMinutes: 1,
      maxRetries: 0,
      readOnly: true,
    },
  })

  try {
    const execution = await executeAgentChat(token, agent.id, `token usage ${suffix}`)
    const run = await getRunDetail(token, execution.runId)

    expect(run).toMatchObject({ inputTokens: 10, outputTokens: 5 })
    expect(run.steps.at(-1)?.output?.usage).toEqual({ inputTokens: 10, outputTokens: 5 })

    await page.goto(`${ROUTES.runs}?runId=${execution.runId}`)
    const drawer = page.locator('.ant-drawer-open')
    await expect(drawer).toBeVisible({ timeout: 5000 })
    await expect(drawer.getByText('Token 消耗: 输入 10 · 输出 5')).toBeVisible()

    // Scope to the Token 消耗 card: the overview mounts five identically-marked
    // stat tiles, so a page-wide `getByText('15')` is a strict-mode violation the
    // moment another tile (run count, today's runs, …) also reads 15.
    await page.goto(`/agents/${agent.id}?tab=overview`)
    const tokenCard = page
      .locator('div')
      .filter({ has: page.getByText('Token 消耗', { exact: true }) })
      .filter({ hasText: '输入 10 / 输出 5' })
      .last()
    await expect(tokenCard).toBeVisible({ timeout: 5000 })
    await expect(tokenCard.getByText('15', { exact: true })).toBeVisible()

    await page.goto(ROUTES.dashboard)
    await expect(page.getByText('今日 Token')).toBeVisible()
    const leaderboardEntry = page.getByRole('link', { name: `${agent.name} 15` })
    await expect(leaderboardEntry).toContainText('15', { timeout: 5000 })
  } finally {
    await deleteAgentAs(token, agent.id)
  }
})
