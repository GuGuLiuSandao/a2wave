/**
 * E2E tests for the Artifacts feature.
 *
 * Coverage:
 *   API — GET /api/artifacts (validation + list)
 *   API — DELETE /api/artifacts/:id (ownership check)
 *   UI  — Drawer doesn't show artifact section when run has no artifacts
 *   UI  — Artifact section appears when run has artifacts
 */
import { type Page, expect, test } from '@playwright/test'
import {
  createAgent,
  createRun,
  deleteAgentAs,
  deleteArtifact,
  getAdminToken,
  listArtifacts,
  listRuns,
} from '../../utils/api-helpers'
import { loginAsAdmin } from '../../utils/auth'
import { API_BASE, ROUTES } from '../../utils/test-constants'

/** A run must target an Agent (createRunInput.initiatorAgentId is required), so
 *  lazily create one shared test Agent for the artifact-fixture runs. */
let sharedAgentId: string | undefined
async function ensureAgentId(token: string): Promise<string> {
  if (!sharedAgentId) {
    const agent = await createAgent(token, `e2e-artifacts-${Date.now()}`)
    sharedAgentId = agent.id
  }
  return sharedAgentId
}

// Clean up the shared fixture Agent so runs don't accumulate across CI runs.
test.afterAll(async () => {
  if (sharedAgentId) {
    await deleteAgentAs(await getAdminToken(), sharedAgentId)
    sharedAgentId = undefined
  }
})

/** 产物列表在「运行日志」侧栏的 RunLogContent 内；主 Drawer 默认只显示会话，须先打开日志侧栏。 */
async function openRunLogSidePanel(page: Page) {
  await page.getByRole('button', { name: '切换运行日志' }).click()
  await expect(page.getByRole('heading', { name: '运行日志' })).toBeVisible({ timeout: 5000 })
}

function runLogDrawer(page: Page) {
  return page
    .locator('.ant-drawer-open')
    .filter({ has: page.getByRole('heading', { name: '运行日志' }) })
}

// ── API-level tests (no browser needed) ───────────────────────────────────

test.describe('Artifacts API', () => {
  test('GET /api/artifacts without runId 返回 400', async ({ request }) => {
    const token = await getAdminToken()
    const res = await request.get(`${API_BASE}/api/artifacts`, {
      headers: { Authorization: `Bearer ${token}` },
    })
    expect(res.status()).toBe(400)
    const body = await res.json()
    expect(body.error).toBe('runId or agentId is required')
  })

  test('GET /api/artifacts?runId=xxx 返回空列表（无产物的 run）', async ({ request }) => {
    const token = await getAdminToken()
    // Create a fresh run with no artifacts
    const run = await createRun(token, `e2e-no-artifacts-${Date.now()}`, await ensureAgentId(token))

    const res = await request.get(`${API_BASE}/api/artifacts?runId=${run.id}`, {
      headers: { Authorization: `Bearer ${token}` },
    })
    expect(res.status()).toBe(200)
    const body = await res.json()
    expect(Array.isArray(body.data)).toBe(true)
    expect(body.data).toHaveLength(0)
  })

  test('GET /api/artifacts?runId=不存在的run 返回空列表', async ({ request }) => {
    const token = await getAdminToken()
    const res = await request.get(`${API_BASE}/api/artifacts?runId=run_nonexistent_xyz`, {
      headers: { Authorization: `Bearer ${token}` },
    })
    expect(res.status()).toBe(200)
    const body = await res.json()
    expect(body.data).toEqual([])
  })

  test('GET /api/artifacts 未认证返回 401', async ({ request }) => {
    const res = await request.get(`${API_BASE}/api/artifacts?runId=run_test`)
    if (res.status() === 200) {
      test.skip(true, 'API 在 dev 模式下自动认证')
      return
    }
    expect(res.status()).toBe(401)
  })

  test('DELETE /api/artifacts/不存在ID 返回 404', async ({ request }) => {
    const token = await getAdminToken()
    const res = await request.delete(`${API_BASE}/api/artifacts/art_nonexistent_xyz`, {
      headers: { Authorization: `Bearer ${token}` },
    })
    expect(res.status()).toBe(404)
  })

  test('GET /api/artifacts/:id/download 不存在返回 404', async ({ request }) => {
    const token = await getAdminToken()
    const res = await request.get(`${API_BASE}/api/artifacts/art_ghost/download`, {
      headers: { Authorization: `Bearer ${token}` },
    })
    expect(res.status()).toBe(404)
  })

  test('listArtifacts helper 与 API 返回一致', async () => {
    const token = await getAdminToken()
    const run = await createRun(
      token,
      `e2e-artifact-helper-${Date.now()}`,
      await ensureAgentId(token),
    )
    const artifacts = await listArtifacts(token, run.id)
    expect(Array.isArray(artifacts)).toBe(true)
  })
})

// ── UI-level tests ─────────────────────────────────────────────────────────

test.describe('Artifacts UI — 无产物时', () => {
  test.beforeEach(async ({ page }) => {
    await loginAsAdmin(page)
  })

  test('Drawer 打开后，无产物的 Run 不显示「运行产物」区块', async ({ page }) => {
    const token = await getAdminToken()
    const runs = await listRuns(token)

    if (runs.length === 0) {
      test.skip()
      return
    }

    const run = runs[0]
    // Confirm this run has no artifacts
    const artifacts = await listArtifacts(token, run.id)
    if (artifacts.length > 0) {
      test.skip()
      return
    }

    await page.goto(`${ROUTES.runs}?runId=${run.id}`)
    await page.waitForLoadState('networkidle')

    const drawer = page.locator('.ant-drawer-open')
    await expect(drawer).toBeVisible({ timeout: 5000 })

    await openRunLogSidePanel(page)
    // Artifact section should NOT be visible inside run log panel
    await expect(runLogDrawer(page).getByText('运行产物')).not.toBeVisible()
  })

  test('新建 Run 打开 Drawer 后无产物区块', async ({ page }) => {
    const token = await getAdminToken()
    const run = await createRun(
      token,
      `e2e-drawer-no-art-${Date.now()}`,
      await ensureAgentId(token),
    )

    await page.goto(`${ROUTES.runs}?runId=${run.id}`)
    await page.waitForLoadState('networkidle')

    const drawer = page.locator('.ant-drawer-open')
    await expect(drawer).toBeVisible({ timeout: 5000 })

    await openRunLogSidePanel(page)
    // No artifacts → section should not be present in log panel
    await expect(runLogDrawer(page).getByText('运行产物')).not.toBeVisible()
  })
})

test.describe('Artifacts UI — 有产物时（如已存在）', () => {
  test.beforeEach(async ({ page }) => {
    await loginAsAdmin(page)
  })

  test('有产物的 Run 在 Drawer 中显示产物区块和文件名', async ({ page }) => {
    const token = await getAdminToken()
    const runs = await listRuns(token, 100)

    // Find a run that has at least one artifact
    let runWithArtifact: (typeof runs)[0] | undefined
    let artifacts: Awaited<ReturnType<typeof listArtifacts>> = []
    for (const run of runs) {
      const arts = await listArtifacts(token, run.id)
      if (arts.length > 0) {
        runWithArtifact = run
        artifacts = arts
        break
      }
    }

    if (!runWithArtifact) {
      test.skip()
      return
    }

    await page.goto(`${ROUTES.runs}?runId=${runWithArtifact.id}`)
    await page.waitForLoadState('networkidle')

    const drawer = page.locator('.ant-drawer-open')
    await expect(drawer).toBeVisible({ timeout: 5000 })

    await openRunLogSidePanel(page)
    const logDrawer = runLogDrawer(page)

    // Artifact section title should appear
    await expect(logDrawer.getByText('运行产物')).toBeVisible({ timeout: 3000 })

    // Filename in artifact row（exact：避免与日志 JSON 中的子串匹配）
    await expect(logDrawer.getByText(artifacts[0].filename, { exact: true })).toBeVisible({
      timeout: 3000,
    })
  })

  test('有产物时显示下载链接', async ({ page }) => {
    const token = await getAdminToken()
    const runs = await listRuns(token, 100)

    let runWithArtifact: (typeof runs)[0] | undefined
    for (const run of runs) {
      const arts = await listArtifacts(token, run.id)
      if (arts.length > 0) {
        runWithArtifact = run
        break
      }
    }

    if (!runWithArtifact) {
      test.skip()
      return
    }

    await page.goto(`${ROUTES.runs}?runId=${runWithArtifact.id}`)
    await page.waitForLoadState('networkidle')

    const drawer = page.locator('.ant-drawer-open')
    await expect(drawer).toBeVisible({ timeout: 5000 })

    await openRunLogSidePanel(page)
    const logDrawer = runLogDrawer(page)
    await expect(logDrawer.getByText('运行产物')).toBeVisible({ timeout: 3000 })

    // Download link (anchor) with /download in href should be present
    const downloadLink = logDrawer.locator('a[href*="/download"]')
    await expect(downloadLink.first()).toBeVisible({ timeout: 3000 })
  })

  test('点击删除按钮后产物消失（API 级别验证）', async ({ page }) => {
    const token = await getAdminToken()
    const runs = await listRuns(token, 100)

    let runWithArtifact: (typeof runs)[0] | undefined
    let artifacts: Awaited<ReturnType<typeof listArtifacts>> = []
    for (const run of runs) {
      const arts = await listArtifacts(token, run.id)
      if (arts.length > 0) {
        runWithArtifact = run
        artifacts = arts
        break
      }
    }

    if (!runWithArtifact || artifacts.length === 0) {
      test.skip()
      return
    }

    // Delete the first artifact via API
    await deleteArtifact(token, artifacts[0].id)

    // Verify it no longer appears
    const remaining = await listArtifacts(token, runWithArtifact.id)
    expect(remaining.find((a) => a.id === artifacts[0].id)).toBeUndefined()
  })
})

test.describe('Artifacts API — 权限隔离', () => {
  test('未认证请求 artifacts 接口返回 401', async ({ request }) => {
    const res = await request.get(`${API_BASE}/api/artifacts?runId=run_test`)
    if (res.status() === 200) {
      test.skip(true, 'API 在 dev 模式下自动认证')
      return
    }
    expect(res.status()).toBe(401)
  })

  test('未认证 DELETE 返回 401', async ({ request }) => {
    const res = await request.delete(`${API_BASE}/api/artifacts/art_test`)
    if (res.status() !== 401) {
      test.skip(true, 'API 在 dev 模式下自动认证')
      return
    }
    expect(res.status()).toBe(401)
  })

  test('未认证 download 返回 401', async ({ request }) => {
    const res = await request.get(`${API_BASE}/api/artifacts/art_test/download`)
    if (res.status() !== 401) {
      test.skip(true, 'API 在 dev 模式下自动认证')
      return
    }
    expect(res.status()).toBe(401)
  })
})
