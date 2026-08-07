import { type Page, type TestInfo, expect, test } from '@playwright/test'
import {
  createAgentWithPayload,
  createRun,
  deleteAgentAs,
  executeAgentChat,
  getAdminToken,
  listProviders,
  listRuns,
} from '../../utils/api-helpers'
import { loginAsAdmin } from '../../utils/auth'
import { API_BASE, ROUTES } from '../../utils/test-constants'

const THEMES = [
  { id: 'wave-light', appearance: 'light' },
  { id: 'wave-dark', appearance: 'dark' },
  { id: 'neo-yellow', appearance: 'light' },
  { id: 'midnight', appearance: 'dark' },
  { id: 'forest', appearance: 'dark' },
  { id: 'graphite', appearance: 'dark' },
] as const

type PageReadyCheck = (page: Page) => Promise<void>

interface ThemeGalleryFixture {
  agent: { id: string; name: string }
  completed: { id: string; intent: string }
  failed: { id: string; intent: string }
  pending: { id: string; intent: string }
}

const suspenseSpinner = (page: Page) =>
  page.locator('#main-content [class~="h-screen"] .ant-spin-spinning')

async function waitForLoadedPage(page: Page, heading: RegExp) {
  await expect(page.locator('#main-content').getByRole('heading', { name: heading })).toBeVisible({
    timeout: 15_000,
  })
  await expect(suspenseSpinner(page)).toHaveCount(0, { timeout: 15_000 })
  // Dashboard and Agents use pulse placeholders while their data queries settle.
  // A page heading alone is therefore not sufficient evidence that a visual is ready.
  await expect(
    page.locator('#main-content [class~="animate-pulse"][class~="bg-muted"]'),
  ).toHaveCount(0, { timeout: 15_000 })
}

const waitForDashboardReady: PageReadyCheck = (page) =>
  waitForLoadedPage(page, /^(仪表盘|Dashboard)$/)

const waitForAgentsReady: PageReadyCheck = (page) => waitForLoadedPage(page, /^Agents$/)

const waitForLoginReady: PageReadyCheck = async (page) => {
  await expect(page.getByRole('heading', { name: /^(登录|Sign In)$/ })).toBeVisible({
    timeout: 15_000,
  })
  await expect(page.getByTestId('login-brand-panel')).toBeVisible()
}

const waitForSetupReady: PageReadyCheck = async (page) => {
  await expect(page.getByRole('heading', { name: /^(初始化设置|Initial Setup)$/ })).toBeVisible({
    timeout: 15_000,
  })
  await expect(page.getByTestId('brand-mark-fallback')).toBeVisible()
}

async function dismissOnboardingWelcome(page: Page) {
  await page.goto(ROUTES.dashboard)
  await waitForDashboardReady(page)

  const dismissButton = page.getByRole('button', {
    name: /^(不再提示|Don't show again)$/,
  })
  const welcomeOpened = await dismissButton
    .waitFor({ state: 'visible', timeout: 2_000 })
    .then(() => true)
    .catch(() => false)
  if (!welcomeOpened) return

  const dismissed = page.waitForResponse(
    (response) =>
      response.url().includes('/api/auth/onboarding') && response.request().method() === 'PATCH',
  )
  await dismissButton.click()
  expect((await dismissed).ok()).toBeTruthy()
  await expect(dismissButton).toBeHidden()
}

async function openThemePicker(page: Page) {
  const sidebar = page.locator('aside')
  const userMenu = sidebar
    .getByRole('button')
    .filter({ hasText: /admin/i })
    .or(sidebar.locator('button[title]').last())
  await userMenu.click()
  await page.getByRole('button', { name: /外观与主题|Appearance & themes/ }).click()
  const themeGroup = page.getByRole('radiogroup', { name: /主题|Themes/ })
  await expect(themeGroup).toBeVisible()
  const modal = page.locator('.ant-modal').filter({ has: themeGroup })
  await expect
    .poll(
      () =>
        modal.evaluate((element) => ({
          transform: getComputedStyle(element).transform,
          opacity: getComputedStyle(element).opacity,
        })),
      {
        message: 'theme picker opening motion must finish before visual geometry checks',
      },
    )
    .toEqual({ transform: 'none', opacity: '1' })
}

async function openThemePickerWithKeyboard(page: Page) {
  const userMenu = page.locator('aside').getByRole('button').filter({ hasText: /admin/i })
  await userMenu.focus()
  await expect(userMenu).toBeFocused()
  await page.keyboard.press('Enter')

  const appearanceItem = page.getByRole('button', {
    name: /外观与主题|Appearance & themes/,
  })
  await expect(appearanceItem).toBeVisible()
  await appearanceItem.focus()
  await page.keyboard.press('Enter')
  await expect(page.getByRole('radiogroup', { name: /主题|Themes/ })).toBeVisible()
}

async function setPersistedTheme(page: Page, themeId: string, waitForReady: PageReadyCheck) {
  await page.evaluate((id) => localStorage.setItem('a2wave.theme', id), themeId)
  await page.reload({ waitUntil: 'domcontentloaded' })
  await expect(page.locator('html')).toHaveAttribute('data-theme', themeId)
  await waitForReady(page)
}

async function setSystemPreference(page: Page, waitForReady: PageReadyCheck) {
  await page.evaluate(() => localStorage.setItem('a2wave.theme', 'system'))
  await page.reload({ waitUntil: 'domcontentloaded' })
  await expect(page.locator('html')).toHaveAttribute('data-theme-preference', 'system')
  await expect(page.locator('html')).toHaveAttribute('data-theme', /wave-(light|dark)/)
  await waitForReady(page)
}

async function createThemeGalleryFixture(token: string): Promise<ThemeGalleryFixture> {
  const provider = (await listProviders(token)).find((candidate) => candidate.name === 'Codex CLI')
  expect(provider, 'Codex CLI provider fixture').toBeTruthy()

  const agent = await createAgentWithPayload(token, {
    name: 'Theme Gallery Review Agent',
    type: 'cursor',
    providerId: provider?.id,
    authMode: 'localSession',
    systemPrompt: [
      'You are a meticulous open-source design reviewer.',
      '',
      '## Review principles',
      '- Prefer clear hierarchy, accessible contrast, and restrained color.',
      '- Call out visual debt with specific, actionable evidence.',
    ].join('\n'),
    config: {
      engineType: 'codex',
      model: 'gpt-5.3-codex',
      timeoutMinutes: 1,
      maxRetries: 0,
      readOnly: true,
    },
  })

  const completedIntent = 'Theme gallery completed review with three concise visual findings.'
  const completedExecution = await executeAgentChat(token, agent.id, completedIntent)

  const failedIntent = 'Theme gallery failed review — fail-provider'
  const failedRun = await createRun(token, failedIntent, agent.id)
  const failedResponse = await fetch(`${API_BASE}/api/runs/${failedRun.id}/execute`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({ stream: false }),
  })
  expect(failedResponse.ok, 'fake provider failure must settle the run').toBe(false)
  const failedSnapshot = (await listRuns(token)).find((run) => run.id === failedRun.id)
  expect(failedSnapshot?.status).toBe('failed')

  const pendingIntent = 'Theme gallery review awaiting execution.'
  const pendingRun = await createRun(token, pendingIntent, agent.id)

  return {
    agent,
    completed: { id: completedExecution.runId, intent: completedIntent },
    failed: { id: failedRun.id, intent: failedIntent },
    pending: { id: pendingRun.id, intent: pendingIntent },
  }
}

async function waitForAgentEditorReady(page: Page, fixture: ThemeGalleryFixture) {
  await expect(page.locator('[data-page="agent-detail"]')).toBeVisible({ timeout: 15_000 })
  await expect(page.getByText(fixture.agent.name, { exact: true }).first()).toBeVisible()
  await expect(suspenseSpinner(page)).toHaveCount(0, { timeout: 15_000 })
  await expect(
    page.locator('#main-content [class~="animate-pulse"][class~="bg-muted"]'),
  ).toHaveCount(0, { timeout: 15_000 })
  // Scoped to the field label, not a substring match — a description paragraph
  // elsewhere on the page also contains "系统提示词" and turns a broad getByText
  // into a strict-mode violation (resolves to 2 elements).
  await expect(page.locator('label[for="systemPrompt"]')).toBeVisible()
  await expect(page.locator('.cm-editor')).toBeVisible()
}

async function waitForRunDetailReady(page: Page, fixture: ThemeGalleryFixture) {
  await waitForLoadedPage(page, /^(运行记录|Runs)$/)
  const detailDrawer = page
    .locator('.ant-drawer-open')
    .filter({ has: page.getByText(fixture.completed.intent, { exact: true }) })
    .last()
  await expect(detailDrawer).toBeVisible({ timeout: 15_000 })
  await expect(
    detailDrawer.getByText(fixture.completed.intent, { exact: true }).first(),
  ).toBeVisible()
  await expect(detailDrawer.locator('[class~="animate-spin"]')).toHaveCount(0, {
    timeout: 15_000,
  })
}

async function assertDashboardFixture(page: Page, fixture: ThemeGalleryFixture) {
  await waitForDashboardReady(page)
  const states = [
    { run: fixture.completed, label: /^(已完成|Completed)$/, icon: /text-success/ },
    { run: fixture.failed, label: /^(失败|Failed)$/, icon: /text-destructive/ },
    {
      run: fixture.pending,
      label: /^(等待执行|Pending)$/,
      icon: /text-muted-foreground/,
    },
  ]

  for (const state of states) {
    const row = page
      .locator(`#main-content a[href*="runId=${state.run.id}"]`)
      .filter({ hasText: state.run.intent })
    await expect(row).toBeVisible({ timeout: 15_000 })
    await expect(row.getByText(state.label)).toBeVisible()
    await expect(row.locator('svg').first()).toHaveClass(state.icon)
  }
}

async function openStableRunLog(page: Page, fixture: ThemeGalleryFixture) {
  const detailDrawer = page
    .locator('.ant-drawer-open')
    .filter({ has: page.getByText(fixture.completed.intent, { exact: true }) })
    .last()
  await detailDrawer.getByRole('button', { name: /切换运行日志|Toggle run log/ }).click()

  const logDrawer = page
    .locator('.ant-drawer-open')
    .filter({ has: page.getByRole('heading', { name: /^(运行日志|Run Log)$/ }) })
  await expect(logDrawer).toBeVisible({ timeout: 15_000 })
  await expect(logDrawer.getByText(fixture.completed.id, { exact: true })).toBeVisible()
  await expect(logDrawer.getByText(fixture.completed.intent, { exact: true })).toBeVisible()
  await expect(logDrawer.getByText('Step #1', { exact: true })).toBeVisible()
  await expect(logDrawer.locator('[class~="animate-spin"]')).toHaveCount(0, {
    timeout: 15_000,
  })
}

async function capture(page: Page, testInfo: TestInfo, name: string) {
  const path = testInfo.outputPath(`${name}.png`)
  await page.screenshot({ path, fullPage: true, animations: 'disabled' })
  await testInfo.attach(name, { path, contentType: 'image/png' })
}

async function assertNoHorizontalOverflow(page: Page) {
  const metrics = await page.evaluate(() => {
    const main = document.querySelector('main')?.getBoundingClientRect()
    return {
      viewport: window.innerWidth,
      documentWidth: document.documentElement.scrollWidth,
      bodyWidth: document.body.scrollWidth,
      mainLeft: main?.left ?? -1,
      mainRight: main?.right ?? Number.POSITIVE_INFINITY,
      mainWidth: main?.width ?? 0,
    }
  })

  expect(metrics.documentWidth, 'document must fit the viewport').toBeLessThanOrEqual(
    metrics.viewport,
  )
  expect(metrics.bodyWidth, 'body must fit the viewport').toBeLessThanOrEqual(metrics.viewport)
  expect(metrics.mainLeft).toBeGreaterThanOrEqual(0)
  expect(metrics.mainRight).toBeLessThanOrEqual(metrics.viewport)
  expect(metrics.mainWidth, 'main content must retain usable mobile width').toBeGreaterThan(300)
}

function contrastRatioFromCss(first: string, second: string) {
  const parse = (value: string) => {
    const channels = value
      .match(/[\d.]+/g)
      ?.slice(0, 3)
      .map(Number)
    if (!channels || channels.length !== 3) throw new Error(`Unsupported CSS color: ${value}`)
    return channels.map((channel) => {
      const normalized = channel / 255
      return normalized <= 0.04045 ? normalized / 12.92 : ((normalized + 0.055) / 1.055) ** 2.4
    })
  }
  const luminance = (value: string) => {
    const [red, green, blue] = parse(value)
    return 0.2126 * red + 0.7152 * green + 0.0722 * blue
  }
  const firstLuminance = luminance(first)
  const secondLuminance = luminance(second)
  return (
    (Math.max(firstLuminance, secondLuminance) + 0.05) /
    (Math.min(firstLuminance, secondLuminance) + 0.05)
  )
}

async function assertLoginBrandPanelContrast(page: Page, themeId: string) {
  const colors = await page.getByTestId('login-brand-panel').evaluate((panel) => {
    const title = panel.querySelector('h1')
    const copy = panel.querySelector('p:last-child')
    if (!title || !copy) throw new Error('Login brand title and copy must exist')
    const panelStyle = getComputedStyle(panel)
    return {
      panel: panelStyle.backgroundColor,
      backgroundImage: panelStyle.backgroundImage,
      title: getComputedStyle(title).color,
      copy: getComputedStyle(copy).color,
    }
  })

  expect(colors.backgroundImage, `${themeId}: login panel keeps branded depth`).not.toBe('none')
  expect(
    contrastRatioFromCss(colors.panel, colors.title),
    `${themeId}: login brand title contrast`,
  ).toBeGreaterThanOrEqual(4.5)
  expect(
    contrastRatioFromCss(colors.panel, colors.copy),
    `${themeId}: login brand copy contrast`,
  ).toBeGreaterThanOrEqual(4.5)
}

async function assertFocusedThemeDecorationFits(page: Page) {
  const focusedRadio = page.locator('input[type="radio"]:focus')
  const focusedCard = page.locator('label').filter({ has: focusedRadio })
  await expect(focusedCard).toBeVisible()

  const cardBox = await focusedCard.boundingBox()
  const groupBox = await focusedRadio.evaluate((radio) => {
    const group = radio.closest('[role="radiogroup"]')
    if (!group) return null
    const rect = group.getBoundingClientRect()
    return { x: rect.x, width: rect.width }
  })
  expect(cardBox).not.toBeNull()
  expect(groupBox).not.toBeNull()

  // focus-within:ring-2 + ring-offset-2 paints four pixels outside the card.
  // The scroll viewport needs a real gutter for that decoration; otherwise its
  // straight edge is clipped and only two curved fragments remain visible.
  const focusOutset = 4
  expect(
    (cardBox?.x ?? 0) - focusOutset,
    'left focus ring must fit the scroll viewport',
  ).toBeGreaterThanOrEqual(groupBox?.x ?? Number.POSITIVE_INFINITY)
  expect(
    (cardBox?.x ?? 0) + (cardBox?.width ?? 0) + focusOutset,
    'right focus ring must fit the scroll viewport',
  ).toBeLessThanOrEqual((groupBox?.x ?? 0) + (groupBox?.width ?? 0))

  const decoration = await focusedRadio.evaluate((radio) => {
    const inputStyle = getComputedStyle(radio)
    const labelStyle = getComputedStyle(radio.closest('label'))
    return {
      inputOutlineStyle: inputStyle.outlineStyle,
      inputOutlineWidth: inputStyle.outlineWidth,
      cardDisplay: labelStyle.display,
      cardShadow: labelStyle.boxShadow,
    }
  })
  expect(decoration.inputOutlineStyle, 'native radio outline must be transferred to the card').toBe(
    'none',
  )
  expect(
    ['block', 'grid'],
    'the focus ring must paint one card box, not inline fragments',
  ).toContain(decoration.cardDisplay)
  expect(decoration.cardShadow, 'the card must retain a clear keyboard focus ring').not.toBe('none')
}

test.beforeEach(async ({ page }) => {
  await loginAsAdmin(page)
  // Keep the appearance checks on the same path a user takes: dismiss the
  // welcome modal normally instead of bypassing its overlay with forced clicks.
  await dismissOnboardingWelcome(page)
})

test.describe('Appearance and themes', () => {
  test('keeps the focused mobile theme card decoration inside the picker', async ({
    page,
  }, testInfo) => {
    await page.setViewportSize({ width: 390, height: 844 })
    await page.goto(ROUTES.dashboard)
    await setSystemPreference(page, waitForDashboardReady)
    await openThemePicker(page)

    await expect(page.getByRole('radio', { name: /跟随系统|Follow system/ })).toBeFocused()
    await assertFocusedThemeDecorationFits(page)
    await assertNoHorizontalOverflow(page)
    await capture(page, testInfo, 'system-mobile-390x844-picker-focus')
  })

  test('supports keyboard preview, Escape, Cancel, and Apply without accidental persistence', async ({
    page,
  }) => {
    await page.goto(ROUTES.dashboard)
    await setPersistedTheme(page, 'wave-light', waitForDashboardReady)

    await openThemePickerWithKeyboard(page)
    const waveLight = page.getByRole('radio', { name: /Wave Light/ })
    await expect(waveLight).toBeFocused()
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'wave-light')

    await page.keyboard.press('ArrowRight')
    await expect(page.getByRole('radio', { name: /Wave Dark/ })).toBeChecked()
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'wave-dark')
    expect(await page.evaluate(() => localStorage.getItem('a2wave.theme'))).toBe('wave-light')

    await page.keyboard.press('Escape')
    await expect(page.getByRole('radiogroup', { name: /主题|Themes/ })).toBeHidden()
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'wave-light')

    await openThemePickerWithKeyboard(page)
    const forest = page.getByRole('radio', { name: /Forest/ })
    await forest.focus()
    await page.keyboard.press('Space')
    await expect(forest).toBeChecked()
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'forest')
    expect(await page.evaluate(() => localStorage.getItem('a2wave.theme'))).toBe('wave-light')

    await page.keyboard.press('Tab')
    const cancelButton = page.getByRole('button', { name: /取消|Cancel/ })
    await expect(cancelButton).toBeFocused()
    await page.keyboard.press('Space')
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'wave-light')

    await openThemePickerWithKeyboard(page)
    await expect(waveLight).toBeFocused()
    await page.keyboard.press('ArrowRight')
    await expect(page.getByRole('radio', { name: /Wave Dark/ })).toBeChecked()
    await page.keyboard.press('ArrowRight')
    const neo = page.getByRole('radio', { name: /Neo Yellow/ })
    await expect(neo).toBeChecked()
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'neo-yellow')
    expect(await page.evaluate(() => localStorage.getItem('a2wave.theme'))).toBe('wave-light')

    await page.keyboard.press('Tab')
    await expect(cancelButton).toBeFocused()
    await page.keyboard.press('Tab')
    const applyButton = page.getByRole('button', { name: /应用主题|Apply theme/ })
    await expect(applyButton).toBeFocused()
    await page.keyboard.press('Enter')

    await page.reload({ waitUntil: 'domcontentloaded' })
    await expect(page.locator('html')).toHaveAttribute('data-theme-preference', 'neo-yellow')
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'neo-yellow')
    await expect(page.locator('html')).toHaveAttribute('data-appearance', 'light')
    await waitForDashboardReady(page)
  })

  test('keeps the public login brand panel readable across all themes', async ({
    page,
  }, testInfo) => {
    await page.setViewportSize({ width: 1440, height: 1000 })

    for (const theme of THEMES) {
      await page.goto(ROUTES.login)
      await setPersistedTheme(page, theme.id, waitForLoginReady)
      await expect(page.locator('html')).toHaveAttribute('data-appearance', theme.appearance)
      await assertLoginBrandPanelContrast(page, theme.id)
      await capture(page, testInfo, `${theme.id}-login`)
    }
  })

  test('keeps first-time setup focus and the shared brand fallback readable', async ({
    page,
  }, testInfo) => {
    await page.setViewportSize({ width: 1440, height: 1000 })
    // The E2E database is intentionally already initialized. Mock only the
    // public status probe so this test exercises the real first-install page
    // without mutating or replacing the shared admin fixture.
    await page.route('**/api/auth/status', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ data: { needSetup: true } }),
      })
    })

    for (const theme of [
      { id: 'neo-yellow', appearance: 'light' },
      { id: 'wave-dark', appearance: 'dark' },
    ] as const) {
      await page.evaluate((id) => localStorage.setItem('a2wave.theme', id), theme.id)
      await page.goto('/setup', { waitUntil: 'domcontentloaded' })
      await expect(page.locator('html')).toHaveAttribute('data-theme', theme.id)
      await expect(page.locator('html')).toHaveAttribute('data-appearance', theme.appearance)
      await waitForSetupReady(page)

      const password = page.locator('input[type="password"]').first()
      await expect(password).toBeFocused()
      const focusedControl = password.locator('xpath=..')
      await expect(focusedControl).toHaveClass(/ant-input-affix-wrapper-focused/)
      // AntD transitions the border from its resting color. Judge the settled
      // focus state rather than sampling an arbitrary interpolation frame.
      await expect
        .poll(
          async () => {
            const colors = await focusedControl.evaluate((control) => {
              const card = document.querySelector('[data-testid="setup-card"]')
              if (!card) throw new Error('Setup card must exist')
              return {
                border: getComputedStyle(control).borderTopColor,
                card: getComputedStyle(card).backgroundColor,
              }
            })
            return contrastRatioFromCss(colors.border, colors.card)
          },
          { message: `${theme.id}: settled focused setup input boundary contrast` },
        )
        .toBeGreaterThanOrEqual(3)

      const fallback = page.getByTestId('brand-mark-fallback')
      await expect(fallback).toHaveClass(/text-primary-foreground/)
      await expect(fallback.locator('svg')).toBeVisible()
      await capture(page, testInfo, `${theme.id}-setup-first-install`)
    }
  })

  test('captures the complete stable-data gallery for strict visual review', async ({
    page,
  }, testInfo) => {
    test.setTimeout(240_000)
    await page.setViewportSize({ width: 1440, height: 1000 })
    const token = await getAdminToken()
    const fixture = await createThemeGalleryFixture(token)

    try {
      for (const theme of THEMES) {
        await page.goto(ROUTES.dashboard)
        await setPersistedTheme(page, theme.id, async (currentPage) => {
          await assertDashboardFixture(currentPage, fixture)
        })
        await expect(page.locator('html')).toHaveAttribute('data-appearance', theme.appearance)
        await capture(page, testInfo, `${theme.id}-dashboard-states`)

        await openThemePicker(page)
        await expect(page.locator('html')).toHaveAttribute('data-theme', theme.id)
        await expect(page.getByRole('radio', { checked: true })).toBeFocused()
        await capture(page, testInfo, `${theme.id}-picker`)
        await page.keyboard.press('Escape')
        await expect(page.getByRole('radiogroup', { name: /主题|Themes/ })).toBeHidden()

        await page.goto(ROUTES.agents)
        await setPersistedTheme(page, theme.id, async (currentPage) => {
          await waitForAgentsReady(currentPage)
          await expect(
            currentPage.getByText(fixture.agent.name, { exact: true }).first(),
          ).toBeVisible()
        })
        await capture(page, testInfo, `${theme.id}-agents`)

        await page.goto(`${ROUTES.agents}/${fixture.agent.id}`)
        await setPersistedTheme(page, theme.id, (currentPage) =>
          waitForAgentEditorReady(currentPage, fixture),
        )
        const promptEditor = page.locator('.cm-editor')
        await promptEditor.scrollIntoViewIfNeeded()
        await expect(promptEditor).toBeInViewport()
        const manageProviders = page.getByRole('link', {
          name: /查看 Providers|Manage providers/,
        })
        await expect(manageProviders).toBeVisible()
        await expect(manageProviders).toHaveClass(/text-interactive-foreground/)
        await capture(page, testInfo, `${theme.id}-agent-prompt-editor`)

        await page.goto(`${ROUTES.runs}?runId=${fixture.completed.id}`)
        await setPersistedTheme(page, theme.id, (currentPage) =>
          waitForRunDetailReady(currentPage, fixture),
        )
        await capture(page, testInfo, `${theme.id}-run-detail`)
        await openStableRunLog(page, fixture)
        await capture(page, testInfo, `${theme.id}-run-log`)
      }

      for (const viewport of [
        { name: 'mobile-390x844', width: 390, height: 844 },
        { name: 'tablet-1024x768', width: 1024, height: 768 },
      ]) {
        await page.setViewportSize({ width: viewport.width, height: viewport.height })
        await page.goto(ROUTES.dashboard)
        await setSystemPreference(page, async (currentPage) => {
          await assertDashboardFixture(currentPage, fixture)
        })
        await assertNoHorizontalOverflow(page)
        await expect(page.getByText(/^(总运行数|Total Runs)$/).first()).toBeVisible()
        await capture(page, testInfo, `system-${viewport.name}-dashboard`)
        await openThemePicker(page)
        await expect(page.getByRole('radio', { name: /跟随系统|Follow system/ })).toBeFocused()
        await assertFocusedThemeDecorationFits(page)
        await assertNoHorizontalOverflow(page)
        const picker = page.getByRole('dialog')
        await expect(picker).toBeVisible()
        const pickerBox = await picker.boundingBox()
        expect(pickerBox?.x ?? -1).toBeGreaterThanOrEqual(0)
        expect(
          (pickerBox?.x ?? 0) + (pickerBox?.width ?? Number.POSITIVE_INFINITY),
        ).toBeLessThanOrEqual(viewport.width)
        await capture(page, testInfo, `system-${viewport.name}-picker`)
        await page.keyboard.press('Escape')
        await expect(page.getByRole('radiogroup', { name: /主题|Themes/ })).toBeHidden()
      }
    } finally {
      await deleteAgentAs(token, fixture.agent.id)
    }
  })
})
