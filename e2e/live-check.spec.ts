import { expect, test } from '@playwright/test'
import { loginAsAdmin } from './utils/auth'
import { ROUTES } from './utils/test-constants'

test('check ask mode switch on agent create page with Cursor CLI', async ({ page }) => {
  await loginAsAdmin(page)
  await page.goto(ROUTES.agents)
  await page.evaluate(() => {
    localStorage.removeItem('draft:agent-create')
    localStorage.removeItem('draft:agent-create-blank')
  })

  await page.getByRole('button', { name: '新建 Agent' }).click()
  const dialog = page.locator('.ant-modal')
  await expect(dialog.getByText('空白创建')).toBeVisible()
  await dialog.getByText('空白创建').click()
  await page.waitForURL('**/agents/new')

  const providerSelect = page.locator('.ant-select').first()
  await expect(providerSelect).toBeVisible()
  await providerSelect.click()

  const cursorOption = page.locator('.ant-select-item-option').filter({ hasText: 'Cursor CLI' })
  await expect(cursorOption.first()).toBeVisible()
  await cursorOption.first().click()

  await expect(page.getByRole('switch', { name: '询问模式（只读）' })).toHaveAttribute(
    'aria-checked',
    'false',
  )
})
