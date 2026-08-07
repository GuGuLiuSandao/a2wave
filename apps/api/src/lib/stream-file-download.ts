import { createReadStream } from 'node:fs'
import { Readable } from 'node:stream'
import type { Context } from 'hono'

/**
 * 以附件形式流式返回磁盘文件。
 *
 * artifacts 与 run 全量日志的下载端点共用：统一 Readable.toWeb 流式写法与
 * Content-Disposition 的 filename 编码（encodeURIComponent，防 header 注入 /
 * 非 ASCII 文件名截断），改下载头只需改这一处。
 */
export function streamFileDownload(
  c: Context,
  path: string,
  opts: { filename: string; mimeType: string; size?: number | null },
): Response {
  const webStream = Readable.toWeb(createReadStream(path)) as ReadableStream
  return c.newResponse(webStream, 200, {
    'Content-Type': opts.mimeType,
    'Content-Disposition': `attachment; filename="${encodeURIComponent(opts.filename)}"`,
    ...(opts.size ? { 'Content-Length': String(opts.size) } : {}),
  })
}
