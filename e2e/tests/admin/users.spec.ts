import { expect, test } from '@playwright/test'
import { getAdminToken } from '../../utils/api-helpers'
import { loginAsAdmin } from '../../utils/auth'
import { API_BASE, ROUTES } from '../../utils/test-constants'

test.beforeEach(async ({ page }) => {
  await loginAsAdmin(page)
})

test.describe('Admin: users page', () => {
  test('page renders with title and add button', async ({ page }) => {
    await page.goto(ROUTES.users)

    await expect(page.getByRole('heading', { name: '用户管理' })).toBeVisible()
    await expect(page.getByRole('button', { name: '添加用户' })).toBeVisible()
  })

  test('users table shows existing users with correct columns', async ({ page }) => {
    await page.goto(ROUTES.users)

    const table = page.locator('.ant-table')
    await expect(table).toBeVisible()

    // Verify column headers
    await expect(table.getByRole('columnheader', { name: '用户名' })).toBeVisible()
    await expect(table.getByRole('columnheader', { name: '显示名称' })).toBeVisible()
    await expect(table.getByRole('columnheader', { name: '角色' })).toBeVisible()
    await expect(table.getByRole('columnheader', { name: '状态' })).toBeVisible()
    await expect(table.getByRole('columnheader', { name: '创建时间' })).toBeVisible()
    await expect(table.getByRole('columnheader', { name: '操作' })).toBeVisible()

    // 表格至少渲染一行；admin 用户的存在性通过 API 验证（避免累积 e2e 用户把 admin
    // 翻到下页造成断言失败）
    await expect(table.locator('tbody tr').first()).toBeVisible()

    const token = await getAdminToken()
    let foundAdmin = false
    for (let p = 1; p <= 20 && !foundAdmin; p++) {
      const res = await fetch(`${API_BASE}/api/users?page=${p}&pageSize=100`, {
        headers: { Authorization: `Bearer ${token}` },
      })
      expect(res.ok).toBe(true)
      const body = (await res.json()) as {
        data: Array<{ username: string }>
        pagination: { totalPages: number }
      }
      if (body.data.some((u) => u.username === 'admin')) foundAdmin = true
      if (p >= body.pagination.totalPages) break
    }
    expect(foundAdmin).toBe(true)
  })

  test('add user flow', async ({ page }) => {
    await page.goto(ROUTES.users)

    await page.getByRole('button', { name: '添加用户' }).click()

    // Dialog should appear
    const dialog = page.locator('[role="dialog"]')
    await expect(dialog.getByRole('heading', { name: '添加用户' })).toBeVisible()

    // Fill form
    const testUsername = `e2euser_${Date.now()}`
    await dialog.getByPlaceholder('输入用户名').fill(testUsername)
    await dialog.getByPlaceholder('输入显示名称').fill('E2E Test User')
    await dialog.getByPlaceholder('输入密码').fill('TestPass1')

    // Submit
    const submitBtn = dialog.getByRole('button', { name: '添加用户' })
    await expect(submitBtn).toBeEnabled()
    await submitBtn.click()

    // User should appear in table
    await expect(page.locator('.ant-table').getByText(testUsername)).toBeVisible({ timeout: 5000 })

    // Cleanup: delete the test user
    const row = page.locator('.ant-table-row', { hasText: testUsername })
    await row.getByRole('button', { name: '删除' }).click()
    // Confirm deletion in antd Modal.confirm — locate via the primary/danger OK button
    const confirmModal = page.locator('.ant-modal').filter({ hasText: '删除用户' })
    await confirmModal.locator('button.ant-btn-primary').click()
    await expect(page.locator('.ant-table').getByText(testUsername)).toBeHidden({ timeout: 5000 })
  })

  test('delete user flow', async ({ page }) => {
    await page.goto(ROUTES.users)

    // First create a user to delete
    await page.getByRole('button', { name: '添加用户' }).click()
    const dialog = page.locator('[role="dialog"]')
    const testUsername = `del_${Date.now()}`
    await dialog.getByPlaceholder('输入用户名').fill(testUsername)
    await dialog.getByPlaceholder('输入密码').fill('TestPass1')
    await dialog.getByRole('button', { name: '添加用户' }).click()
    await expect(page.locator('.ant-table').getByText(testUsername)).toBeVisible({ timeout: 5000 })

    // Delete the user
    const row = page.locator('.ant-table-row', { hasText: testUsername })
    await row.getByRole('button', { name: '删除' }).click()

    // Confirm in antd Modal.confirm
    const confirmModal = page.locator('.ant-modal').filter({ hasText: '删除用户' })
    await expect(confirmModal).toBeVisible()
    await confirmModal.locator('button.ant-btn-primary').click()

    // User should disappear
    await expect(page.locator('.ant-table').getByText(testUsername)).toBeHidden({ timeout: 5000 })
  })

  test('reset password dialog renders', async ({ page }) => {
    await page.goto(ROUTES.users)

    // Find the first reset password button in the table
    const resetBtn = page.locator('.ant-table').getByRole('button', { name: '重置密码' }).first()
    await resetBtn.click()

    // Dialog should appear — use heading role to avoid matching the button text
    const dialog = page.locator('[role="dialog"]')
    await expect(dialog.getByRole('heading', { name: '重置密码' })).toBeVisible()
    await expect(dialog.getByPlaceholder('输入新密码')).toBeVisible()
    await expect(dialog.getByRole('button', { name: '重置密码' })).toBeVisible()
  })
})
