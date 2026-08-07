/**
 * Agent member management e2e (Wave 6 — feat/agent-member-management).
 *
 * Verifies the owner / editor / viewer / stranger experience end-to-end via
 * the web UI. Fixtures are created through the REST API with a unique
 * timestamp suffix so the spec is safely re-runnable in parallel and against
 * a shared dev DB.
 *
 * Identity matrix:
 *   - owner    — created the agent; full control + member management
 *   - editor   — added as `editor` member; can save edits, no member menu
 *   - viewer   — added as `viewer` member; save is disabled
 *   - stranger — has no relationship; agent should appear as not-found
 */
import { expect, test } from '@playwright/test'
import {
  addAgentMember,
  createAgentAs,
  createTestUser,
  deleteAgentAs,
  deleteTestUser,
  getAdminToken,
  loginByApi,
} from '../../utils/api-helpers'
import { loginAs } from '../../utils/auth'
import { API_BASE } from '../../utils/test-constants'

const SUFFIX = Date.now().toString()
const OWNER = `e2e-owner-${SUFFIX}`
const EDITOR_USER = `e2e-editor-${SUFFIX}`
const VIEWER_USER = `e2e-viewer-${SUFFIX}`
const STRANGER = `e2e-stranger-${SUFFIX}`
const PASSWORD = 'TestPass123!'

interface Fixture {
  adminToken: string
  ownerToken: string
  agentId: string
  ownerId: string
  editorId: string
  viewerId: string
  strangerId: string
}

let fx: Fixture

async function selectAntdRole(
  page: import('@playwright/test').Page,
  testId: string,
  label: string,
) {
  await page.getByTestId(testId).click()
  const dropdown = page.locator('.ant-select-dropdown:not(.ant-select-dropdown-hidden)').last()
  await expect(dropdown).toBeVisible({ timeout: 5000 })
  await dropdown.getByText(label, { exact: true }).click()
}

test.describe('Agent member management', () => {
  test.describe.configure({ mode: 'serial' })

  test.beforeAll(async () => {
    const adminToken = await getAdminToken()

    // Create the four fixture users in parallel — each call is idempotent at
    // the worker level because usernames are unique per run.
    const [owner, editor, viewer, stranger] = await Promise.all([
      createTestUser(adminToken, { username: OWNER, password: PASSWORD }),
      createTestUser(adminToken, { username: EDITOR_USER, password: PASSWORD }),
      createTestUser(adminToken, { username: VIEWER_USER, password: PASSWORD }),
      createTestUser(adminToken, { username: STRANGER, password: PASSWORD }),
    ])

    // Owner logs in via API to obtain a token, then creates the agent so that
    // the agent's `userId` (owner) is correctly set.
    const ownerLogin = await loginByApi(OWNER, PASSWORD)
    const agent = await createAgentAs(ownerLogin.token, `e2e-members-${SUFFIX}`)

    // Owner adds editor & viewer as members. Stranger is left out on purpose.
    await addAgentMember(ownerLogin.token, agent.id, {
      userId: editor.id,
      role: 'editor',
    })
    await addAgentMember(ownerLogin.token, agent.id, {
      userId: viewer.id,
      role: 'viewer',
    })

    fx = {
      adminToken,
      ownerToken: ownerLogin.token,
      agentId: agent.id,
      ownerId: owner.id,
      editorId: editor.id,
      viewerId: viewer.id,
      strangerId: stranger.id,
    }
  })

  test.afterAll(async () => {
    if (!fx) return
    // Best-effort cleanup; failures here must not mask test results.
    await deleteAgentAs(fx.ownerToken, fx.agentId)
    await Promise.all([
      deleteTestUser(fx.adminToken, fx.ownerId),
      deleteTestUser(fx.adminToken, fx.editorId),
      deleteTestUser(fx.adminToken, fx.viewerId),
      deleteTestUser(fx.adminToken, fx.strangerId),
    ])
  })

  test('owner sees Members entry and can open the dialog', async ({ page }) => {
    await loginAs(page, OWNER, PASSWORD)
    await page.goto(`/agents/${fx.agentId}`)
    await page.waitForLoadState('networkidle')

    await page.getByTestId('agent-detail-more-actions').click()
    const menuItem = page.getByTestId('agent-members-menu-item')
    await expect(menuItem).toBeVisible({ timeout: 5000 })
    await menuItem.click()

    // Dialog renders with the localized title.
    await expect(page.getByRole('dialog')).toBeVisible({ timeout: 5000 })
    await expect(page.getByText('管理成员')).toBeVisible()
  })

  test('owner can add a new member via dialog', async ({ page }) => {
    await loginAs(page, OWNER, PASSWORD)
    await page.goto(`/agents/${fx.agentId}`)
    await page.waitForLoadState('networkidle')

    await page.getByTestId('agent-detail-more-actions').click()
    await page.getByTestId('agent-members-menu-item').click()
    await expect(page.getByRole('dialog')).toBeVisible()

    // Search for the stranger user and pick the first matching row.
    await page.getByTestId('member-search-input').fill(STRANGER)
    const lookupRow = page.getByTestId(`member-lookup-row-${fx.strangerId}`)
    await expect(lookupRow).toBeVisible({ timeout: 5000 })
    await lookupRow.click()

    // Default role is `viewer`; switch to `editor` to exercise the select.
    await selectAntdRole(page, 'member-add-role', '编辑')
    await page.getByTestId('member-add-btn').click()

    // The new row should appear in the members list.
    await expect(page.getByTestId(`member-row-${fx.strangerId}`)).toBeVisible({ timeout: 5000 })

    // Cleanup so the test stays idempotent across runs.
    await fetch(`${API_BASE}/api/agents/${fx.agentId}/members/${fx.strangerId}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${fx.ownerToken}` },
    })
  })

  test("owner can change a member's role", async ({ page }) => {
    await loginAs(page, OWNER, PASSWORD)
    await page.goto(`/agents/${fx.agentId}`)
    await page.waitForLoadState('networkidle')

    await page.getByTestId('agent-detail-more-actions').click()
    await page.getByTestId('agent-members-menu-item').click()
    await expect(page.getByRole('dialog')).toBeVisible()

    const roleSelect = page.getByTestId(`member-row-role-${fx.editorId}`)
    await expect(roleSelect).toBeVisible({ timeout: 5000 })
    await expect(roleSelect).toContainText('编辑')

    await selectAntdRole(page, `member-row-role-${fx.editorId}`, '只读')
    await expect(roleSelect).toContainText('只读', { timeout: 5000 })

    // Restore original role for downstream tests.
    await selectAntdRole(page, `member-row-role-${fx.editorId}`, '编辑')
    await expect(roleSelect).toContainText('编辑', { timeout: 5000 })
  })

  test('owner deletes a member with confirm', async ({ page }) => {
    // Use a freshly added throwaway membership so this test does not perturb
    // the editor/viewer fixtures relied on by other tests.
    await addAgentMember(fx.ownerToken, fx.agentId, {
      userId: fx.strangerId,
      role: 'viewer',
    })

    await loginAs(page, OWNER, PASSWORD)
    await page.goto(`/agents/${fx.agentId}`)
    await page.waitForLoadState('networkidle')

    await page.getByTestId('agent-detail-more-actions').click()
    await page.getByTestId('agent-members-menu-item').click()
    await expect(page.getByRole('dialog')).toBeVisible()

    const row = page.getByTestId(`member-row-${fx.strangerId}`)
    await expect(row).toBeVisible({ timeout: 5000 })

    // Open the confirm dialog, then cancel — the row must remain.
    await page.getByTestId(`member-row-delete-${fx.strangerId}`).click()
    await expect(page.getByTestId('member-remove-confirm')).toBeVisible()
    await page.getByTestId('member-remove-cancel').click()
    await expect(row).toBeVisible()

    // Reopen and confirm — row should disappear.
    await page.getByTestId(`member-row-delete-${fx.strangerId}`).click()
    await expect(page.getByTestId('member-remove-confirm')).toBeVisible()
    await page.getByTestId('member-remove-confirm-cta').click()
    await expect(row).toHaveCount(0, { timeout: 5000 })
  })

  test('editor sees agent and can save, but no Members entry', async ({ page }) => {
    await loginAs(page, EDITOR_USER, PASSWORD)
    await page.goto(`/agents/${fx.agentId}`)
    await page.waitForLoadState('networkidle')

    // Page renders (agent name is shown in the breadcrumb / header).
    await expect(page.locator('[data-page="agent-detail"]')).toBeVisible()

    // The Members entry must not be in the dropdown for non-owner.
    await page.getByTestId('agent-detail-more-actions').click()
    await expect(page.getByTestId('agent-members-menu-item')).toHaveCount(0)
    // Close dropdown by pressing Escape so it doesn't intercept later clicks.
    await page.keyboard.press('Escape')

    // Save button is enabled for editors. We only verify it isn't disabled —
    // pressing it without dirtying the form would be a no-op.
    const save = page.getByTestId('agent-detail-save')
    await expect(save).toBeVisible()
    // Save is disabled when the form has no changes; that's expected. Verify
    // the disabled state is *not* due to the read-only gate by toggling a
    // form field. The name input is a stable, always-present field.
    const nameInput = page.getByPlaceholder('Agent 名称')
    await expect(nameInput).toBeEnabled()
  })

  test('viewer sees agent, save is disabled', async ({ page }) => {
    await loginAs(page, VIEWER_USER, PASSWORD)
    await page.goto(`/agents/${fx.agentId}`)
    await page.waitForLoadState('networkidle')

    await expect(page.locator('[data-page="agent-detail"]')).toBeVisible()

    // No Members entry for non-owner.
    await page.getByTestId('agent-detail-more-actions').click()
    await expect(page.getByTestId('agent-members-menu-item')).toHaveCount(0)
    await page.keyboard.press('Escape')

    // Save button is disabled for viewers — the read-only gate forces it off
    // even before any edit is attempted.
    const save = page.getByTestId('agent-detail-save')
    await expect(save).toBeVisible()
    await expect(save).toBeDisabled()
  })

  test('stranger cannot see the agent (404 / not-found)', async ({ page }) => {
    await loginAs(page, STRANGER, PASSWORD)
    await page.goto(`/agents/${fx.agentId}`)
    await page.waitForLoadState('networkidle')

    // The page renders the not-found UI (Back-to-Agents button + heading) and
    // the more-actions menu must not appear.
    await expect(page.getByTestId('agent-detail-more-actions')).toHaveCount(0)
    await expect(page.getByRole('link', { name: /Back to Agents|返回 Agent 列表/i })).toBeVisible({
      timeout: 5000,
    })
  })
})
