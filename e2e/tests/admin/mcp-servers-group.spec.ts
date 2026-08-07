import { expect, test } from '@playwright/test'
import { deleteMcpServer, getAdminToken } from '../../utils/api-helpers'
import { loginAsAdmin } from '../../utils/auth'
import { API_BASE, ROUTES } from '../../utils/test-constants'

// Timestamp后缀保证并行/多次跑时每个用例名字唯一，避免 getByText 命中遗留数据
const RUN_TAG = `${Date.now()}`

test.beforeEach(async ({ page }) => {
  await loginAsAdmin(page)
})

test.describe('MCP Servers: group type', () => {
  test('MCP Servers list page loads', async ({ page }) => {
    await page.goto(ROUTES.mcpServers)
    await expect(page.locator('#main-content')).toBeVisible()
    await expect(page.getByText('MCP').first()).toBeVisible()
  })

  test('create a group-type MCP server via the Add Group modal, verify in list, then clean up', async ({
    page,
  }) => {
    const serverName = `E2E Group UI ${RUN_TAG}`

    // ----------------------------------------------------------------
    // 1. Navigate to MCP Servers list page
    // ----------------------------------------------------------------
    await page.goto(ROUTES.mcpServers)
    await expect(page.locator('#main-content')).toBeVisible()

    // ----------------------------------------------------------------
    // 2. Open the "添加 Group" modal (mcpServers.addGroup). Group is now a
    //    top-level entry point, not a transport type inside the server form.
    // ----------------------------------------------------------------
    await page.getByRole('button', { name: '添加 Group' }).click()

    // The modal shows the Group Configuration section outright — no transport switch.
    await expect(page.getByText('Group 配置')).toBeVisible()

    // ----------------------------------------------------------------
    // 3. Fill in the group name
    // ----------------------------------------------------------------
    const nameInput = page.getByPlaceholder('MCP Server 名称')
    await nameInput.fill(serverName)

    // ----------------------------------------------------------------
    // 4. Add a group key named "default" (placeholder "GroupKey 名称")
    // ----------------------------------------------------------------
    const groupKeyInput = page.getByPlaceholder('GroupKey 名称')
    await groupKeyInput.fill('default')
    await groupKeyInput.press('Enter')

    // The "default" tab button should now appear
    await expect(page.getByRole('button', { name: /^default/ })).toBeVisible()

    // ----------------------------------------------------------------
    // 5. Add an inline backend ("添加" = mcpServerDetail.addInline)
    // ----------------------------------------------------------------
    await page.getByRole('button', { name: '添加', exact: true }).click()

    // placeholder: "后端名称（如 service-a）"
    const backendNameInput = page.getByPlaceholder('后端名称（如 service-a）')
    await expect(backendNameInput).toBeVisible()
    await backendNameInput.fill('test-backend')

    // stdio is the default backend type; fill its command (placeholder "例如 npx、uvx、node")
    const commandInput = page.getByPlaceholder('例如 npx、uvx、node')
    await expect(commandInput).toBeVisible()
    await commandInput.fill('echo')

    // ----------------------------------------------------------------
    // 6. Save the form — button text: "创建 Group" (mcpServerDetail.createGroup)
    // ----------------------------------------------------------------
    await page.getByRole('button', { name: '创建 Group' }).click()

    // ----------------------------------------------------------------
    // 7. The modal closes and the new group card appears in the list
    //    (the page no longer navigates to a detail route).
    // ----------------------------------------------------------------
    await expect(page.getByText('Group 配置')).toBeHidden()
    await expect(page.getByRole('heading', { name: serverName })).toBeVisible()

    const card = page.getByRole('heading', { name: serverName }).locator('..').locator('..')
    await expect(card.locator('p', { hasText: /^Group$/ })).toBeVisible()

    // ----------------------------------------------------------------
    // 8. Clean up — look up the id via API and delete
    // ----------------------------------------------------------------
    const token = await getAdminToken()
    const listRes = await fetch(`${API_BASE}/api/mcp-servers?page=1&pageSize=100`, {
      headers: { Authorization: `Bearer ${token}` },
    })
    const listBody = (await listRes.json()) as { data: Array<{ id: string; name: string }> }
    const created = listBody.data.find((s) => s.name === serverName)
    if (created) await deleteMcpServer(token, created.id)
  })

  test('verify group server type badge shows "Group" in list after API creation', async ({
    page,
  }) => {
    const serverName = `E2E Group API ${RUN_TAG}`
    // Create the server directly via API so we can focus on the list-page rendering
    const token = await getAdminToken()

    let serverId: string | null = null
    try {
      const { id } = await (async () => {
        const res = await fetch(`${API_BASE}/api/mcp-servers`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
          body: JSON.stringify({
            name: serverName,
            type: 'group',
            groupConfig: {
              backends: {
                default: [{ mode: 'inline', name: 'stub', type: 'stdio', command: 'echo' }],
              },
            },
          }),
        })
        if (!res.ok) throw new Error(`createMcpServer failed: ${res.status}`)
        const body = (await res.json()) as { data: { id: string } }
        return body.data
      })()
      serverId = id

      // Navigate to the list page and verify
      await page.goto(ROUTES.mcpServers)
      await expect(page.locator('#main-content')).toBeVisible()

      // 通过 heading 定位唯一卡片，再断言其 CardDescription（<p> 节点）为 "Group"
      const heading = page.getByRole('heading', { name: serverName })
      await expect(heading).toBeVisible()
      const card = heading.locator('..').locator('..')
      await expect(card.locator('p', { hasText: /^Group$/ })).toBeVisible()
    } finally {
      if (serverId) {
        await deleteMcpServer(token, serverId)
      }
    }
  })
})
