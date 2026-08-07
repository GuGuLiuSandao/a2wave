/**
 * 附件上传的共享核心，供三个入口复用（避免逻辑分叉）：
 *   - POST /api/attachments              平台用户 JWT（Web 测试界面）
 *   - POST /api/gateway/:agentId/attachments   Agent API Key（外部集成）
 *   - POST /api/oauth/:agentId/attachments     OAuth/IdP JWT
 * 全都：按 settings 动态 bodyLimit → 校验大小/类型 → 落暂存区 → 返回 token。
 */
import { extname } from 'node:path'
import { ATTACHMENT_MIME_BY_EXT } from '@a2wave/shared'
import type { Context } from 'hono'
import { bodyLimit } from 'hono/body-limit'
import { stageAttachment } from './attachment-storage.js'
import { getAttachmentSettings } from './settings.js'

// multipart 开销余量（boundary/header）：在 maxFileSizeBytes 之上再放宽一点，避免正好卡上限
// 的文件被 body 限制误杀；同时给一个硬上限防内存耗尽（不随设置无限放大）。
const MULTIPART_OVERHEAD_BYTES = 64 * 1024
const ATTACHMENT_UPLOAD_HARD_CAP = 200 * 1024 * 1024

/** 按当前 settings 动态限制上传 body，替代被豁免的全局 10MB。挂在各上传路由的 authMiddleware 后。 */
export async function attachmentBodyLimit(c: Context, next: () => Promise<void>) {
  const max = Math.min(
    getAttachmentSettings().maxFileSizeBytes + MULTIPART_OVERHEAD_BYTES,
    ATTACHMENT_UPLOAD_HARD_CAP,
  )
  return bodyLimit({ maxSize: max })(c, next)
}

/**
 * 处理一次附件上传：读 multipart file → 校验 → 落盘 → 返回 JSON 响应。
 * uploaderId 用于 GET 取回时的 owner 绑定鉴权（外部渠道可传 agent id 之类的稳定标识）。
 */
export async function handleAttachmentUpload(c: Context, uploaderId?: string): Promise<Response> {
  const { maxFileSizeBytes, allowedExtensions } = getAttachmentSettings()

  const formData = await c.req.formData()
  const file = formData.get('file')

  if (!file || !(file instanceof File)) {
    return c.json({ error: 'No file provided' }, 400)
  }
  if (file.size > maxFileSizeBytes) {
    return c.json(
      { error: `File too large (max ${Math.floor(maxFileSizeBytes / 1024 / 1024)}MB)` },
      413,
    )
  }
  const ext = extname(file.name).toLowerCase().replace(/^\./, '')
  if (!allowedExtensions.has(ext)) {
    return c.json(
      { error: `Invalid file type. Allowed: ${[...allowedExtensions].join(', ')}` },
      400,
    )
  }

  const bytes = Buffer.from(await file.arrayBuffer())
  // MIME 以**扩展名**为准（扩展名已过白名单校验），不信任客户端自报的 file.type——否则上传
  // .pdf 但 file.type=image/png 会把非图片当图片注入 prompt / 以图片 Content-Type 内联回显
  // （review [P1]）。扩展名映射不到时才退回 file.type。
  const mimeType = ATTACHMENT_MIME_BY_EXT[ext] ?? file.type ?? 'application/octet-stream'
  const { token, meta } = await stageAttachment(bytes, file.name, mimeType, uploaderId)

  return c.json({
    data: { token, name: meta.name, mimeType: meta.mimeType, size: meta.size },
  })
}
