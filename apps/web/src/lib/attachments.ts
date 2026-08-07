import { isAttachmentImageExt } from '@a2wave/shared'

/** 历史附件 ref（后端从 runSteps.input.attachments 回传）。A2A 的 bytes/uri 源无 token。 */
export interface HistoryAttachmentRef {
  /** REST/gateway/oauth 附件有 token；A2A FilePart 落审计时无 token（则无法回显预览）。 */
  token?: string
  name: string
  mimeType: string
  size?: number
}

/** 按 token 拼出鉴权 GET 端点 URL；浏览器自动带会话 cookie，可直接塞进 <img src>。 */
export function attachmentPreviewUrl(token: string): string {
  return `/api/attachments/${encodeURIComponent(token)}`
}

/** 是否图片（走缩略图预览而非文件 chip）。 */
export function isImageAttachment(ref: { name: string; mimeType: string }): boolean {
  if (ref.mimeType.startsWith('image/')) return true
  const ext = ref.name.split('.').pop() ?? ''
  return isAttachmentImageExt(ext)
}

/**
 * 把历史 ref 转成会话内渲染用的快照：图片且有 token 才给指向 GET 端点的 previewUrl。
 * 无 token（A2A bytes/uri）→ previewUrl undefined，AttachmentChip 降级为文件名 chip，
 * 避免请求 /api/attachments/undefined。
 */
export function historyRefToSentAttachment(ref: HistoryAttachmentRef): {
  name: string
  mimeType: string
  previewUrl?: string
} {
  return {
    name: ref.name,
    mimeType: ref.mimeType,
    previewUrl: ref.token && isImageAttachment(ref) ? attachmentPreviewUrl(ref.token) : undefined,
  }
}
