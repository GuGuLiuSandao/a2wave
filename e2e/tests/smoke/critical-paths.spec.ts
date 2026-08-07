import { expect, test } from '@playwright/test'
import { loginAsAdmin } from '../../utils/auth'
import { ADMIN_NAV_ITEMS, NAV_ITEMS, ROUTES } from '../../utils/test-constants'

test.beforeEach(async ({ page }) => {
  await loginAsAdmin(page)
})

test.describe('Smoke: app loads correctly', () => {
  test('dashboard renders with sidebar and main content', async ({ page }) => {
    await page.goto(ROUTES.dashboard)

    await expect(page.locator('aside h1')).toHaveText('A2WAVE')
    await expect(page.locator('#main-content')).toBeVisible()
    await expect(page.getByRole('heading', { name: '仪表盘' })).toBeVisible()
  })

  test('dashboard shows the three leaderboard cards (runs / users / tokens)', async ({ page }) => {
    await page.goto(ROUTES.dashboard)

    await expect(page.getByText('运行次数排行')).toBeVisible()
    await expect(page.getByText('使用人数排行')).toBeVisible()
    await expect(page.getByText('Token 消耗榜')).toBeVisible()
  })

  test('sidebar contains all navigation links', async ({ page }) => {
    await page.goto(ROUTES.dashboard)

    const sidebar = page.locator('aside')
    for (const item of NAV_ITEMS) {
      await expect(sidebar.getByRole('link', { name: item.name })).toBeVisible()
    }
    for (const item of ADMIN_NAV_ITEMS) {
      await expect(sidebar.getByRole('link', { name: item.name })).toBeVisible()
    }
  })
})

test.describe('Smoke: sidebar navigation works', () => {
  const allNavItems = [...NAV_ITEMS, ...ADMIN_NAV_ITEMS]
  for (const item of allNavItems) {
    test(`navigates to ${item.name}`, async ({ page }) => {
      await page.goto(ROUTES.dashboard)
      await page.locator('aside').getByRole('link', { name: item.name }).click()
      await page.waitForURL(`**${item.path}`)
      await expect(page.locator('#main-content')).toBeVisible()
    })
  }
})

test.describe('Smoke: list pages render', () => {
  const listPages = [
    { route: ROUTES.agents, heading: 'Agents' },
    { route: ROUTES.providers, heading: 'Providers' },
    { route: ROUTES.mcpServers, heading: 'MCP' },
    { route: ROUTES.skills, heading: 'Skills' },
    { route: ROUTES.runs, heading: '运行记录' },
    { route: ROUTES.scmSources, heading: '代码源' },
    { route: ROUTES.settings, heading: '设置' },
  ]

  for (const { route, heading } of listPages) {
    test(`${heading} page loads at ${route}`, async ({ page }) => {
      await page.goto(route)
      await expect(page.locator('#main-content')).toBeVisible()
      await expect(page.getByText(heading).first()).toBeVisible()
    })
  }
})

test.describe('Smoke: changelog page', () => {
  test('changelog page loads at /changelog', async ({ page }) => {
    await page.goto(ROUTES.changelog)
    await expect(page.locator('#main-content')).toBeVisible()
    await expect(page.getByRole('heading', { name: '更新记录' })).toBeVisible()
  })
})

test.describe('Smoke: 404 handling', () => {
  test('shows 404 page for unknown route', async ({ page }) => {
    await page.goto('/this-page-does-not-exist')
    await expect(page.getByText('404')).toBeVisible()
  })
})
