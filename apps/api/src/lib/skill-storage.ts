import { randomBytes } from 'node:crypto'
import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { dirname, join, resolve, sep } from 'node:path'
/**
 * Skill 文件存储服务
 * 负责 skills 的磁盘存储、上传解析、路径安全
 */
import AdmZip from 'adm-zip'
import matter from 'gray-matter'
import { env } from '../env.js'
import { logger } from './logger.js'

const MAX_SINGLE_FILE_BYTES = 10 * 1024 * 1024 // 10MB
const MAX_ZIP_UPLOAD_BYTES = 10 * 1024 * 1024 // 10MB
/** Aggregate cap for everything written into one skill directory in a single request.
 *  Applies to both ZIP extract total and folder upload accumulated bytes — keeps the
 *  on-disk skill budget aligned with the global 10MB request body cap. */
export const MAX_SKILL_TOTAL_UPLOAD_BYTES = 10 * 1024 * 1024 // 10MB

/**
 * 在浏览器文件夹上传的相对路径列表里定位 SKILL.md 所在目录前缀。
 * 多个 SKILL.md 时取最浅层的，便于把整个 skill 包按拍下的目录直接落盘。
 */
export function findSkillRoot(paths: string[]): { prefix: string; skillMdIndex: number } | null {
  let best: { prefix: string; index: number; depth: number } | null = null
  for (let i = 0; i < paths.length; i++) {
    const segments = paths[i].split('/')
    if (segments[segments.length - 1] !== 'SKILL.md') continue
    const depth = segments.length - 1
    if (!best || depth < best.depth) {
      best = { prefix: segments.slice(0, -1).join('/'), index: i, depth }
    }
  }
  return best ? { prefix: best.prefix, skillMdIndex: best.index } : null
}

/** 解析 SKILL.md 内容，提取 frontmatter 和正文 */
export function parseSkillMd(content: string): {
  name: string
  description: string | null
  body: string
} {
  const parsed = matter(content)
  const data = parsed.data as Record<string, unknown>
  const name = typeof data.name === 'string' ? data.name.trim() : 'Untitled Skill'
  const description = typeof data.description === 'string' ? data.description.trim() || null : null
  return { name, description, body: parsed.content.trim() }
}

/** 获取 skills 存储根目录的绝对路径 */
export function getSkillsStorageRoot(): string {
  const root = env.A2WAVE_SKILLS_STORAGE
  return resolve(process.cwd(), root)
}

/** 获取指定 skill 的存储目录绝对路径 */
export function getSkillStoragePath(skillId: string): string {
  return join(getSkillsStorageRoot(), skillId)
}

/**
 * 生成 temp-swap 用的唯一临时 skill id。随机后缀（非 Date.now()）保证同毫秒
 * 并发的多个 reupload/replace 请求各用独立临时目录，互不串扰。
 * reupload 文件夹（replaceSkillFolder）与 /:id/files/upload?replace=true 共用。
 */
export function makeTempSkillId(skillId: string): string {
  return `${skillId}_tmp_${randomBytes(8).toString('hex')}`
}

/** 确保目录存在 */
export function ensureDir(path: string): void {
  if (!existsSync(path)) {
    mkdirSync(path, { recursive: true })
  }
}

/** 写入单个 SKILL.md 到 skill 目录 */
export function writeSkillMd(skillId: string, content: string): void {
  const skillDir = getSkillStoragePath(skillId)
  ensureDir(skillDir)
  const filePath = join(skillDir, 'SKILL.md')
  writeFileSync(filePath, content, 'utf-8')
  logger.info({ skillId }, 'Wrote SKILL.md to storage')
}

/** 写入 skill 下任意附加文件（支持子目录） */
export function writeSkillFile(skillId: string, filePath: string, content: Buffer): void {
  const skillDir = getSkillStoragePath(skillId)
  ensureDir(skillDir)

  const normalized = filePath.replace(/\\/g, '/').replace(/\/+/g, '/').replace(/^\//, '')
  if (!normalized || normalized.includes('..')) {
    throw new Error('Invalid file path')
  }

  const targetPath = join(skillDir, normalized)
  const resolvedSkillDir = resolve(skillDir)
  const resolvedTarget = resolve(targetPath)

  if (resolvedTarget !== resolvedSkillDir && !resolvedTarget.startsWith(resolvedSkillDir + sep)) {
    throw new Error('Path traversal not allowed')
  }

  ensureDir(dirname(resolvedTarget))
  writeFileSync(resolvedTarget, content)
}

/** 从 ZIP 解压到 skill 目录，返回解析后的 SKILL.md 内容 */
export function extractZipToSkill(
  zipBuffer: Buffer,
  skillId: string,
): { name: string; description: string | null; body: string } {
  if (zipBuffer.length > MAX_ZIP_UPLOAD_BYTES) {
    throw new Error(`ZIP archive must not exceed ${MAX_ZIP_UPLOAD_BYTES / 1024 / 1024}MB`)
  }
  const zip = new AdmZip(zipBuffer)
  const entries = zip.getEntries()
  let skillMdEntry: AdmZip.IZipEntry | null = null
  let totalSize = 0

  for (const entry of entries) {
    if (entry.isDirectory) continue
    const size = entry.header?.size ?? 0
    totalSize += size
    if (totalSize > MAX_SKILL_TOTAL_UPLOAD_BYTES) {
      throw new Error(
        `Uncompressed ZIP size exceeds the ${MAX_SKILL_TOTAL_UPLOAD_BYTES / 1024 / 1024}MB limit`,
      )
    }
    const rawName = entry.entryName
    // 规范化路径，拒绝 .. 穿越
    const normalized = rawName.replace(/\\/g, '/').replace(/\/+/g, '/')
    if (normalized.includes('..')) {
      throw new Error(`ZIP contains an illegal path: ${rawName}`)
    }
    const base = rawName.split(/[/\\]/)[0]
    const fileName = rawName.split(/[/\\]/).pop() ?? ''
    if (fileName === 'SKILL.md' && (base === 'SKILL.md' || !entry.entryName.includes('/'))) {
      skillMdEntry = entry
    } else if (fileName === 'SKILL.md' && !skillMdEntry) {
      skillMdEntry = entry
    }
  }

  if (!skillMdEntry) {
    throw new Error('No SKILL.md file found in the ZIP archive')
  }

  const skillDir = getSkillStoragePath(skillId)
  ensureDir(skillDir)

  const resolvedSkillDir = resolve(skillDir)
  for (const entry of entries) {
    const rawName = entry.entryName.replace(/\\/g, '/')
    const resolvedEntry = resolve(join(skillDir, rawName))
    if (resolvedEntry !== resolvedSkillDir && !resolvedEntry.startsWith(resolvedSkillDir + sep)) {
      throw new Error(`ZIP contains an illegal path: ${entry.entryName}`)
    }
  }
  zip.extractAllTo(skillDir, true)

  const skillMdContent = skillMdEntry.getData().toString('utf-8')
  return parseSkillMd(skillMdContent)
}

/** 列出 skill 目录下的文件树 */
export function listSkillFiles(
  skillId: string,
  subPath = '',
): Array<{ name: string; type: 'file' | 'directory'; size?: number; entries?: unknown[] }> {
  const basePath = getSkillStoragePath(skillId)
  const targetPath = subPath ? join(basePath, subPath) : basePath

  if (!existsSync(targetPath)) {
    return []
  }

  const stat = statSync(targetPath)
  if (!stat.isDirectory()) {
    return []
  }

  const names = readdirSync(targetPath)
  const result: Array<{
    name: string
    type: 'file' | 'directory'
    size?: number
    entries?: unknown[]
  }> = []

  for (const name of names) {
    const fullPath = join(targetPath, name)
    const s = statSync(fullPath)
    const relPath = subPath ? `${subPath}/${name}` : name
    if (s.isDirectory()) {
      result.push({
        name,
        type: 'directory',
        entries: listSkillFiles(skillId, relPath),
      })
    } else {
      result.push({ name, type: 'file', size: s.size })
    }
  }

  return result.sort((a, b) => {
    if (a.type !== b.type) return a.type === 'directory' ? -1 : 1
    return a.name.localeCompare(b.name)
  })
}

/** 读取 skill 下的文件内容 */
export function readSkillFile(skillId: string, filePath: string): Buffer {
  const basePath = getSkillStoragePath(skillId)
  const targetPath = join(basePath, filePath)

  const resolved = resolve(targetPath)
  const baseResolved = resolve(basePath)
  if (!resolved.startsWith(baseResolved)) {
    throw new Error('Path traversal not allowed')
  }

  if (!existsSync(resolved)) {
    throw new Error('File not found')
  }

  const stat = statSync(resolved)
  if (stat.isDirectory()) {
    throw new Error('Cannot read directory as file')
  }

  return readFileSync(resolved)
}

export interface SkillStorageFile {
  path: string
  content: Buffer
}

/** Read a complete Skill package as a deterministic, path-sorted file list. */
export function readAllSkillFiles(skillId: string): SkillStorageFile[] {
  const root = getSkillStoragePath(skillId)
  if (!existsSync(root)) return []
  const files: SkillStorageFile[] = []

  const visit = (directory: string, prefix: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const relative = prefix ? `${prefix}/${entry.name}` : entry.name
      const absolute = join(directory, entry.name)
      if (entry.isSymbolicLink()) {
        throw new Error(`Skill storage contains a symbolic link: ${relative}`)
      }
      if (entry.isDirectory()) {
        visit(absolute, relative)
      } else if (entry.isFile()) {
        files.push({ path: relative, content: readFileSync(absolute) })
      }
    }
  }

  visit(root, '')
  return files.sort((a, b) => a.path.localeCompare(b.path))
}

export interface SkillStorageSwap {
  commit(): void
  rollback(): void
}

/**
 * Replace a Skill directory while retaining a rollback copy until the caller's
 * database transaction commits. The caller must hold the per-Skill storage lock.
 */
export function replaceSkillFilesWithRollback(
  skillId: string,
  files: SkillStorageFile[],
): SkillStorageSwap {
  const tempId = makeTempSkillId(skillId)
  const backupId = makeTempSkillId(`${skillId}_backup`)
  const tempPath = getSkillStoragePath(tempId)
  const backupPath = getSkillStoragePath(backupId)
  const skillPath = getSkillStoragePath(skillId)
  const seen = new Set<string>()
  let totalBytes = 0

  try {
    for (const file of files) {
      if (seen.has(file.path)) throw new Error(`Duplicate Skill file path: ${file.path}`)
      seen.add(file.path)
      validateSingleFileSize(file.content.length)
      totalBytes += file.content.length
      validateSkillTotalSize(totalBytes)
      writeSkillFile(tempId, file.path, file.content)
    }
    if (!seen.has('SKILL.md')) throw new Error('Remote Skill package does not contain SKILL.md')
  } catch (error) {
    removeSkillStorage(tempId)
    throw error
  }

  const hadOriginal = existsSync(skillPath)
  try {
    if (hadOriginal) renameSync(skillPath, backupPath)
    renameSync(tempPath, skillPath)
  } catch (error) {
    removeSkillStorage(tempId)
    if (hadOriginal && existsSync(backupPath) && !existsSync(skillPath)) {
      renameSync(backupPath, skillPath)
    }
    throw error
  }

  let settled = false
  return {
    commit() {
      if (settled) return
      settled = true
      try {
        removeSkillStorage(backupId)
      } catch (error) {
        logger.warn({ skillId, backupId, error }, 'Failed to remove committed Skill backup')
      }
    },
    rollback() {
      if (settled) return
      settled = true
      removeSkillStorage(skillId)
      if (hadOriginal && existsSync(backupPath)) renameSync(backupPath, skillPath)
      else removeSkillStorage(backupId)
    },
  }
}

/** 删除 skill 的存储目录 */
export function removeSkillStorage(skillId: string): void {
  const skillDir = getSkillStoragePath(skillId)
  if (existsSync(skillDir)) {
    rmSync(skillDir, { recursive: true })
    logger.info({ skillId }, 'Removed skill storage directory')
  }
}

/** 验证上传文件：单文件大小 */
export function validateSingleFileSize(size: number): void {
  if (size > MAX_SINGLE_FILE_BYTES) {
    throw new Error(`A single file must not exceed ${MAX_SINGLE_FILE_BYTES / 1024 / 1024}MB`)
  }
}

/** 验证单次文件夹上传累计大小，与 ZIP 解压总大小同一上限。 */
export function validateSkillTotalSize(totalBytes: number): void {
  if (totalBytes > MAX_SKILL_TOTAL_UPLOAD_BYTES) {
    throw new Error(
      `Total folder upload size exceeds the ${MAX_SKILL_TOTAL_UPLOAD_BYTES / 1024 / 1024}MB limit`,
    )
  }
}

/**
 * 浏览器整个文件夹上传时单个文件的 duck-typed 形态。
 * Node 的 buffer.File 与 undici 的 File 类型不一致，只取我们需要的两个成员。
 */
export interface UploadedFolderFile {
  arrayBuffer(): Promise<ArrayBuffer>
  name: string
}

/**
 * 把浏览器选中的整个 skill 文件夹（files[] + 对应相对 paths[]）写入 skillId 目录。
 * 以最浅层 SKILL.md 所在目录为根，落盘其兄弟树；根目录外的文件忽略。任何文件
 * 校验失败时回滚整个 skillId 目录，不残留半成品。返回解析后的 SKILL.md 元数据。
 *
 * 调用方负责事先保证 skillId 目录可写：新建场景目录尚不存在；reupload 场景需先
 * removeSkillStorage 清空旧内容（与 .md / .zip reupload 的 clear-then-write 一致）。
 */
export async function writeSkillFolder(
  skillId: string,
  files: UploadedFolderFile[],
  paths: string[],
): Promise<{ name: string; description: string | null; body: string }> {
  if (paths.length !== files.length) {
    throw new Error('files and paths have different lengths')
  }
  const root = findSkillRoot(paths)
  if (!root) {
    throw new Error('No SKILL.md found in the folder')
  }
  const stripPrefix = root.prefix === '' ? '' : `${root.prefix}/`

  const skillMdBuf = Buffer.from(await files[root.skillMdIndex].arrayBuffer())
  validateSingleFileSize(skillMdBuf.length)
  const skillMdContent = skillMdBuf.toString('utf-8')
  const parsed = parseSkillMd(skillMdContent)

  // Disk writes are not atomic. If any file fails validation mid-loop, undo the
  // partial directory before bubbling out so we don't leak a half-written skill dir.
  try {
    let totalBytes = skillMdBuf.length
    validateSkillTotalSize(totalBytes)
    writeSkillMd(skillId, skillMdContent)
    for (let i = 0; i < files.length; i++) {
      if (i === root.skillMdIndex) continue
      const path = paths[i]
      if (stripPrefix && !path.startsWith(stripPrefix)) continue // 落在 SKILL.md 兄弟树外的文件忽略
      const relative = stripPrefix ? path.slice(stripPrefix.length) : path
      if (!relative || relative === 'SKILL.md') continue
      const buf = Buffer.from(await files[i].arrayBuffer())
      validateSingleFileSize(buf.length)
      totalBytes += buf.length
      validateSkillTotalSize(totalBytes)
      writeSkillFile(skillId, relative, buf)
    }
  } catch (err) {
    removeSkillStorage(skillId)
    throw err
  }

  return parsed
}

/**
 * 以 temp-swap 方式重新落盘整个 skill 文件夹（reupload 用）：先写到临时目录并完成
 * 全部校验，成功后才删除旧目录并原子 rename 替换。**校验失败（无 SKILL.md / 计数
 * 不符 / 超限）时旧内容保持不变** —— 不像直接 clear-then-write 会在校验前就丢旧数据。
 * 与同模块 ?replace=true 的 temp-swap 安全模式一致。
 */
export async function replaceSkillFolder(
  skillId: string,
  files: UploadedFolderFile[],
  paths: string[],
): Promise<{ name: string; description: string | null; body: string }> {
  // 唯一临时目录：避免同毫秒并发的两个 reupload 撞同一 tempId 互相串扰。
  const tempId = makeTempSkillId(skillId)
  // 写临时目录 + 全量校验。失败时 writeSkillFolder 已回滚 tempId，旧 skillId 目录未动。
  const parsed = await writeSkillFolder(tempId, files, paths)
  // 校验全过、临时目录就绪后，才销毁旧内容并原子替换。
  removeSkillStorage(skillId)
  renameSync(getSkillStoragePath(tempId), getSkillStoragePath(skillId))
  return parsed
}
