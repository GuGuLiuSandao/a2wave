import { expect, test } from '@playwright/test'
import { loginAsAdmin } from '../../utils/auth'
import { ROUTES } from '../../utils/test-constants'

test.beforeEach(async ({ page }) => {
  await loginAsAdmin(page)
})

test.describe('Admin: audit logs page', () => {
  test('page renders with title', async ({ page }) => {
    await page.goto(ROUTES.auditLogs)

    await expect(page.getByRole('heading', { name: '审计日志' })).toBeVisible()
  })

  test('table shows audit log entries with correct columns', async ({ page }) => {
    await page.goto(ROUTES.auditLogs)

    const table = page.locator('.ant-table')
    await expect(table).toBeVisible()

    // Verify column headers using columnheader role to avoid matching cell content
    await expect(table.getByRole('columnheader', { name: '时间' })).toBeVisible()
    await expect(table.getByRole('columnheader', { name: '用户' })).toBeVisible()
    await expect(table.getByRole('columnheader', { name: '操作' })).toBeVisible()
    await expect(table.getByRole('columnheader', { name: '资源类型' })).toBeVisible()
    await expect(table.getByRole('columnheader', { name: 'IP 地址' })).toBeVisible()
    await expect(table.getByRole('columnheader', { name: '详情' })).toBeVisible()

    // The resource ID no longer owns a column — it is rendered under the resource
    // type in the same cell, so the id stays auditable without costing the details
    // column the width it needs to render its JSON on one line.
    await expect(table.getByRole('columnheader', { name: '资源 ID' })).toHaveCount(0)
  })

  test('filter selects are visible', async ({ page }) => {
    await page.goto(ROUTES.auditLogs)

    // Action filter
    const actionFilter = page.getByRole('combobox', { name: '操作' })
    await expect(actionFilter).toBeVisible()

    // Date-range filter. The resource-type filter was replaced by a date range
    // (feat(audit): filter by date range instead of resource type); this
    // assertion still looked for the removed `资源类型` combobox.
    const dateRangeFilter = page.getByRole('combobox', { name: '时间范围' })
    await expect(dateRangeFilter).toBeVisible()
  })
})
