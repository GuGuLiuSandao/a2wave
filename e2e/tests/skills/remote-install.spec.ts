import { expect, test } from '@playwright/test'
import { loginAsAdmin } from '../../utils/auth'
import { API_BASE, ROUTES } from '../../utils/test-constants'

const REVISION_A = 'a'.repeat(40)
const REVISION_B = 'b'.repeat(40)
const DIGEST_A = `sha256:${'c'.repeat(64)}`
const DIGEST_B = `sha256:${'d'.repeat(64)}`

test.describe('Remote Skill installation and updates', () => {
  test.beforeEach(async ({ page }) => {
    await expect
      .poll(
        async () => {
          try {
            return (await fetch(`${API_BASE}/api/health`)).ok
          } catch {
            return false
          }
        },
        { timeout: 60_000 },
      )
      .toBe(true)
    await loginAsAdmin(page)
  })

  test('previews and installs a skills.sh URL from the Skills page', async ({ page }) => {
    let installBody: Record<string, unknown> | undefined

    await page.route('**/api/skills/remote/inspect', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          data: {
            inputUrl: 'https://skills.sh/acme/tools/demo-skill',
            repository: 'acme/tools',
            repositoryUrl: 'https://github.com/acme/tools',
            requestedRef: 'main',
            revision: REVISION_A,
            catalog: 'skills_sh',
            candidates: [
              {
                name: 'demo-skill',
                description: 'A remote Skill used by the E2E flow',
                path: 'skills/demo-skill',
                digest: DIGEST_A,
                fileCount: 2,
                totalBytes: 256,
              },
            ],
          },
        }),
      })
    })
    await page.route('**/api/skills/remote/install', async (route) => {
      installBody = route.request().postDataJSON() as Record<string, unknown>
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          data: [{ id: 'skl_remote_e2e', name: 'demo-skill' }],
        }),
      })
    })
    await page.route('**/api/skills/skl_remote_e2e', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          data: {
            id: 'skl_remote_e2e',
            name: 'demo-skill',
            description: 'A remote Skill used by the E2E flow',
            content: '# Demo',
            remoteSource: {
              provider: 'github',
              inputUrl: 'https://skills.sh/acme/tools/demo-skill',
              repository: 'acme/tools',
              repositoryUrl: 'https://github.com/acme/tools',
              requestedRef: 'main',
              revision: REVISION_A,
              path: 'skills/demo-skill',
              digest: DIGEST_A,
              catalog: 'skills_sh',
            },
            sourceDirty: false,
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
          },
        }),
      })
    })

    await page.goto(ROUTES.skills)
    await page.getByRole('button', { name: '上传', exact: true }).first().click()
    await page.getByText('从 URL 安装', { exact: true }).click()
    await page.getByLabel('skills.sh 或 GitHub URL').fill('https://skills.sh/acme/tools/demo-skill')
    await page.getByRole('button', { name: '预览' }).click()

    await expect(page.getByText('demo-skill', { exact: true })).toBeVisible()
    await expect(page.getByText(/commit aaaaaaaa/)).toBeVisible()
    await page.getByRole('button', { name: '安装（1）' }).click()

    await expect
      .poll(() => installBody)
      .toMatchObject({
        requestedRef: 'main',
        revision: REVISION_A,
        selections: [{ path: 'skills/demo-skill', digest: DIGEST_A }],
      })
    // Installing a single skill opens its editor, and that editor is now
    // addressable — the skill id rides in the query string.
    await expect(page).toHaveURL(/\/skills\?skill=/)
    const editor = page
      .getByRole('dialog')
      .filter({ has: page.getByRole('heading', { name: 'demo-skill', exact: true }) })
    await expect(editor).toContainText('acme/tools')
  })

  test('shows three-way conflicts and preserves local files during update', async ({ page }) => {
    let updateBody: Record<string, unknown> | undefined
    const remoteSource = {
      provider: 'github',
      inputUrl: 'https://github.com/acme/tools/tree/main/skills/demo-skill',
      repository: 'acme/tools',
      repositoryUrl: 'https://github.com/acme/tools',
      requestedRef: 'main',
      revision: REVISION_A,
      path: 'skills/demo-skill',
      digest: DIGEST_A,
      catalog: null,
    }
    const skill = {
      id: 'skl_remote_e2e',
      name: 'demo-skill',
      description: 'A remote Skill used by the E2E flow',
      content: '# Demo',
      storagePath: '/tmp/e2e-skill',
      remoteSource,
      sourceDirty: true,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    }

    await page.route('**/api/skills/skl_remote_e2e/files', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ data: { path: '/tmp/e2e-skill', entries: [] } }),
      })
    })
    await page.route('**/api/skills/skl_remote_e2e/remote/check', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          data: {
            skillId: skill.id,
            source: remoteSource,
            installedRevision: REVISION_A,
            latestRevision: REVISION_B,
            latestDigest: DIGEST_B,
            localDigest: DIGEST_B,
            updateAvailable: true,
            sourceDirty: true,
            files: [
              {
                path: 'SKILL.md',
                localChange: 'modified',
                remoteChange: 'modified',
                conflict: true,
              },
            ],
            conflicts: ['SKILL.md'],
          },
        }),
      })
    })
    await page.route('**/api/skills/skl_remote_e2e/remote/update', async (route) => {
      updateBody = route.request().postDataJSON() as Record<string, unknown>
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          data: {
            skill: {
              ...skill,
              remoteSource: { ...remoteSource, revision: REVISION_B, digest: DIGEST_B },
            },
            strategy: 'preserve_local',
            preservedLocalChanges: true,
          },
        }),
      })
    })
    await page.route('**/api/skills/skl_remote_e2e', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ data: skill }),
      })
    })
    await page.route('**/api/skills?page=*', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ data: [skill] }),
      })
    })

    await page.goto(ROUTES.skills)
    await page.getByRole('button', { name: /demo-skill/ }).click()
    await page.getByRole('button', { name: '检查更新' }).click()

    await expect(page.getByText('本地修改与本次更新冲突')).toBeVisible()
    await expect(page.locator('[title="SKILL.md"]')).toBeVisible()
    await page.getByRole('button', { name: '保留本地版本' }).click()

    await expect
      .poll(() => updateBody)
      .toEqual({
        revision: REVISION_B,
        digest: DIGEST_B,
        strategy: 'preserve_local',
      })
  })
})
