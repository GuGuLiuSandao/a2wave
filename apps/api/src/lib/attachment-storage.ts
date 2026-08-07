/**
 * 附件暂存存储（两步上传的第一步落盘层）。
 *
 * 上传字节先落到 `<stagingPath>/<token>/<safeName>`，附一份 `meta.json`。invoke 时
 * materializer 用 token 找回字节并拷进运行时 tmp 目录。暂存副本由 TTL sweeper 回收。
 *
 * 安全：token 先经正则校验，所有拼路径都过 assertUnderRoot（resolve().startsWith），
 * 防路径穿越——沿用 artifact-storage / skill-storage 的守卫范式。上限/TTL/根目录均从
 * Settings 读取（getAttachmentSettings），本模块不硬编码。
 */
import { randomBytes } from 'node:crypto'
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { basename, join, resolve, sep } from 'node:path'
import { createId } from './id.js'
import { logger } from './logger.js'
import { getAttachmentSettings } from './settings.js'

/** meta.json 落盘形状。 */
export interface StagedAttachmentMeta {
  name: string
  mimeType: string
  size: number
  createdAt: string
  /** 上传者用户 id；GET 取回时用于 owner 绑定鉴权（老数据可能缺，视为无主）。 */
  uploaderId?: string
}

export interface StagedAttachment {
  path: string
  meta: StagedAttachmentMeta
}

/**
 * token 必须是 `att_` 前缀 + base64url 安全字符（createId('att') 的产物）。
 * 严格锁前缀有两个作用：① 路径拼接安全；② sweeper 哨兵——只回收真正的附件目录，绝不误伤
 * kbd_/art_ 等其它前缀 ID 目录或非附件文件（哪怕它们恰好含 meta.json）。
 */
const TOKEN_RE = /^att_[A-Za-z0-9_-]+$/

/** 暂存根目录绝对路径（相对 cwd 解析）。 */
export async function resolveStagingRoot(): Promise<string> {
  return resolve(process.cwd(), getAttachmentSettings().stagingPath)
}

/** 落盘文件名字节上限（多数 FS 单组件 255 字节；留余量给 sequence 前缀等）。 */
const MAX_DISK_FILENAME_BYTES = 200

/**
 * 落盘文件名消毒：防路径穿越与非法字符、空名兜底、并按**字节**截断超长名（保留扩展名）——
 * 超长文件名会让 writeFile 抛 ENAMETOOLONG，配合无回滚可被滥用留残留（review [P1]）。
 */
export function safeDiskFileName(raw: string | undefined): string {
  const base = raw ? basename(raw) : ''
  const name = base.replace(/[^a-zA-Z0-9._-]/g, '_').replace(/^\.+/, '')
  if (!name) return 'attachment'
  return truncateFilenameBytes(name, MAX_DISK_FILENAME_BYTES)
}

/** 按字节截断文件名，尽量保留扩展名（扩展名本身也超长则一并截）。 */
function truncateFilenameBytes(name: string, maxBytes: number): string {
  if (Buffer.byteLength(name) <= maxBytes) return name
  const dot = name.lastIndexOf('.')
  const ext = dot > 0 ? name.slice(dot) : ''
  const stem = dot > 0 ? name.slice(0, dot) : name
  const extBytes = Buffer.byteLength(ext)
  const budget = Math.max(1, maxBytes - Math.min(extBytes, maxBytes - 1))
  // 文件名已消毒为 ASCII（[a-zA-Z0-9._-]），字节数==字符数，直接按长度切。
  const truncatedStem = stem.slice(0, budget)
  const result = `${truncatedStem}${extBytes < maxBytes ? ext : ext.slice(0, maxBytes - 1)}`
  return result || 'attachment'
}

/** 断言 target 落在 root 之内（含 root 自身），否则抛错。 */
function assertUnderRoot(target: string, root: string): void {
  const resolvedTarget = resolve(target)
  const resolvedRoot = resolve(root)
  if (resolvedTarget !== resolvedRoot && !resolvedTarget.startsWith(resolvedRoot + sep)) {
    throw new Error('Attachment path escapes staging root')
  }
}

/**
 * 暂存一份附件字节，返回 token。原子写（临时文件 + rename），附 meta.json。
 */
export async function stageAttachment(
  bytes: Buffer,
  name: string,
  mimeType: string,
  uploaderId?: string,
): Promise<{ token: string; storedPath: string; meta: StagedAttachmentMeta }> {
  const root = await resolveStagingRoot()
  const token = createId('att')
  const dir = join(await root, token)
  assertUnderRoot(dir, await root)
  mkdirSync(dir, { recursive: true })

  const safeName = safeDiskFileName(name)
  const storedPath = join(dir, safeName)
  assertUnderRoot(storedPath, await root)

  // 整段写入用 try/catch 包住：rename / 写 meta 中途失败必须回滚整个 token 目录，否则会残留
  // 「有文件无 meta」的半截目录——sweeper 现在跳过无 meta 目录，这类残留会永久填卷（review
  // [P1]，超长文件名等异常可被滥用）。
  try {
    // 原子写：先写临时文件再 rename，避免 sweeper/读取撞见半截文件。
    const tmpPath = join(dir, `.tmp-${randomBytes(6).toString('hex')}`)
    writeFileSync(tmpPath, bytes)
    renameSync(tmpPath, storedPath)

    const meta: StagedAttachmentMeta = {
      name: safeName,
      mimeType,
      size: bytes.length,
      createdAt: new Date().toISOString(),
      ...(uploaderId ? { uploaderId } : {}),
    }
    writeFileSync(join(dir, 'meta.json'), JSON.stringify(meta))

    return { token, storedPath, meta }
  } catch (err) {
    rmSync(dir, { recursive: true, force: true })
    throw err
  }
}

/** 按 token 找回暂存附件；token 非法/不存在/损坏返回 null。 */
export async function resolveStagedAttachment(token: string): Promise<StagedAttachment | null> {
  if (!TOKEN_RE.test(token)) return null
  const root = await resolveStagingRoot()
  const dir = join(await root, token)
  try {
    assertUnderRoot(dir, await root)
  } catch {
    return null
  }
  const metaPath = join(dir, 'meta.json')
  if (!existsSync(metaPath)) return null
  try {
    const meta = JSON.parse(readFileSync(metaPath, 'utf-8')) as StagedAttachmentMeta
    const path = join(dir, safeDiskFileName(meta.name))
    if (!existsSync(path)) return null
    return { path, meta }
  } catch {
    return null
  }
}

/** 删除某个 token 的暂存目录（幂等）。 */
export async function deleteStagedAttachment(token: string): Promise<void> {
  if (!TOKEN_RE.test(token)) return
  const root = await resolveStagingRoot()
  const dir = join(await root, token)
  try {
    assertUnderRoot(dir, await root)
  } catch {
    return
  }
  rmSync(dir, { recursive: true, force: true })
}

/**
 * 回收早于 ttlMs 的暂存目录，返回删除数量。以 meta.createdAt 为准，缺失/损坏 meta 时回退
 * 目录 mtime。供 TTL sweeper 调用。
 *
 * 安全哨兵（review [P1]）：只回收「名字匹配 TOKEN_RE（严格 att_ 前缀） + 是目录 + 内含
 * meta.json」的条目。若管理员把 stagingPath 误配成 ./data / 共享卷 / 项目目录，数据库文件、
 * 产物、技能等**不匹配这三条**，绝不会被 rmSync 误删。
 *
 * isPinned（review [P1]）：仍被非终态 run（pending/queued/running）引用的 token 不删——排队
 * 超过 TTL 的附件必须留到出队消费，否则 token 还在、文件已删、run 静默退化为纯文本。
 */
export async function deleteExpiredStagedAttachments(
  ttlMs: number,
  isPinned?: (token: string) => boolean | Promise<boolean>,
): Promise<number> {
  const root = await resolveStagingRoot()
  if (!existsSync(root)) return 0
  const cutoff = Date.now() - ttlMs
  let removed = 0
  for (const token of readdirSync(root)) {
    // 哨兵 1：名字必须是合法 token（严格 att_ 前缀）。跳过任何其它文件/目录。
    if (!TOKEN_RE.test(token)) continue
    // Pin：仍被非终态 run 引用 → 保留到出队消费。
    // 必须 await：签名允许 async 谓词，而未 await 的 Promise 恒为 truthy，
    // 会把每个 token 都判成 pinned —— sweeper 静默变成空操作（removed 恒为 0，
    // 连日志都不打），暂存目录无限增长。
    if (await isPinned?.(token)) continue
    const dir = join(root, token)
    const metaPath = join(dir, 'meta.json')
    let ageRefMs: number
    try {
      // 哨兵 2：必须是目录且含 meta.json，否则不认为是附件暂存目录，跳过。
      if (!statSync(dir).isDirectory() || !existsSync(metaPath)) continue
      const meta = JSON.parse(readFileSync(metaPath, 'utf-8')) as StagedAttachmentMeta
      ageRefMs = Date.parse(meta.createdAt)
      if (Number.isNaN(ageRefMs)) ageRefMs = statSync(dir).mtimeMs
    } catch {
      continue // 读不动/不是附件目录 → 保守跳过，不删
    }
    if (ageRefMs < cutoff) {
      try {
        rmSync(dir, { recursive: true, force: true })
        removed++
      } catch (err) {
        logger.warn({ err, token }, 'Failed to delete expired staged attachment')
      }
    }
  }
  return removed
}
