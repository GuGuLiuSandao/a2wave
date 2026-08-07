/**
 * 附件端点。
 *
 * POST /api/attachments 收单个文件落暂存区，返回不透明 token（两步上传第一步）；
 * GET /api/attachments/:token 按 token 取回暂存字节（鉴权，inline），供历史/运行记录
 * 里回显图片预览——发送当次的预览走前端本地 URL.createObjectURL，历史回看则走此端点。
 *
 * 与 /api/uploads（512KB favicon 图标永久公开存储 + SVG 消毒）刻意分开：本端点面向
 * 聊天/invoke 的图片与文档，上限/白名单从 Settings.attachments 读取。字节只在暂存 TTL
 * （settings.attachments.stagingTtlHours，默认 7 天）内可取；过期后 GET 返回 404，前端
 * 优雅降级为文件名 chip。
 */
import { createReadStream } from 'node:fs'
import { extname } from 'node:path'
import { Readable } from 'node:stream'
import { ATTACHMENT_IMAGE_EXTS, ATTACHMENT_MIME_BY_EXT } from '@a2wave/shared'
import { Hono } from 'hono'
import { canAccessAttachment } from '../lib/attachment-access.js'
import { resolveStagedAttachment } from '../lib/attachment-storage.js'
import { attachmentBodyLimit, handleAttachmentUpload } from '../lib/attachment-upload.js'
import { authMiddleware } from '../middleware/auth-middleware.js'

const app = new Hono()

app.post('/', authMiddleware, attachmentBodyLimit, (c) => {
  const uploaderId = c.get('userId' as never) as string | undefined
  return handleAttachmentUpload(c, uploaderId)
})

// 可安全 inline 直出的图片 MIME 白名单：从 shared 的单一来源（图片扩展名 → mime）派生，
// 不再本地硬编码一份。绝不用用户可控的 meta.mimeType。
const INLINE_IMAGE_MIME: Record<string, string> = Object.fromEntries(
  ATTACHMENT_IMAGE_EXTS.map((ext) => [ext, ATTACHMENT_MIME_BY_EXT[ext]]),
)

// GET /api/attachments/:token — 取回暂存字节（鉴权）。
// 安全：**绝不**回显用户可控的 meta.mimeType（可被设成 text/html + <script> → 同源 stored
// XSS）。Content-Type 一律从落盘文件名的**扩展名**派生：图片扩展名走 image/* 白名单 + inline
// 预览；其余一律 application/octet-stream + attachment（强制下载不渲染）。再叠加 nosniff +
// CSP sandbox 兜底。TTL 内可取；过期/不存在/token 非法 → 404，前端降级为文件名 chip。
app.get('/:token', authMiddleware, async (c) => {
  const { token } = c.req.param()
  const staged = await resolveStagedAttachment(token)
  if (!staged) {
    return c.json({ error: 'Attachment not found or expired' }, 404)
  }

  // owner 绑定：上传者本人 / admin / 引用该 token 的 run 所属 Agent 的成员 才可取回。
  if (!(await canAccessAttachment(c, token, staged.meta))) {
    return c.json({ error: 'Forbidden' }, 403)
  }

  const ext = extname(staged.meta.name).toLowerCase().replace(/^\./, '')
  const imageMime = INLINE_IMAGE_MIME[ext]
  const contentType = imageMime ?? 'application/octet-stream'
  const disposition = imageMime ? 'inline' : 'attachment'
  const encodedName = encodeURIComponent(staged.meta.name)

  const webStream = Readable.toWeb(createReadStream(staged.path)) as ReadableStream
  return c.newResponse(webStream, 200, {
    'Content-Type': contentType,
    'Content-Disposition': `${disposition}; filename*=UTF-8''${encodedName}`,
    ...(staged.meta.size ? { 'Content-Length': String(staged.meta.size) } : {}),
    // 防嗅探 + sandbox 兜底：即使某天 content-type 派生出错，也不在应用源执行任何脚本。
    'X-Content-Type-Options': 'nosniff',
    'Content-Security-Policy': "sandbox; default-src 'none'",
    'Cache-Control': 'private, max-age=300',
  })
})

export default app
