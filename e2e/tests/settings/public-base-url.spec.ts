/**
 * E2E tests for Public Base URL setting (运行产物).
 *
 * 用例：进入设置页 → 运行产物 → 填写 publicBaseUrl → 保存 → 刷新后值仍存在。
 * 测试结束后恢复原配置，避免污染开发/生产环境。
 */
import { expect, test } from '@playwright/test'
import { getAdminToken, updateArtifactsPublicBaseUrl } from '../../utils/api-helpers'
import { loginAsAdmin } from '../../utils/auth'
import { API_BASE, ROUTES } from '../../utils/test-constants'

const TEST_BASE_URL = 'https://e2e-test.example.com'

test.describe('Settings — Public Base URL (运行产物)', () => {
  let originalPublicBaseUrl: string

  test.beforeEach(async ({ page }) => {
    await loginAsAdmin(page)
    const token = await getAdminToken()
    const res = await fetch(`${API_BASE}/api/settings`, {
      headers: { Authorization: `Bearer ${token}` },
    })
    if (res.ok) {
      const body = (await res.json()) as { data: { artifacts?: { publicBaseUrl?: string } } }
      originalPublicBaseUrl = body.data?.artifacts?.publicBaseUrl ?? ''
    } else {
      originalPublicBaseUrl = ''
    }
  })

  test.afterEach(async () => {
    const token = await getAdminToken()
    await updateArtifactsPublicBaseUrl(token, originalPublicBaseUrl)
  })

  test('填写 publicBaseUrl 保存后刷新，值仍存在', async ({ page }) => {
    await page.goto(`${ROUTES.settings}?tab=artifacts`)
    await page.waitForLoadState('networkidle')

    // 运行产物卡片应可见
    await expect(page.getByText('运行产物').first()).toBeVisible({ timeout: 5000 })

    // 定位用户可访问地址输入框（通过 label 或 id）
    const publicBaseUrlInput = page
      .getByRole('textbox', {
        name: /用户可访问地址|User Accessible URL/,
      })
      .or(page.locator('#artifactsPublicBaseUrl'))

    await expect(publicBaseUrlInput.first()).toBeVisible({ timeout: 3000 })

    // 填写值
    await publicBaseUrlInput.first().fill(TEST_BASE_URL)

    // 点击运行产物表单内的保存按钮
    const artifactsForm = page
      .locator('form')
      .filter({ has: page.locator('#artifactsPublicBaseUrl') })
    const saveButton = artifactsForm.getByRole('button', { name: /保存|Save/ })
    await saveButton.click()

    // 等待保存成功（按钮可能显示「已保存」）
    await expect(saveButton).toHaveText(/已保存|Saved/, { timeout: 5000 })

    // 刷新页面
    await page.reload()
    await page.waitForLoadState('networkidle')

    // 验证值仍存在
    const inputAfterReload = page
      .getByRole('textbox', {
        name: /用户可访问地址|User Accessible URL/,
      })
      .or(page.locator('#artifactsPublicBaseUrl'))
    await expect(inputAfterReload.first()).toHaveValue(TEST_BASE_URL)
  })
})
