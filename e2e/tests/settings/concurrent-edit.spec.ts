/**
 * Settings optimistic concurrency — the parts only a real browser can prove.
 *
 * The conflict check and the form rebase are the mechanism this feature stands
 * on, and their unit coverage mocks the query layer away. These specs drive two
 * independent sessions against one server so the wire format, the 409, the
 * rendered copy, and the rebase all have to be genuinely true:
 *
 *   1. a stale save is rejected with the localized conflict copy;
 *   2. the rebase preserves the in-progress edits across the recovery refetch,
 *      so retrying actually works — previously the form froze instead, and the
 *      retry wrote page-load values over the other admin's change;
 *   3. two saves in one session do not self-conflict — the versions map is read
 *      at call time rather than captured during render.
 */
import { expect, test } from '@playwright/test'
import type { Page } from '@playwright/test'
import { getAdminToken } from '../../utils/api-helpers'
import { dismissOnboarding, loginAsAdmin } from '../../utils/auth'
import { API_BASE, ROUTES } from '../../utils/test-constants'

/** Writes a settings patch straight through the API, as a second admin would. */
async function patchSettingsAsOtherAdmin(patch: Record<string, Record<string, string>>) {
  const token = await getAdminToken()
  const res = await fetch(`${API_BASE}/api/settings`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    // Deliberately no expectedVersions: this stands in for an out-of-band writer
    // and must not itself be blocked by the precondition.
    body: JSON.stringify(patch),
  })
  if (!res.ok) throw new Error(`patchSettings failed: ${res.status} ${await res.text()}`)
}

async function readSetting(category: string, key: string): Promise<string | undefined> {
  const token = await getAdminToken()
  const res = await fetch(`${API_BASE}/api/settings`, {
    headers: { Authorization: `Bearer ${token}` },
  })
  const body = (await res.json()) as { data: Record<string, Record<string, string>> }
  return body.data?.[category]?.[key]
}

const brandingForm = (page: Page) => page.getByLabel(/网站副标题/).locator('xpath=ancestor::form')
const generalForm = (page: Page) => page.locator('#workspacePath').locator('xpath=ancestor::form')

// Serial, and NOT parallel-safe with the other settings specs.
//
// These testsmust  write real global settings rows — that is the whole point, since
// the mechanism under test is a server-side precondition. `settings` rows are a
// single shared resource with no per-test isolation, so any spec that reads or
// writes settings concurrently (jwt-signer, public-base-url) races them. Playwright
// parallelises by FILE, so `mode: 'serial'` alone does not prevent that.
//
// Run the settings directory on a single worker when it must be green as a whole:
//   npx playwright test e2e/tests/settings --workers=1
// The interference is pre-existing — jwt-signer and public-base-url already fail
// against each other in parallel on this branch's merge-base — so this annotation
// documents the constraint rather than introducing it.
test.describe.configure({ mode: 'serial' })

test.describe('Settings — concurrent edit', () => {
  let originalSubtitle: string
  let originalWorkspacePath: string
  let originalTimeoutMinutes: string

  test.beforeEach(async ({ page }) => {
    await loginAsAdmin(page)
    // The FTUE tour's mask swallows pointer events outside its spotlight, so on a
    // fresh database the first fill() below fails with "element intercepts pointer
    // events". Passing locally only means this admin already dismissed it.
    await page.goto(ROUTES.dashboard)
    await dismissOnboarding(page)
    originalSubtitle = (await readSetting('branding', 'subtitle')) ?? ''
    originalWorkspacePath = (await readSetting('general', 'workspacePath')) ?? './data/workspaces'
    originalTimeoutMinutes = (await readSetting('general', 'timeoutMinutes')) ?? '30'
  })

  test.afterEach(async () => {
    await patchSettingsAsOtherAdmin({
      general: {
        workspacePath: originalWorkspacePath,
        timeoutMinutes: originalTimeoutMinutes,
      },
      branding: { subtitle: originalSubtitle },
    })
  })

  test('a stale save is rejected, and the untouched field keeps the other admin’s value', async ({
    page,
  }) => {
    // The General form is used deliberately: its submit ALWAYS sends both
    // workspacePath and timeoutMinutes, so a field the user never touched still
    // participates in the write. That is the only place rebase and the old
    // `!isDirty` guard differ — a dirty field keeps the user's value under either
    // design, so a spec that edits every participating field passes under both and
    // proves nothing.
    await patchSettingsAsOtherAdmin({ general: { timeoutMinutes: '11' } })

    await page.goto(`${ROUTES.settings}?tab=general`)
    await expect(page.locator('#timeoutMinutes')).toHaveValue('11', { timeout: 15_000 })

    // This session edits ONLY the workspace path.
    const myWorkspace = `/tmp/e2e-ws-${Date.now()}`
    await page.locator('#workspacePath').fill(myWorkspace)

    // Another admin changes the timeout while this form sits open and dirty.
    await patchSettingsAsOtherAdmin({ general: { timeoutMinutes: '22' } })

    // Saving now carries the page-load token for timeoutMinutes -> rejected.
    const conflict = page.waitForResponse(
      (r) => r.url().includes('/api/settings') && r.request().method() === 'PATCH',
    )
    await generalForm(page)
      .getByRole('button', { name: /^保存$|^Save$/ })
      .click()
    expect((await conflict).status()).toBe(409)

    // The localized conflict copy must be shown — not a bare code.
    await expect(page.getByText(/该设置已被其他人修改/)).toBeVisible()

    // The decisive assertion: the UNTOUCHED field adopts the concurrent change.
    // Under the old guard it would stay frozen at the page-load value ('11').
    await expect(page.locator('#timeoutMinutes')).toHaveValue('22')
    // ...while this session's own edit survives the recovery refetch.
    await expect(page.locator('#workspacePath')).toHaveValue(myWorkspace)

    // Retry now carries a fresh token and succeeds.
    const retry = page.waitForResponse(
      (r) => r.url().includes('/api/settings') && r.request().method() === 'PATCH',
    )
    await generalForm(page)
      .getByRole('button', { name: /^保存$|^Save$/ })
      .click()
    expect((await retry).status()).toBe(200)

    // And the other admin's value survived the retry — the lost update this
    // whole mechanism exists to prevent. The old guard would have written '11'.
    expect(await readSetting('general', 'timeoutMinutes')).toBe('22')
    expect(await readSetting('general', 'workspacePath')).toBe(myWorkspace)
  })

  test('a second save in the same session carries a fresh token, not a stale one', async ({
    page,
  }) => {
    // Regression for the render-captured versions map: back-to-back saves used to
    // reuse the pre-write map, so the second self-conflicted with the first. This
    // is also the shape that made a fast double-click on an SSO enable toggle 409.
    //
    // Asserted on the outbound payload rather than by round-tripping the stored
    // value: what matters is that the SECOND request carries a different token
    // than the first, which is exactly what the stale closure got wrong.
    await page.goto(`${ROUTES.settings}?tab=branding`)
    await expect(page.getByLabel(/网站副标题/)).toBeVisible({ timeout: 15_000 })

    const sentTokens: (string | undefined)[] = []
    page.on('request', (req) => {
      if (!req.url().includes('/api/settings') || req.method() !== 'PATCH') return
      const body = req.postDataJSON() as { expectedVersions?: Record<string, string> }
      sentTokens.push(body?.expectedVersions?.['branding.subtitle'])
    })

    for (const value of [`e2e-first-${Date.now()}`, `e2e-second-${Date.now()}`]) {
      await page.getByLabel(/网站副标题/).fill(value)
      const saved = page.waitForResponse(
        (r) => r.url().includes('/api/settings') && r.request().method() === 'PATCH',
      )
      await brandingForm(page)
        .getByRole('button', { name: /^保存$|^Save$/ })
        .click()
      // Neither save may 409: the second reads the token the first just wrote.
      expect((await saved).status()).toBe(200)
    }

    expect(sentTokens).toHaveLength(2)
    // The first save has no token for a key that did not exist yet, or the
    // pre-write one; either way the second must differ, proving it was re-read.
    expect(sentTokens[1]).not.toBe(sentTokens[0])
  })
})
