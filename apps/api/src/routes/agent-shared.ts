import { eq } from 'drizzle-orm'
/**
 * Public agent export download via share token (no auth required).
 */
import { Hono } from 'hono'
import { db } from '../db/client.js'
import { agents } from '../db/schema.js'
import { buildExportZip } from '../lib/agent-export.js'
import { validateShareToken } from '../lib/agent-share.js'

const app = new Hono()

/** GET /agents/shared/:token — 通过分享 token 下载 Agent 导出 ZIP（无需认证） */
app.get('/:token', async (c) => {
  const { token } = c.req.param()
  const agentId = validateShareToken(token)
  if (!agentId) {
    return c.json({ error: 'The share link is invalid or has expired' }, 404)
  }

  const agent = (await db.select().from(agents).where(eq(agents.id, agentId)).limit(1))[0]
  if (!agent) {
    return c.json({ error: 'Agent not found' }, 404)
  }

  try {
    const zipBuffer = await buildExportZip(agentId, { kind: 'public' })
    const filename = `${agent.name.replace(/[^a-zA-Z0-9\u4e00-\u9fff_-]/g, '_')}-export.zip`

    // 零拷贝 view：避免大 zip 拷贝；as ArrayBuffer 修正 BodyInit 的类型窄化
    const body = new Uint8Array(
      zipBuffer.buffer as ArrayBuffer,
      zipBuffer.byteOffset,
      zipBuffer.byteLength,
    )
    return new Response(body, {
      headers: {
        'Content-Type': 'application/zip',
        'Content-Disposition': `attachment; filename="${encodeURIComponent(filename)}"`,
        'Content-Length': String(zipBuffer.length),
      },
    })
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Export failed'
    return c.json({ error: message }, 500)
  }
})

export default app
