import { expect, test } from '@playwright/test'
import { createAgent, deleteAgentAs, getAdminToken } from '../../utils/api-helpers'
import { loginAsAdmin } from '../../utils/auth'

test('Agent configuration exposes the 120 minute run timeout limit', async ({ page }) => {
  await loginAsAdmin(page)
  const token = await getAdminToken()
  const agent = await createAgent(token, `e2e-timeout-limit-${Date.now()}`)

  try {
    await page.goto(`/agents/${agent.id}`)

    await expect(
      page.getByText(/单次执行超时，5–120 分钟|Single run timeout, 5–120 minutes/),
    ).toBeVisible()
    await expect(page.getByTestId('agent-timeout-minutes')).toHaveAttribute('aria-valuemax', '120')
  } finally {
    await deleteAgentAs(token, agent.id)
  }
})
