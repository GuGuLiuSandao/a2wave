import { expect, test } from '@playwright/test'
import { getAdminToken } from '../../utils/api-helpers'
import { loginAsAdmin } from '../../utils/auth'
import { API_BASE, ROUTES } from '../../utils/test-constants'

const notionUrl = 'https://www.notion.so/2dc2541e45a5495e817e2ac6e189ea5a'
const notionPageId = '2dc2541e-45a5-495e-817e-2ac6e189ea5a'

test('rotates a Notion token through the real API without exposing either secret', async ({
  page,
}) => {
  const token = await getAdminToken()
  const docName = `Notion handbook ${Date.now()}`
  const seedResponse = await fetch(`${API_BASE}/api/e2e/kb-documents`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({
      name: docName,
      notionUrl,
      notionPageId,
      notionToken: 'ntn_original_e2e_secret',
    }),
  })
  expect(seedResponse.status).toBe(201)
  const seeded = (await seedResponse.json()) as { data: { id: string } }
  const documentId = seeded.data.id

  try {
    await loginAsAdmin(page)
    // The KB detail flow is now a modal: open it by clicking the document's card
    // on the list page (the /kb-documents/:id route no longer exists).
    await page.goto(ROUTES.kbDocuments)
    await page.getByText(docName).click()

    await expect(page.getByLabel('Notion 页面链接')).toHaveValue(notionUrl)
    const tokenInput = page.getByLabel('Notion Integration Token')
    await expect(tokenInput).toHaveValue('')
    await expect(page.getByText('留空则保留当前 Token。')).toBeVisible()

    await tokenInput.fill('ntn_replacement_e2e_secret')
    const patchResponsePromise = page.waitForResponse(
      (response) =>
        response.url().endsWith(`/api/kb-documents/${documentId}`) &&
        response.request().method() === 'PATCH',
    )
    await page.getByRole('button', { name: '保存' }).click()

    const patchResponse = await patchResponsePromise
    expect(patchResponse.status()).toBe(200)
    const patchRequest = patchResponse.request().postDataJSON() as Record<string, unknown>
    expect(patchRequest).toMatchObject({ notionToken: 'ntn_replacement_e2e_secret' })
    expect(patchRequest).not.toHaveProperty('notionUrl')
    expect(JSON.stringify(patchRequest)).not.toContain('********')

    const patchBody = (await patchResponse.json()) as {
      data: { notionToken: string; syncStatus: string }
    }
    expect(patchBody.data.notionToken).toBe('********')
    expect(patchBody.data.syncStatus).toBe('idle')
    expect(JSON.stringify(patchBody)).not.toContain('ntn_replacement_e2e_secret')
  } finally {
    await fetch(`${API_BASE}/api/kb-documents/${documentId}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${token}` },
    })
  }
})
