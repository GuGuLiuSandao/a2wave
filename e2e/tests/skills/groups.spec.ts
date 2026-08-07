import { expect, test } from '@playwright/test'
import { getAdminToken } from '../../utils/api-helpers'
import { loginAsAdmin } from '../../utils/auth'
import { API_BASE, ROUTES } from '../../utils/test-constants'

const RUN_TAG = `${Date.now()}`

async function createSkill(token: string, name: string, content: string) {
  const res = await fetch(`${API_BASE}/api/skills`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({ name, content }),
  })
  if (!res.ok) throw new Error(`createSkill failed: ${res.status}`)
  const body = (await res.json()) as { data: { id: string } }
  return body.data.id
}

async function deleteSkill(token: string, id: string) {
  await fetch(`${API_BASE}/api/skills/${id}`, {
    method: 'DELETE',
    headers: { Authorization: `Bearer ${token}` },
  })
}

async function deleteGroup(token: string, id: string) {
  await fetch(`${API_BASE}/api/skill-groups/${id}`, {
    method: 'DELETE',
    headers: { Authorization: `Bearer ${token}` },
  })
}

async function getGroupMembers(token: string, id: string) {
  const res = await fetch(`${API_BASE}/api/skill-groups/${id}/skills`, {
    headers: { Authorization: `Bearer ${token}` },
  })
  const body = (await res.json()) as { data: string[] }
  return body.data
}

test.describe('Skill Groups', () => {
  test.beforeEach(async ({ page }) => {
    await loginAsAdmin(page)
  })

  test('CRUD via API + /skills page shows grouped layout', async ({ page }) => {
    const token = await getAdminToken()

    const sklA = await createSkill(token, `E2E Skill A ${RUN_TAG}`, 'body A')
    const sklB = await createSkill(token, `E2E Skill B ${RUN_TAG}`, 'body B')

    try {
      // Create group with both skills as members
      const createRes = await fetch(`${API_BASE}/api/skill-groups`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({
          name: `E2E Group ${RUN_TAG}`,
          description: 'e2e bundle',
          icon: 'package',
          skillIds: [sklA, sklB],
        }),
      })
      expect(createRes.status).toBe(201)
      const created = (await createRes.json()) as { data: { id: string } }

      try {
        // Members reflect both skills
        const members = await getGroupMembers(token, created.data.id)
        expect(members.sort()).toEqual([sklA, sklB].sort())

        // List shows the new group
        const listRes = await fetch(`${API_BASE}/api/skill-groups`, {
          headers: { Authorization: `Bearer ${token}` },
        })
        const listBody = (await listRes.json()) as { data: Array<{ id: string; name: string }> }
        expect(listBody.data.some((g) => g.id === created.data.id)).toBe(true)

        // PATCH: remove one skill from the group
        const patchRes = await fetch(`${API_BASE}/api/skill-groups/${created.data.id}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
          body: JSON.stringify({ skillIds: [sklA] }),
        })
        expect(patchRes.status).toBe(200)
        const membersAfter = await getGroupMembers(token, created.data.id)
        expect(membersAfter).toEqual([sklA])

        // Invalid skill ID is silently filtered by filterVisibleSkillIds
        await fetch(`${API_BASE}/api/skill-groups/${created.data.id}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
          body: JSON.stringify({ skillIds: [sklA, 'skl_does_not_exist'] }),
        })
        const membersAfter2 = await getGroupMembers(token, created.data.id)
        expect(membersAfter2).toEqual([sklA])

        // Skills page renders group header and member cards
        await page.goto(ROUTES.skills)
        await expect(page.locator('#main-content')).toBeVisible()
        await page.getByRole('button', { name: new RegExp(`E2E Group ${RUN_TAG}`) }).click()
        await expect(page.getByRole('heading', { name: `E2E Skill A ${RUN_TAG}` })).toBeVisible()
      } finally {
        await deleteGroup(token, created.data.id)
      }
    } finally {
      await deleteSkill(token, sklA)
      await deleteSkill(token, sklB)
    }
  })
})
