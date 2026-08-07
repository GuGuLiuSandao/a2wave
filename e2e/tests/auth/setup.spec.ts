import { expect, test } from '@playwright/test'
import { ROUTES } from '../../utils/test-constants'

/**
 * First-time setup asks for the admin password and nothing else. There is no
 * bootstrap code to copy out of the container logs — requiring one made every
 * Docker install stop to run `docker compose logs`.
 *
 * The E2E database is deliberately already initialized (globalSetup owns the
 * admin fixture), so these cases mock only the public status probe: the real
 * page renders and nothing mutates or replaces the shared admin.
 */
test.describe('Auth: first-time setup', () => {
  test.beforeEach(async ({ page }) => {
    await page.route('**/api/auth/status', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ data: { needSetup: true } }),
      })
    })
  })

  test('asks for the password only, with no bootstrap-code field', async ({ page }) => {
    await page.goto(ROUTES.setup)

    const password = page.locator('#setup-password')
    await expect(password).toBeVisible()
    await expect(password).toBeFocused()
    await expect(page.locator('#setup-confirm-password')).toBeVisible()
    // The regression this guards: re-introducing a code field would silently put
    // the "go read the container logs" step back into every Docker install.
    await expect(page.locator('#setup-token')).toHaveCount(0)
  })

  test('submits the password without any setup token in the body', async ({ page }) => {
    const bodies: unknown[] = []
    await page.route('**/api/auth/setup', async (route) => {
      bodies.push(route.request().postDataJSON())
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ data: { token: 'session', user: { id: 'usr_admin' } } }),
      })
    })
    await page.goto(ROUTES.setup)

    await page.locator('#setup-password').fill('Secure123')
    await page.locator('#setup-confirm-password').fill('Secure123')
    await page.getByRole('button', { name: /^(完成设置|Complete Setup)$/ }).click()

    await expect.poll(() => bodies.length).toBe(1)
    expect(bodies[0]).toEqual({ password: 'Secure123', confirmPassword: 'Secure123' })
  })

  test('keeps the password policy gate on the submit button', async ({ page }) => {
    await page.goto(ROUTES.setup)

    const submit = page.getByRole('button', { name: /^(完成设置|Complete Setup)$/ })
    // Dropping the code requirement must not also drop the policy requirement.
    await page.locator('#setup-password').fill('short')
    await page.locator('#setup-confirm-password').fill('short')
    await expect(submit).toBeDisabled()

    await page.locator('#setup-password').fill('Secure123')
    await page.locator('#setup-confirm-password').fill('Mismatch123')
    await expect(submit).toBeDisabled()

    await page.locator('#setup-confirm-password').fill('Secure123')
    await expect(submit).toBeEnabled()
  })
})
