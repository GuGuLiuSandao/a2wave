/**
 * 渠道无关的附件落盘 + prompt 注入工具。
 *
 * 抽取飞书既有约定（materialize → 绝对路径 → prompt 文本提示），让 REST / gateway /
 * OAuth / A2A 四条渠道产出与飞书**逐字节一致**的提示，底层 CLI 据此读盘。附件落到 Agent
 * 运行时 tmp 目录（非 workDir），run `finally` 清理；暂存副本另由 TTL sweeper 回收。
 *
 * 提示字符串必须与 feishu-service.ts 保持一致（`[图片 N]\n图片路径：`、`[文件] <name>\n
 * 文件路径：`、以 `\n\n---\n` 拼接）——有 golden 测试锁定此契约。
 */
import { randomUUID } from 'node:crypto'
import { lookup } from 'node:dns/promises'
import { existsSync, mkdirSync } from 'node:fs'
import { copyFile, rm, rmdir, writeFile } from 'node:fs/promises'
import { basename, dirname, extname, join } from 'node:path'
import { ATTACHMENT_MIME_BY_EXT, isAttachmentImageExt } from '@a2wave/shared'
import { Agent as UndiciAgent } from 'undici'
import { resolveAgentRuntimeTmpDir, sanitizePathSegment } from '../engine/runtime-context.js'
import { recordAttachmentRefs } from './attachment-access.js'
import { resolveStagedAttachment, safeDiskFileName } from './attachment-storage.js'
import { logger } from './logger.js'
import { getAttachmentSettings } from './settings.js'
import {
  UnsafeUrlError,
  createPinnedLookup,
  isPrivateOrReserved,
  safeFetch,
} from './url-safety-core.js'

const dnsLookup = lookup

/** 一份已落盘、可注入 prompt 的附件。 */
export interface MaterializedAttachment {
  path: string
  name: string
  mimeType: string
  isImage: boolean
  /** 实际用到的暂存 token（有则可登记反查表供历史预览鉴权）。 */
  token?: string
  /** 外部 http(s) 源的原始 uri（无 token 时 rerun 靠它重新抓取；staging uri 走 token 不落此字段）。 */
  uri?: string
}

/** 历史审计用的紧凑 ref（存 runSteps.input.attachments，供前端渲染 chip / 预览）。 */
export interface AttachmentAuditRef {
  token?: string
  /** 外部 uri 源保留原始 uri（token 之外唯一可重放的定位符，review：rerun 静默丢 uri 附件）。 */
  uri?: string
  name: string
  mimeType: string
}

/** 各渠道产出的输入变体。 */
export type AttachmentSource =
  | { kind: 'token'; token: string; name?: string; mimeType?: string }
  | { kind: 'uri'; uri: string; name?: string; mimeType?: string }
  | { kind: 'bytes'; bytes: string; name?: string; mimeType?: string }

/**
 * 判定是否图片（图片可预览、走 [图片] 提示）。**以扩展名为准**——扩展名是上传端点白名单
 * 校验的真实依据，而 mimeType 是客户端自报、可伪造（上传 .pdf 但 file.type=image/png 会
 * 把非图片当图片注入 prompt，误导 agent，review [P1]）。仅当文件无扩展名时才回退看 MIME
 * （A2A bytes 的 name 可能无扩展名，此时 MIME 是唯一线索）。 */
function detectIsImage(name: string, mimeType: string | undefined): boolean {
  const ext = extname(name)
  if (ext) return isAttachmentImageExt(ext)
  return mimeType?.startsWith('image/') ?? false
}

/** mime → 首个匹配扩展名（从 shared 单一来源反推）。 */
const EXT_BY_MIME: Record<string, string> = Object.fromEntries(
  Object.entries(ATTACHMENT_MIME_BY_EXT)
    .reverse() // 让 jpg 优先于 jpeg 之类；只取首个即可
    .map(([ext, mime]) => [mime, ext]),
)

/**
 * name 无扩展名时，用 mimeType 补一个允许类型的扩展名——A2A FilePart 的 name 可选，
 * `{name:'report', mimeType:'application/pdf'}` 应被识别为 report.pdf 而非被白名单误拒。
 * 无 name 或 mime 推不出扩展名时退回 'attachment'（仍会被白名单拦，符合 fail-closed）。
 */
function nameWithExtFromMime(name: string | undefined, mimeType: string): string {
  const base = name ?? 'attachment'
  if (extname(base)) return base // 已有扩展名，不动
  const ext = EXT_BY_MIME[mimeType.split(';')[0]?.trim()]
  return ext ? `${base}.${ext}` : base
}

/**
 * 把一批附件源落盘到 `<runtimeTmpDir>/attachments/<runId>/<uuid>/<safeName>`。
 * 单文件解析/抓取失败 → 跳过 + warn（飞书语义，不因单个附件让整个 run 失败）。
 */
export async function materializeAttachments(
  sources: AttachmentSource[],
  opts: {
    agentId: string
    runId: string
    /** 消费者身份，用于 token 消费鉴权（须 == 上传者 uploaderId）。 */
    consumerId: string | undefined
    maxBytes: number
    maxCount: number
    allowedExtensions: Set<string>
  },
): Promise<{ attachments: MaterializedAttachment[]; rootDir: string }> {
  // 每次 materialize 用独立 uuid 目录做根，cleanup 只删这一个——避免同 chatId 并发轮
  // 复用同一 runId 时，一轮 cleanup 递归删掉另一轮仍在用的目录（review [P1]）。
  const rootDir = join(
    resolveAgentRuntimeTmpDir(opts.agentId),
    'attachments',
    sanitizePathSegment(opts.runId),
    randomUUID(),
  )
  const attachments: MaterializedAttachment[] = []
  if (sources.length === 0) return { attachments, rootDir }

  // 数量上限：与 REST 渠道的 attachmentsInputSchema 对齐，防 A2A 无界 FilePart 撑爆磁盘。
  const capped = sources.slice(0, opts.maxCount)
  if (capped.length < sources.length) {
    logger.warn(
      { received: sources.length, cap: opts.maxCount },
      'Attachment count over limit, extras dropped',
    )
  }

  // rootDir 本身已唯一（含 per-call uuid），直接作为落盘目录。
  const targetDir = rootDir
  mkdirSync(targetDir, { recursive: true })

  // 用序号前缀避免消毒后同名互相覆盖（如两个 报告.pdf → 同一 safeName）。
  let index = 0
  for (const source of capped) {
    index += 1
    try {
      const resolved = await resolveSourceBytes(source, opts.maxBytes, opts.consumerId)
      if (!resolved) continue
      // 类型白名单：A2A 的 bytes/uri 不走上传端点校验，这里统一收口，与 REST 一致。
      if (!isExtensionAllowed(resolved.name, opts.allowedExtensions)) {
        logger.warn(
          { name: resolved.name, source: describeSource(source) },
          'Attachment extension not allowed, skipping',
        )
        continue
      }
      const safeName = `${index}-${safeDiskFileName(resolved.name)}`
      const path = join(targetDir, safeName)
      await writeOrCopy(resolved, path)
      attachments.push({
        path,
        name: resolved.name,
        mimeType: resolved.mimeType,
        isImage: detectIsImage(resolved.name, resolved.mimeType),
        ...(resolved.token ? { token: resolved.token } : {}),
        // 外部 uri 源（未解析出 staging token）保留原始 uri——审计 ref 里没有 token 时
        // 这是 rerun 唯一可重放的定位符（review：token-only 过滤静默丢 uri 附件）。
        ...(source.kind === 'uri' && !resolved.token ? { uri: source.uri } : {}),
      })
    } catch (err) {
      logger.warn(
        { err, source: describeSource(source) },
        'Failed to materialize attachment, skipping',
      )
    }
  }

  return { attachments, rootDir }
}

/**
 * 扩展名是否在白名单内。fail-closed：空白名单 = 拒绝一切（与上传端点 `.has()` 恒 false
 * 语义一致）——管理员清空白名单本意是收紧，绝不能反而对 A2A bytes/uri 放行任意类型。
 */
function isExtensionAllowed(name: string, allowed: Set<string>): boolean {
  if (allowed.size === 0) return false
  const ext = extname(name).replace(/^\./, '').toLowerCase()
  return allowed.has(ext)
}

interface ResolvedBytes {
  name: string
  mimeType: string
  /** token/uri 已在磁盘上时给出源路径（拷贝而非重写）；否则给出内存字节。 */
  copyFrom?: string
  bytes?: Buffer
  /** 实际用到的暂存 token（token 源 + uri 指向自家 staging 时有值）；用于登记反查表。 */
  token?: string
}

async function resolveSourceBytes(
  source: AttachmentSource,
  maxBytes: number,
  consumerId: string | undefined,
): Promise<ResolvedBytes | null> {
  if (source.kind === 'token') {
    const staged = await resolveStagedAttachment(source.token)
    if (!staged) {
      logger.warn({ token: source.token }, 'Staged attachment not found for token, skipping')
      return null
    }
    // 消费鉴权：token 只能被上传者本人消费。否则任何拿到 token 的用户都能在自己的 Agent
    // 里引用它、把文件复制过来，且 recordAttachmentRefs 会把攻击者的 run 记为合法引用，
    // 反过来绕过 GET 端点的 owner 绑定（review [P1]）。uploaderId 缺失（老数据）时保守拒绝。
    if (!staged.meta.uploaderId || staged.meta.uploaderId !== consumerId) {
      logger.warn(
        { token: source.token, consumerId, uploaderId: staged.meta.uploaderId },
        'Attachment token consumed by non-uploader, skipping',
      )
      return null
    }
    // 用**落盘时的真实 metadata**做大小/类型校验，不信任请求里的 name/mimeType 覆盖——
    // 否则管理员收紧策略后，旧 token 仍可改名绕过（review [P2]）。
    if (staged.meta.size > maxBytes) {
      logger.warn(
        { token: source.token, size: staged.meta.size, maxBytes },
        'Staged attachment exceeds current size limit, skipping',
      )
      return null
    }
    return {
      name: staged.meta.name,
      mimeType: staged.meta.mimeType,
      copyFrom: staged.path,
      token: source.token,
    }
  }

  if (source.kind === 'bytes') {
    const buf = Buffer.from(source.bytes, 'base64')
    if (buf.length > maxBytes) {
      logger.warn({ size: buf.length, maxBytes }, 'Inline attachment over size limit, skipping')
      return null
    }
    const mimeType = source.mimeType ?? 'application/octet-stream'
    return {
      // A2A FilePart 的 name 可选；无扩展名时从 mimeType 补一个，否则会被扩展名白名单误拒
      // （合法的 {name:'report', mimeType:'application/pdf'} 应通过）。
      name: nameWithExtFromMime(source.name, mimeType),
      mimeType,
      bytes: buf,
    }
  }

  // kind: 'uri' — 自家 staging token URL 走 token 分支（同样受消费鉴权约束）；外部 http(s)
  // 经 SSRF 收口抓取。
  const tokenFromUri = extractStagingToken(source.uri)
  if (tokenFromUri) {
    return resolveSourceBytes(
      { ...source, kind: 'token', token: tokenFromUri },
      maxBytes,
      consumerId,
    )
  }
  return fetchExternalUri(source, maxBytes)
}

/** 外部附件抓取超时（毫秒）。慢响应会占着已抢到的并发槽，必须有硬超时。 */
const EXTERNAL_FETCH_TIMEOUT_MS = 15_000

/**
 * DNS-rebinding 缓解：safeFetch 的 per-hop 校验只拦 IP 字面量，`127.0.0.1.nip.io` 这类解析
 * 到内网的合法域名会绕过。这里对**目标 hostname 做一次 DNS 解析**，任一解析地址落私网/保留
 * 段即拒绝，堵住报告的可利用向量。返回 true=安全。
 */
/** 解析 hostname，返回全部**校验通过（公网 unicast）**的 IP；任一落私网/保留段即返回 null（拒绝）。 */
async function resolvePublicIps(
  uri: string,
): Promise<{ address: string; family: number }[] | null> {
  const host = new URL(uri).hostname
  if (isPrivateOrReserved(host)) return null // IP 字面量 / 已知保留名
  try {
    const results = await dnsLookup(host, { all: true })
    if (results.length === 0) return null
    if (results.some((r) => isPrivateOrReserved(r.address))) return null
    return results
  } catch {
    return null // 解析失败 → 保守拒绝
  }
}

async function fetchExternalUri(
  source: { uri: string; name?: string; mimeType?: string },
  maxBytes: number,
): Promise<ResolvedBytes | null> {
  // DNS-rebinding 防护：先解析并校验 IP，再把这些**已校验 IP 钉进连接层**——用一个只返回这些
  // IP 的自定义 lookup 的 undici Agent，让 fetch 连到的正是我们校验过的地址，消除「校验时解析
  // 公网、连接时再解析内网」的 TOCTOU 窗口（review [P1]）。Host/SNI 仍是原 hostname。
  const validatedIps = await resolvePublicIps(source.uri)
  if (!validatedIps) {
    logger.warn({ uri: source.uri }, 'Attachment URI resolves to private/reserved, skipping')
    return null
  }
  const pinnedDispatcher = new UndiciAgent({
    connect: {
      // Return only the validated addresses; never resolve the hostname again.
      lookup: createPinnedLookup(validatedIps),
    },
  })
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), EXTERNAL_FETCH_TIMEOUT_MS)
  try {
    // maxRedirects: 0 —— 不跟随重定向（重定向后 host 不再过校验，见 [0]）。dispatcher 钉住已校验 IP。
    const res = await safeFetch(source.uri, {
      signal: controller.signal,
      maxRedirects: 0,
      dispatcher: pinnedDispatcher,
    } as Parameters<typeof safeFetch>[1])
    if (!res.ok || !res.body) {
      logger.warn({ uri: source.uri, status: res.status }, 'Attachment fetch non-2xx, skipping')
      return null
    }
    // 流式读取并累计字节数，超限即 abort——不先把整个响应读进内存（防超大响应打爆内存）。
    const chunks: Buffer[] = []
    let total = 0
    for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
      total += chunk.length
      if (total > maxBytes) {
        logger.warn({ uri: source.uri, maxBytes }, 'Fetched attachment over limit, aborting')
        controller.abort()
        return null
      }
      chunks.push(Buffer.from(chunk))
    }
    const mimeType =
      source.mimeType ??
      res.headers.get('content-type')?.split(';')[0]?.trim() ??
      'application/octet-stream'
    // URL 路径常无扩展名（如 `/download?id=123` 或尾斜杠）→ basename 得空/无扩展名，
    // 会被扩展名白名单误拒即使 content-type 合法。用响应 MIME 补一个允许类型的扩展名
    // （review [P1]），与 A2A bytes 分支同源逻辑。
    const rawName = source.name ?? (basename(new URL(source.uri).pathname) || 'attachment')
    const name = nameWithExtFromMime(rawName, mimeType)
    return { name, mimeType, bytes: Buffer.concat(chunks) }
  } catch (err) {
    if (err instanceof UnsafeUrlError) {
      logger.warn({ uri: source.uri }, 'Attachment URI blocked by SSRF guard, skipping')
      return null
    }
    if (err instanceof Error && err.name === 'AbortError') {
      logger.warn({ uri: source.uri }, 'Attachment fetch timed out / aborted, skipping')
      return null
    }
    throw err
  } finally {
    clearTimeout(timer)
    // 释放 pinned dispatcher 的连接池，避免泄漏（undici Agent 不主动回收）。
    await pinnedDispatcher.close().catch(() => {})
  }
}

/** 若 uri 指向本服务 /api/attachments 的 token，抽出 token 走本地暂存路径。 */
function extractStagingToken(uri: string): string | null {
  const m = uri.match(/\/api\/attachments\/(att_[A-Za-z0-9_-]+)/)
  return m ? m[1] : null
}

async function writeOrCopy(resolved: ResolvedBytes, path: string): Promise<void> {
  if (resolved.copyFrom) {
    await copyFile(resolved.copyFrom, path)
  } else if (resolved.bytes) {
    await writeFile(path, resolved.bytes)
  }
}

function describeSource(source: AttachmentSource): Record<string, unknown> {
  if (source.kind === 'token') return { kind: 'token', token: source.token }
  if (source.kind === 'uri') return { kind: 'uri', uri: source.uri }
  return { kind: 'bytes', size: source.bytes.length }
}

// ── Prompt 提示构造（与 feishu-service.ts 逐字节一致）─────────────────────────────
/** 图片提示：单张 `[图片]`，多张 `[图片 N]`；每张 `\n图片路径：<abs>`，块间 `\n\n`。 */
export function buildImageHint(imagePaths: string[]): string {
  return imagePaths
    .map((imagePath, index) => {
      const label = imagePaths.length > 1 ? `[图片 ${index + 1}]` : '[图片]'
      return `${label}\n图片路径：${imagePath}`
    })
    .join('\n\n')
}

/** 文件提示：`[文件] <basename>\n文件路径：<abs>`（无名时 `[文件]`）。 */
export function buildFileHint(name: string | undefined, path: string): string {
  const n = name?.trim()
  const label = n ? `[文件] ${basename(n)}` : '[文件]'
  return `${label}\n文件路径：${path}`
}

/**
 * 把已落盘附件合并进 prompt：先文件后图片（对齐飞书顺序），每段以 `\n\n---\n` 拼到基文。
 */
export function mergeAttachmentsIntoPrompt(
  baseText: string,
  materialized: MaterializedAttachment[],
): string {
  let text = baseText
  const files = materialized.filter((a) => !a.isImage)
  const images = materialized.filter((a) => a.isImage)

  for (const file of files) {
    const hint = buildFileHint(file.name, file.path)
    text = text ? `${text}\n\n---\n${hint}` : hint
  }
  if (images.length > 0) {
    const hint = buildImageHint(images.map((i) => i.path))
    text = text ? `${text}\n\n---\n${hint}` : hint
  }
  return text
}

/**
 * 删除本轮落盘目录（run finally 调用）。rootDir 形如 `.../<runId>/<uuid>`，只递归删这个
 * per-call uuid 子树；父级 runId 目录仅在**为空时** rmdir（其它并发轮的 uuid 子目录还在
 * 则 rmdir 失败并被吞掉），因此不会误删同 runId 的并发轮附件。
 */
export async function cleanupMaterializedRoot(rootDir: string): Promise<void> {
  await rm(rootDir, { recursive: true, force: true }).catch(() => {})
  await rmdir(dirname(rootDir)).catch(() => {})
}

/**
 * 各渠道复用：解析 refs → 落盘 → 合并 prompt，返回合并文本 + 清理根目录。
 * refs 为空时不落盘，rootDir 返回 null（调用方无需清理）。
 */
export async function materializeForRun(opts: {
  agentId: string
  runId: string
  message: string
  sources: AttachmentSource[] | undefined
  /** 消费者身份（token 消费鉴权用，须 == 上传者）。REST=userId；gateway/oauth/A2A=`agent:<id>`。 */
  consumerId: string | undefined
}): Promise<{ mergedPrompt: string; rootDir: string | null; materialized: AttachmentAuditRef[] }> {
  if (!opts.sources || opts.sources.length === 0) {
    // 快路径：无附件时不读设置、不落盘（覆盖绝大多数 run 与既有测试）。
    return { mergedPrompt: opts.message, rootDir: null, materialized: [] }
  }
  // 契约：本函数**永不抛错**。四条渠道都在抢到并发槽（run 已置 running）之后、生命周期
  // try 之前调用它——若这里抛（磁盘满 ENOSPC / EACCES / 设置读取 SQLITE_BUSY / mkdir 失败），
  // finishRunError/scheduleNext 都不会执行，run 永远卡 running、槽不释放 → 队列死锁。所以基础
  // 设施级错误一律降级为「按纯文本执行」，与 runWithLifecycle「never throws」同构。
  let rootDir: string | null = null
  try {
    const settings = getAttachmentSettings()
    const result = await materializeAttachments(opts.sources, {
      agentId: opts.agentId,
      runId: opts.runId,
      consumerId: opts.consumerId,
      maxBytes: settings.maxFileSizeBytes,
      maxCount: settings.maxFilesPerRequest,
      allowedExtensions: settings.allowedExtensions,
    })
    rootDir = result.rootDir
    if (result.attachments.length === 0) {
      // 提供了附件但一个都没落盘（超限/类型不符/token 过期等，每条已 warn）。这里按纯文本
      // 继续（保并发槽不泄漏），但显式再记一条——避免「用户传了图、Agent 却说没看到图」的
      // 静默数据丢失只散在 per-file warn 里难以排查。v1 已知限制：不因附件被拒回 4xx。
      logger.warn(
        { runId: opts.runId, sourceCount: opts.sources.length },
        'All attachments dropped (rejected/expired); run proceeds text-only',
      )
      if (existsSync(rootDir)) await cleanupMaterializedRoot(rootDir)
      return { mergedPrompt: opts.message, rootDir: null, materialized: [] }
    }
    // 单点登记 token→run 反查（供历史预览成员鉴权）。放这里覆盖全部渠道（即时/排队/A2A），
    // 且用**实际解析到的** token（含 A2A uri→staging token）——避免各写入点各自登记的遗漏。
    const tokens = result.attachments.map((a) => a.token).filter((t): t is string => Boolean(t))
    // Awaited: the caller dispatches the run as soon as this resolves, and the
    // history/preview endpoint authorises a token by looking up exactly these
    // rows. Left unawaited, a member opening the attachment before the insert
    // lands is denied, and the rejection escapes the try/catch below (which is
    // the degrade-to-text-only contract) as an unhandled rejection.
    await recordAttachmentRefs(opts.runId, tokens)
    return {
      mergedPrompt: mergeAttachmentsIntoPrompt(opts.message, result.attachments),
      rootDir,
      // 只回**实际落盘**的附件供各渠道写 runSteps.input.attachments——绝不用请求里的原始 refs，
      // 否则被拒/过期的附件仍在历史里渲染 chip（预览 404），误导用户（review [P2]）。
      materialized: result.attachments.map((a) => ({
        ...(a.token ? { token: a.token } : {}),
        ...(a.uri ? { uri: a.uri } : {}),
        name: a.name,
        mimeType: a.mimeType,
      })),
    }
  } catch (err) {
    logger.error({ err, runId: opts.runId }, 'materializeForRun failed, degrading to text-only')
    // 尽力清理可能已建的落盘目录，避免孤儿。
    if (rootDir && existsSync(rootDir)) await cleanupMaterializedRoot(rootDir).catch(() => {})
    return { mergedPrompt: opts.message, rootDir: null, materialized: [] }
  }
}

/**
 * 把 refs（REST 上传的 token ref / rerun 读回的审计 ref）转成可重放的源。
 * token → token 源（消费鉴权重放）；无 token 有 uri → uri 源（外部抓取重放）；
 * 皆无（bytes 审计 ref）无法重放，丢弃。全丢时返回 undefined（走无附件快路径）。
 */
export function refsToSources(
  refs: { token?: string; uri?: string; name: string; mimeType: string }[] | undefined,
): AttachmentSource[] | undefined {
  if (!refs || refs.length === 0) return undefined
  const sources: AttachmentSource[] = []
  for (const r of refs) {
    if (r.token) {
      sources.push({ kind: 'token', token: r.token, name: r.name, mimeType: r.mimeType })
    } else if (r.uri) {
      sources.push({ kind: 'uri', uri: r.uri, name: r.name, mimeType: r.mimeType })
    }
  }
  return sources.length > 0 ? sources : undefined
}
