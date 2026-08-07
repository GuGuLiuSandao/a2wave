import { expect, test } from '@playwright/test'
import { createAgent, deleteAgentAs, getAdminToken } from '../../utils/api-helpers'
import { loginAsAdmin } from '../../utils/auth'
import { AGENT_ROUTES } from '../../utils/test-constants'

let token: string
let agentId: string

test.beforeAll(async () => {
  token = await getAdminToken()
  const agent = await createAgent(token, `E2E Schedule Test Agent ${Date.now()}`)
  agentId = agent.id
})

test.afterAll(async () => {
  if (token && agentId) await deleteAgentAs(token, agentId)
})

test.beforeEach(async ({ page }) => {
  await loginAsAdmin(page)
})

/**
 * Opens the schedule channel's config dialog.
 *
 * Publish is a channel card grid now, so this deep-links via `?publishTab=`
 * (which auto-opens the dialog) rather than clicking a sub-tab. The old
 * `.ant-switch').last()` positional lookups are gone too — the grid mounts all
 * eight channel switches at once, so selectors have to be named and scoped.
 */
async function openScheduleConfig(page: import('@playwright/test').Page) {
  await page.goto(AGENT_ROUTES.publishTab(agentId, 'schedule'))
  await expect(page.getByRole('dialog')).toBeVisible({ timeout: 10000 })
}

/** The enable switch lives on the card, not in the dialog. */
function scheduleCardSwitch(page: import('@playwright/test').Page) {
  return page.getByTestId('channel-card-schedule').getByRole('switch', { name: '启用定时触发' })
}

test.describe('Schedule trigger channel', () => {
  test('the card exposes a named enable switch', async ({ page }) => {
    await openScheduleConfig(page)
    await page.getByRole('button', { name: '取消' }).click()

    await expect(scheduleCardSwitch(page)).toBeVisible()
  })

  test('config dialog shows the mode switcher and intent field', async ({ page }) => {
    await openScheduleConfig(page)

    // The form renders regardless of the enable state — configuring a channel
    // before switching it on is the normal order now.
    const dialog = page.getByRole('dialog')
    await expect(dialog.getByText('配置方式')).toBeVisible()
    await expect(dialog.getByText('便捷模式')).toBeVisible()
    await expect(dialog.getByText('高级模式')).toBeVisible()
    // 「触发意图」也出现在计划列表条目和模板变量示例里，用 label 精确定位输入项。
    await expect(dialog.getByText('触发意图*')).toBeVisible()
  })

  test('preset mode shows daily/weekly/monthly radio buttons', async ({ page }) => {
    await openScheduleConfig(page)

    const dialog = page.getByRole('dialog')
    await expect(dialog.getByText('便捷模式')).toBeVisible()
    // 频率是 antd Segmented：其 <input type="radio"> 视觉隐藏，断言可见的标签。
    for (const label of ['每天', '每周', '每月']) {
      await expect(dialog.locator('.ant-segmented-item-label', { hasText: label })).toBeVisible()
    }
  })

  test('selecting weekly preset shows weekday selector', async ({ page }) => {
    await openScheduleConfig(page)

    const dialog = page.getByRole('dialog')
    await dialog.locator('.ant-segmented-item-label', { hasText: '每周' }).click()
    await expect(dialog.getByText('星期')).toBeVisible()
  })

  test('selecting monthly preset shows day selector', async ({ page }) => {
    await openScheduleConfig(page)

    const dialog = page.getByRole('dialog')
    await dialog.locator('.ant-segmented-item-label', { hasText: '每月' }).click()
    // exact: 「日期」也出现在其它说明文案里，只取该字段自己的标签。
    await expect(dialog.getByText('日期', { exact: true })).toBeVisible()
  })

  test('switching to advanced mode shows cron input', async ({ page }) => {
    await openScheduleConfig(page)

    await page.getByText('高级模式').click()
    await expect(page.getByPlaceholder(/0 9 \* \* \*/)).toBeVisible()
  })

  test('active cron preview is displayed', async ({ page }) => {
    await openScheduleConfig(page)

    await expect(page.getByText('当前生效:')).toBeVisible()
  })

  test('template variable help card is visible', async ({ page }) => {
    await openScheduleConfig(page)

    await expect(page.getByText('可用模板变量')).toBeVisible()
    await expect(page.locator('code').filter({ hasText: '{{date}}' })).toBeVisible()
    await expect(page.locator('code').filter({ hasText: '{{time}}' })).toBeVisible()
    await expect(page.locator('code').filter({ hasText: '{{iso}}' })).toBeVisible()
  })

  test('run-as-owner gateway toggle renders with a bind hint when the owner is unbound', async ({
    page,
  }) => {
    await openScheduleConfig(page)

    await expect(page.getByText('以当前登录身份运行')).toBeVisible()

    // The e2e admin is a local password account (no bound IDaaS identity). The toggle
    // is intentionally NOT hard-disabled (that caused cross-tab/async grey-out bugs);
    // it just surfaces a bind hint. Backend enforces the real gate at trigger time.
    await expect(page.getByText('你尚未绑定企业身份，无法以你的身份运行。')).toBeVisible()
  })

  test('an unconfigured schedule cannot be enabled from the card', async ({ page }) => {
    await openScheduleConfig(page)
    await page.getByRole('button', { name: '取消' }).click()

    // Replaces the old "publish shows an error" assertion: an empty intent means
    // the channel is not ready, so the switch is disabled and the user can never
    // reach the state the publish route would reject.
    await expect(scheduleCardSwitch(page)).toBeDisabled()
  })
})
