import { expect, test } from '@playwright/test'
import { createAgent, deleteAgentAs, getAdminToken } from '../../utils/api-helpers'
import { loginAsAdmin } from '../../utils/auth'
import { AGENT_ROUTES } from '../../utils/test-constants'

let token: string
let agentId: string

test.beforeAll(async () => {
  token = await getAdminToken()
  const agent = await createAgent(token, `E2E A2A Route Agent ${Date.now()}`)
  agentId = agent.id
})

test.afterAll(async () => {
  if (token && agentId) await deleteAgentAs(token, agentId)
})

test.beforeEach(async ({ page }) => {
  await loginAsAdmin(page)
})

test('explains Direct-mode streaming limits and switches to Agent Card discovery', async ({
  page,
}) => {
  await page.goto(AGENT_ROUTES.detail(agentId))
  await expect(page.locator('[data-page="agent-detail"]')).toBeVisible({ timeout: 10_000 })

  await page.getByTestId('route-configure').click()
  const dialog = page.getByRole('dialog')

  await dialog
    .getByText(/Agent Card 发现|Agent Card discovery/, { exact: true })
    .last()
    .click()
  await page
    .getByText(/直连端点|Direct endpoint/, { exact: true })
    .last()
    .click()

  await expect(dialog.getByTitle(/直连端点|Direct endpoint/).last()).toBeVisible()
  await expect(dialog.getByText('A2A 1.0', { exact: true })).toBeVisible()
  await expect(
    dialog.getByText(/固定使用阻塞式 SendMessage|use blocking SendMessage/),
  ).toBeVisible()

  await dialog
    .getByTitle(/直连端点|Direct endpoint/)
    .last()
    .click()
  await page
    .getByText(/Agent Card 发现|Agent Card discovery/, { exact: true })
    .last()
    .click()

  await expect(dialog.getByPlaceholder(/\.well-known\/agent-card\.json/)).toBeVisible()
  await expect(dialog.getByText(/固定使用阻塞式 SendMessage|use blocking SendMessage/)).toHaveCount(
    0,
  )
})
