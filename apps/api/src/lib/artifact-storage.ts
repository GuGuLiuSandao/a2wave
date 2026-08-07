/**
 * Artifact 文件存储服务
 * 负责产物的磁盘存储、扫描注册、路径安全、过期清理
 */
import { createHash } from 'node:crypto'
import {
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
} from 'node:fs'
import { join, resolve, sep } from 'node:path'
import AdmZip from 'adm-zip'
import { and, eq, gt, inArray, isNull, lt, notExists } from 'drizzle-orm'
import { db } from '../db/client.js'
import { artifactShares, artifacts } from '../db/schema.js'
import { deleteStaleShares } from './artifact-share.js'
import { createId } from './id.js'
import { logger } from './logger.js'
import { getSetting } from './settings.js'

/** 获取产物存储根目录绝对路径 */
export async function getArtifactsStorageRoot(): Promise<string> {
  const storagePath = getSetting('artifacts', 'storagePath') || './data/artifacts'
  return resolve(process.cwd(), await storagePath)
}

/** 获取产物保留毫秒数 */
export function getArtifactRetentionMs(): number {
  const hours = Number(getSetting('artifacts', 'retentionHours') ?? '168')
  return hours * 60 * 60 * 1000
}

/** 计算用户 Hash（不透明但一致） */
function userHash(userId: string): string {
  return createHash('sha256').update(userId).digest('hex').slice(0, 12)
}

/** 获取某次 run 的产物目录（磁盘） */
export async function getArtifactDir(
  agentId: string,
  userId: string | null,
  runId: string,
): Promise<string> {
  const root = await getArtifactsStorageRoot()
  const userSegment = userId ? userHash(userId) : '_system'
  return join(root, agentId, userSegment, runId)
}

/** 确保目录存在 */
function ensureDir(path: string): void {
  if (!existsSync(path)) {
    mkdirSync(path, { recursive: true })
  }
}

/** MIME type 简单推断 */
export function guessMimeType(filename: string): string {
  const ext = filename.split('.').pop()?.toLowerCase() ?? ''
  const map: Record<string, string> = {
    txt: 'text/plain',
    md: 'text/markdown',
    json: 'application/json',
    html: 'text/html',
    htm: 'text/html',
    css: 'text/css',
    js: 'text/javascript',
    ts: 'text/typescript',
    py: 'text/x-python',
    sh: 'text/x-sh',
    csv: 'text/csv',
    xml: 'application/xml',
    pdf: 'application/pdf',
    png: 'image/png',
    jpg: 'image/jpeg',
    jpeg: 'image/jpeg',
    gif: 'image/gif',
    svg: 'image/svg+xml',
    zip: 'application/zip',
    tar: 'application/x-tar',
    gz: 'application/gzip',
  }
  return map[ext] ?? 'application/octet-stream'
}

export interface RegisteredArtifact {
  id: string
  filename: string
  storagePath: string
  kind: 'file' | 'directory'
  mimeType: string | null
  /** 生成该产物的 agent；用于分享 URL 段 /s/:agentId/:shareId 与「由谁生成」展示 */
  agentId: string | null
}

/**
 * 递归复制目录，逐项 lstat 跳过 symlink（含嵌套层级）。
 * 返回复制的文件总大小、文件数和最新文件 mtime（用于陈旧目录判断）。
 */
function copyDirSkippingSymlinks(
  src: string,
  dest: string,
): { totalSize: number; fileCount: number; maxMtimeMs: number } {
  let totalSize = 0
  let fileCount = 0
  let maxMtimeMs = 0
  ensureDir(dest)
  for (const entry of readdirSync(src)) {
    const srcPath = join(src, entry)
    const destPath = join(dest, entry)
    const stat = lstatSync(srcPath)
    if (stat.isSymbolicLink()) {
      logger.warn({ path: srcPath }, 'Artifact directory entry is a symlink, skipping')
      continue
    }
    if (stat.isDirectory()) {
      const sub = copyDirSkippingSymlinks(srcPath, destPath)
      totalSize += sub.totalSize
      fileCount += sub.fileCount
      maxMtimeMs = Math.max(maxMtimeMs, sub.maxMtimeMs)
    } else if (stat.isFile()) {
      copyFileSync(srcPath, destPath)
      totalSize += stat.size
      fileCount += 1
      maxMtimeMs = Math.max(maxMtimeMs, stat.mtimeMs)
    }
  }
  return { totalSize, fileCount, maxMtimeMs }
}

/**
 * 扫描 workDir/artifacts/ 目录，将产物注册到 DB。
 * 顶层文件注册为 file 产物；顶层目录整体注册为 directory 产物（递归复制）。
 * 文件复制到隔离存储路径后批量 INSERT
 */
export async function scanAndRegisterArtifacts(
  runId: string,
  agentId: string,
  userId: string | null,
  workDir: string,
  options?: { registeredAfterMs?: number },
): Promise<RegisteredArtifact[]> {
  const sourceDir = join(workDir, 'artifacts')
  if (!existsSync(sourceDir)) {
    return []
  }

  const stat = statSync(sourceDir)
  if (!stat.isDirectory()) {
    return []
  }

  const entries = readdirSync(sourceDir)
  if (entries.length === 0) {
    return []
  }

  const destDir = await getArtifactDir(agentId, userId, runId)
  ensureDir(destDir)

  const resolvedDestDir = resolve(destDir)
  const retentionMs = getArtifactRetentionMs()
  const expiresAt = retentionMs > 0 ? new Date(Date.now() + retentionMs) : null
  const registered: RegisteredArtifact[] = []
  const registeredAfterMs = options?.registeredAfterMs

  for (const filename of entries) {
    const srcPath = join(sourceDir, filename)
    const srcStat = lstatSync(srcPath)
    if (srcStat.isSymbolicLink()) {
      logger.warn({ filename, runId }, 'Artifact is a symlink, skipping for security')
      continue
    }
    const isDirectory = srcStat.isDirectory()
    if (!isDirectory && !srcStat.isFile()) continue

    // Path security check
    const destPath = join(destDir, filename)
    const resolvedDest = resolve(destPath)
    if (resolvedDest !== resolvedDestDir && !resolvedDest.startsWith(resolvedDestDir + sep)) {
      logger.warn({ filename, runId }, 'Artifact filename failed path traversal check, skipping')
      continue
    }

    let kind: 'file' | 'directory'
    let mimeType: string | null
    let size: number

    if (isDirectory) {
      const { totalSize, fileCount, maxMtimeMs } = copyDirSkippingSymlinks(srcPath, resolvedDest)
      // 空目录不注册；目录内没有任何本次运行新产生的文件时视为上次残留
      if (
        (await fileCount) === 0 ||
        (registeredAfterMs != null && maxMtimeMs < registeredAfterMs)
      ) {
        rmSync(resolvedDest, { recursive: true, force: true })
        if ((await fileCount) > 0) {
          logger.info(
            { filename, runId, maxMtimeMs, registeredAfterMs },
            'Skipping stale directory artifact from previous run',
          )
        }
        continue
      }
      kind = 'directory'
      mimeType = null
      size = totalSize
    } else {
      if (registeredAfterMs != null && srcStat.mtimeMs < registeredAfterMs) {
        logger.info(
          { filename, runId, mtimeMs: srcStat.mtimeMs, registeredAfterMs },
          'Skipping stale artifact from previous run',
        )
        continue
      }
      copyFileSync(srcPath, resolvedDest)
      kind = 'file'
      mimeType = guessMimeType(filename)
      size = srcStat.size
    }

    const id = createId('art')
    await db.insert(artifacts).values({
      id,
      runId,
      agentId,
      userId,
      filename,
      storagePath: resolvedDest,
      kind,
      mimeType,
      size,
      expiresAt: expiresAt ?? undefined,
    })

    registered.push({ id, filename, storagePath: resolvedDest, kind, mimeType, agentId })
    logger.info({ runId, filename, kind }, 'Artifact registered')
  }

  return registered
}

/** 目录产物 zip 打包的源大小上限（zip 在内存构建，防止超大目录撑爆内存） */
export const MAX_ZIP_SOURCE_BYTES = 200 * 1024 * 1024

/**
 * 计算目录产物的源大小（递归，跳过 symlink）。
 * 用于在内存 zip 打包前做源大小预检，避免把超大目录打进内存才拒绝。
 */
export function getDirectorySourceSize(dirPath: string): number {
  let total = 0
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir)) {
      const fullPath = join(dir, entry)
      const stat = lstatSync(fullPath)
      if (stat.isSymbolicLink()) continue
      if (stat.isDirectory()) {
        walk(fullPath)
      } else if (stat.isFile()) {
        total += stat.size
      }
    }
  }
  walk(dirPath)
  return total
}

/**
 * 将目录产物打包为内存 zip Buffer（条目以 rootName/ 为前缀）。
 * 复制阶段已剔除 symlink，这里按普通文件树遍历。
 */
export function zipDirectoryToBuffer(dirPath: string, rootName: string): Buffer {
  const zip = new AdmZip()
  const addDir = (dir: string, prefix: string): void => {
    for (const entry of readdirSync(dir)) {
      const fullPath = join(dir, entry)
      const stat = lstatSync(fullPath)
      if (stat.isSymbolicLink()) continue
      if (stat.isDirectory()) {
        addDir(fullPath, `${prefix}/${entry}`)
      } else if (stat.isFile()) {
        zip.addFile(`${prefix}/${entry}`, readFileSync(fullPath))
      }
    }
  }
  addDir(dirPath, rootName)
  return zip.toBuffer()
}

/**
 * 删除已过期的产物（磁盘文件 + DB 行）。
 * 存在活跃分享（未撤销且未过期）的产物豁免清理——分享发出去的链接
 * 在有效期内必须可访问，不能被 retention 提前删掉。
 */
/**
 * Physically remove the artifact files belonging to the given runs, so that a
 * bulk `DELETE FROM runs` (data retention) doesn't strand their files on disk
 * when the FK cascade wipes the artifact rows. Only touches the filesystem; the
 * DB rows are left for the cascade. Returns the number of files removed.
 */
export async function purgeArtifactFilesForRuns(runIds: string[]): Promise<number> {
  if (runIds.length === 0) return 0
  const rows = await db
    .select({ id: artifacts.id, storagePath: artifacts.storagePath })
    .from(artifacts)
    .where(inArray(artifacts.runId, runIds))
  let removed = 0
  for (const row of rows) {
    try {
      if (existsSync(row.storagePath)) {
        rmSync(row.storagePath, { recursive: true, force: true })
        removed++
      }
    } catch (err) {
      logger.warn({ err, artifactId: row.id }, 'Failed to delete artifact file during retention')
    }
  }
  return removed
}

export async function deleteExpiredArtifacts(): Promise<void> {
  const now = new Date()
  // 先收敛分享表：过期/撤销的 share 行删除后，豁免判断只剩真正活跃的分享。
  // Awaited — the notExists(...) exemption below reads artifact_shares, so an
  // unawaited sweep leaves the stale rows visible to that subquery and every
  // expired artifact stays exempt from collection.
  await deleteStaleShares()
  const expired = await db
    .select()
    .from(artifacts)
    .where(
      and(
        lt(artifacts.expiresAt, now),
        notExists(
          db
            .select({ id: artifactShares.id })
            .from(artifactShares)
            .where(
              and(
                eq(artifactShares.artifactId, artifacts.id),
                isNull(artifactShares.revokedAt),
                gt(artifactShares.expiresAt, now),
              ),
            ),
        ),
      ),
    )

  for (const artifact of expired) {
    try {
      if (existsSync(artifact.storagePath)) {
        rmSync(artifact.storagePath, { recursive: true, force: true })
      }
    } catch (err) {
      logger.warn({ err, artifactId: artifact.id }, 'Failed to delete artifact file')
    }
    await db.delete(artifacts).where(eq(artifacts.id, artifact.id))
  }

  if (expired.length > 0) {
    logger.info({ count: expired.length }, 'Deleted expired artifacts')
  }
}
