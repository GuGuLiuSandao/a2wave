import { expect, test } from '@playwright/test'
import { getAdminToken } from '../../utils/api-helpers'
import { loginAsAdmin } from '../../utils/auth'
import { API_BASE, ROUTES } from '../../utils/test-constants'

/**
 * The only hermetic batch flow: a multi-file upload needs no Feishu/Notion credentials.
 * Feishu/Notion batches are covered by unit tests instead — an e2e for them would need
 * live third-party tokens, which is exactly why notion-credentials.spec.ts seeds through
 * the dev-only /api/e2e/kb-documents route.
 */
test('uploads several files at once and stays on the list', async ({ page }) => {
  const token = await getAdminToken()
  const stamp = Date.now()
  const names = [`kb-batch-a-${stamp}`, `kb-batch-b-${stamp}`]

  try {
    await loginAsAdmin(page)
    await page.goto(ROUTES.kbDocuments)

    await page.locator('input[type="file"]').setInputFiles(
      names.map((name) => ({
        name: `${name}.md`,
        mimeType: 'text/markdown',
        buffer: Buffer.from(`# ${name}\n\nbatch upload fixture`),
      })),
    )

    // A card per file, named after the file — the api derives the name from the filename.
    for (const name of names) {
      await expect(page.getByText(name, { exact: true })).toBeVisible({ timeout: 15_000 })
    }
    // No modal opens for a batch: there is no defensible "which one" to jump into.
    await expect(page.getByRole('dialog')).toHaveCount(0)
    await expect(page).toHaveURL(new RegExp(`${ROUTES.kbDocuments}$`))

    expect(await idsNamed(token, names)).toHaveLength(2)
  } finally {
    // Look the ids up here, not in the try: an assertion failing earlier would otherwise
    // leave both documents behind in the shared dev database.
    for (const id of await idsNamed(token, names)) {
      await fetch(`${API_BASE}/api/kb-documents/${id}`, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${token}` },
      })
    }
  }
})

async function idsNamed(token: string, names: string[]): Promise<string[]> {
  const res = await fetch(`${API_BASE}/api/kb-documents?pageSize=100`, {
    headers: { Authorization: `Bearer ${token}` },
  })
  const body = (await res.json()) as { data: Array<{ id: string; name: string }> }
  return body.data.filter((d) => names.includes(d.name)).map((d) => d.id)
}
