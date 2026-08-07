/**
 * KB Document 文件存储服务
 * 负责知识库文档的磁盘存储、上传、路径安全
 */
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve, sep } from 'node:path'
import { env } from '../env.js'
import { logger } from './logger.js'

const MAX_SINGLE_FILE_BYTES = 10 * 1024 * 1024 // 10MB

/** 获取 KB 存储根目录的绝对路径 */
export function getKbStorageRoot(): string {
  const root = env.A2WAVE_KB_STORAGE
  return resolve(process.cwd(), root)
}

/** 获取指定 KB document 的存储目录绝对路径 */
export function getKbDocStoragePath(docId: string): string {
  return join(getKbStorageRoot(), docId)
}

/** 确保目录存在 */
function ensureDir(path: string): void {
  if (!existsSync(path)) {
    mkdirSync(path, { recursive: true })
  }
}

/** 写入 KB 文档的 content.md */
export function writeKbContent(docId: string, content: string): void {
  const docDir = getKbDocStoragePath(docId)
  ensureDir(docDir)
  const filePath = join(docDir, 'content.md')
  writeFileSync(filePath, content, 'utf-8')
  logger.info({ docId }, 'Wrote KB content.md to storage')
}

/** 写入 KB 文档的 meta.json */
export function writeKbMeta(docId: string, meta: Record<string, unknown>): void {
  const docDir = getKbDocStoragePath(docId)
  ensureDir(docDir)
  const filePath = join(docDir, 'meta.json')
  writeFileSync(filePath, JSON.stringify(meta, null, 2), 'utf-8')
}

/** 写入上传的原始文件 */
export function writeKbOriginalFile(docId: string, filename: string, content: Buffer): void {
  const docDir = getKbDocStoragePath(docId)
  ensureDir(docDir)

  const normalized = filename.replace(/\\/g, '/').replace(/\/+/g, '/').replace(/^\//, '')
  if (!normalized || normalized.includes('..')) {
    throw new Error('Invalid file path')
  }

  const targetPath = join(docDir, normalized)
  const resolvedDocDir = resolve(docDir)
  const resolvedTarget = resolve(targetPath)

  if (resolvedTarget !== resolvedDocDir && !resolvedTarget.startsWith(resolvedDocDir + sep)) {
    throw new Error('Path traversal not allowed')
  }

  ensureDir(dirname(resolvedTarget))
  writeFileSync(resolvedTarget, content)
  logger.info({ docId, filename }, 'Wrote KB original file to storage')
}

/** 读取 KB 文档的 content.md */
export function readKbContent(docId: string): string | null {
  const filePath = join(getKbDocStoragePath(docId), 'content.md')
  if (!existsSync(filePath)) return null
  return readFileSync(filePath, 'utf-8')
}

/** 读取 KB 文档的 meta.json */
export function readKbMeta(docId: string): Record<string, unknown> | null {
  const filePath = join(getKbDocStoragePath(docId), 'meta.json')
  if (!existsSync(filePath)) return null
  try {
    return JSON.parse(readFileSync(filePath, 'utf-8'))
  } catch {
    return null
  }
}

/** 删除 KB 文档的存储目录 */
export function removeKbStorage(docId: string): void {
  const docDir = getKbDocStoragePath(docId)
  if (existsSync(docDir)) {
    rmSync(docDir, { recursive: true })
    logger.info({ docId }, 'Removed KB document storage directory')
  }
}

/** 获取 KB 文档的存储目录大小 */
export function getKbDocSize(docId: string): number {
  const contentPath = join(getKbDocStoragePath(docId), 'content.md')
  if (!existsSync(contentPath)) return 0
  return statSync(contentPath).size
}

/** 验证上传文件大小 */
export function validateKbFileSize(size: number): void {
  if (size > MAX_SINGLE_FILE_BYTES) {
    throw new Error(`A single file must not exceed ${MAX_SINGLE_FILE_BYTES / 1024 / 1024}MB`)
  }
}
