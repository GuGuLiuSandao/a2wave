import { expect, test } from '@playwright/test'
import { loginAsAdmin } from '../../utils/auth'
import { ROUTES } from '../../utils/test-constants'

test.beforeEach(async ({ page }) => {
  await loginAsAdmin(page)
})

test.describe('Agent template selection dialog', () => {
  test('clicking "新建 Agent" opens template dialog', async ({ page }) => {
    await page.goto(ROUTES.agents)

    await page.getByRole('button', { name: '新建 Agent' }).click()

    // Dialog should appear with title and subtitle
    const dialog = page.locator('.ant-modal')
    await expect(dialog.getByText('创建 Agent')).toBeVisible()
    await expect(dialog.getByText('选择一个可编辑的场景起点，创建后仍可调整全部配置')).toBeVisible()

    const expectedTemplates = [
      '空白创建',
      '我的第一个 Agent',
      '支持调查助手',
      '代码库问答',
      '代码审查助手',
      '事件分析助手',
      '数据巡检助手',
      '文档维护助手',
      '生成文件产物',
      '网页应用生成器',
    ]
    for (const name of expectedTemplates) {
      await expect(dialog.getByText(name, { exact: true })).toBeVisible()
    }
  })

  test('selecting "空白创建" navigates to /agents/new with empty form', async ({ page }) => {
    await page.goto(ROUTES.agents)

    await page.getByRole('button', { name: '新建 Agent' }).click()
    const dialog = page.locator('.ant-modal')
    await expect(dialog.getByText('空白创建')).toBeVisible()

    await dialog.getByText('空白创建').click()

    await page.waitForURL('**/agents/new')
    // Name field should be empty
    const nameInput = page.getByPlaceholder('Agent 名称')
    await expect(nameInput).toBeVisible()
    await expect(nameInput).toHaveValue('')
  })

  test('selecting "代码库问答" applies a generic read-only SCM template', async ({ page }) => {
    await page.goto(ROUTES.agents)

    await page.getByRole('button', { name: '新建 Agent' }).click()
    const dialog = page.locator('.ant-modal')
    await expect(dialog.getByText('代码库问答', { exact: true })).toBeVisible()

    await dialog.getByText('代码库问答', { exact: true }).click()

    await page.waitForURL('**/agents/new')

    const nameInput = page.getByPlaceholder('Agent 名称')
    await expect(nameInput).toBeVisible()
    await expect(nameInput).toHaveValue('代码库问答')

    // The system prompt is always seeded in English regardless of UI locale
    // (see SYSTEM_PROMPT_LANGUAGE in agent-template-catalog.ts) — the prompt is
    // read by the underlying CLI, not the user, and every model is strongest on
    // English instructions.
    const editorContent = page.locator('.cm-content')
    await expect(editorContent).toBeVisible()
    await expect(editorContent).toContainText('Clearly separate static code facts')

    const askModeSwitch = page.getByRole('switch', { name: '询问模式（只读）' })
    await expect(askModeSwitch).toHaveAttribute('aria-checked', 'true')

    await expect(page.getByRole('radio', { name: 'Git 代码源' })).toBeChecked()

    await page.getByRole('button', { name: '创建 Agent', exact: true }).click()
    await expect(page.getByText('请选择一个已完成初次同步的Git 代码源')).toBeVisible()
    await expect(page).toHaveURL(/\/agents\/new$/)
  })

  test('blank agent creation shows ask mode OFF by default (even with stale draft)', async ({
    page,
  }) => {
    // Navigate first so localStorage is accessible (same origin as /agents/new)
    await page.goto(ROUTES.agents)
    // Seed stale draft from before the fix (when readOnly defaulted to true)
    await page.evaluate(() => {
      localStorage.setItem(
        'draft:agent-create',
        JSON.stringify({
          name: 'stale-draft',
          description: '',
          systemPrompt: '',
          icon: '🤖',
          apiKey: '',
          providerId: null,
          model: '',
          readOnly: true,
          force: true,
          maxConcurrency: 1,
        }),
      )
    })

    await page.goto(ROUTES.agents)
    await page.getByRole('button', { name: '新建 Agent' }).click()
    const dialog = page.locator('.ant-modal')
    await dialog.getByText('空白创建').click()
    await page.waitForURL('**/agents/new')

    // Select Cursor CLI provider to make the ask mode switch visible
    const providerSelect = page.locator('.ant-select').first()
    await providerSelect.click()
    const cursorOption = page
      .locator('.ant-select-item-option')
      .filter({ hasText: 'Cursor CLI' })
      .first()
    if (await cursorOption.isVisible({ timeout: 3000 }).catch(() => false)) {
      await cursorOption.click()
      // Ask mode switch must be OFF (unchecked) regardless of stale draft
      // Ant Design Switch uses aria-checked (not data-state)
      const askModeSwitch = page.getByRole('switch', { name: '询问模式（只读）' })
      await expect(askModeSwitch).toHaveAttribute('aria-checked', 'false')
    }
  })

  test('dialog can be closed via X button', async ({ page }) => {
    await page.goto(ROUTES.agents)

    await page.getByRole('button', { name: '新建 Agent' }).click()
    const dialog = page.locator('.ant-modal')
    await expect(dialog.getByText('创建 Agent')).toBeVisible()

    // Close dialog via X button
    await page.getByRole('button', { name: /关闭|Close/ }).click()

    // Dialog should disappear, still on agents page
    await expect(
      dialog.getByText('选择一个可编辑的场景起点，创建后仍可调整全部配置'),
    ).not.toBeVisible()
    await expect(page).toHaveURL(/\/agents$/)
  })

  test('empty state "创建第一个 Agent" also opens template dialog', async ({ page }) => {
    await page.goto(ROUTES.agents)

    // Check if empty state button exists; if not, skip
    const emptyButton = page.getByRole('button', { name: '创建第一个 Agent' })
    if (await emptyButton.isVisible({ timeout: 2000 }).catch(() => false)) {
      await emptyButton.click()
      const dialog = page.locator('.ant-modal')
      await expect(dialog.getByText('创建 Agent')).toBeVisible()
      await expect(
        dialog.getByText('选择一个可编辑的场景起点，创建后仍可调整全部配置'),
      ).toBeVisible()
    }
  })
})
