import { expect, test } from '@playwright/test'
import { createAgent, deleteAgentAs, getAdminToken } from '../../utils/api-helpers'
import { loginAsAdmin } from '../../utils/auth'
import { AGENT_ROUTES, TEST_IDS } from '../../utils/test-constants'

let token: string
let agentId: string

// Own the agent under test instead of borrowing the first one on /agents:
// the suite runs fullyParallel, so a peer spec can delete that shared agent
// between navigation and the diagnose request, which 404s and leaves the modal
// on its error branch with no copy button.
test.beforeAll(async () => {
  token = await getAdminToken()
  const agent = await createAgent(token, `E2E Diagnose Test Agent ${Date.now()}`)
  agentId = agent.id
})

test.afterAll(async () => {
  if (token && agentId) await deleteAgentAs(token, agentId)
})

test.beforeEach(async ({ page }) => {
  await loginAsAdmin(page)
})

test.describe('Agent diagnose', () => {
  test('opens diagnose modal from header more menu', async ({ page }) => {
    await page.goto(AGENT_ROUTES.detail(agentId))

    await page.getByTestId(TEST_IDS.agentDetailMoreActions).click()
    await page.getByTestId(TEST_IDS.agentDiagnoseMenuItem).click()

    await expect(page.getByTestId(TEST_IDS.agentDiagnoseModal)).toBeVisible({ timeout: 8000 })
    await expect(page.getByTestId(TEST_IDS.agentDiagnoseTitle)).toBeVisible({ timeout: 8000 })
    await expect(page.getByTestId(TEST_IDS.agentDiagnoseCopy)).toBeVisible({ timeout: 8000 })
  })
})
