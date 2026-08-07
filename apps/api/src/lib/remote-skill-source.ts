import { createHash } from 'node:crypto'
import { posix } from 'node:path'
import type {
  RemoteSkillCandidate,
  RemoteSkillFileChangeKind,
  RemoteSkillFileDiff,
  RemoteSkillInspection,
  RemoteSkillSource,
  RemoteSkillUpdateStrategy,
} from '@a2wave/shared'
import AdmZip from 'adm-zip'
import matter from 'gray-matter'
import { MAX_SKILL_TOTAL_UPLOAD_BYTES } from './skill-storage.js'
import { safeFetch } from './url-safety-core.js'

const GITHUB_API_HOST = 'api.github.com'
const GITHUB_DOWNLOAD_HOSTS = new Set([GITHUB_API_HOST, 'github.com', 'codeload.github.com'])
const MAX_ARCHIVE_BYTES = 50 * 1024 * 1024
const MAX_ARCHIVE_ENTRIES = 20_000
const MAX_ARCHIVE_EXPANDED_BYTES = 200 * 1024 * 1024
const MAX_MATERIALIZED_SKILL_BYTES = 20 * 1024 * 1024
const MAX_SKILL_FILES = 500
const MAX_CANDIDATES = 100
const REQUEST_TIMEOUT_MS = 30_000
const COMMIT_SHA_PATTERN = /^[0-9a-f]{40}$/
const SKILL_NAME_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/

export type RemoteSkillErrorCode = 'invalid_url' | 'not_found' | 'limit_exceeded' | 'upstream_error'

export class RemoteSkillError extends Error {
  constructor(
    public readonly code: RemoteSkillErrorCode,
    message: string,
  ) {
    super(message)
    this.name = 'RemoteSkillError'
  }
}

export interface ParsedRemoteSkillUrl {
  inputUrl: string
  owner: string
  repo: string
  requestedRef: string | null
  requestedPath: string
  treeSegments: string[] | null
  catalog: 'skills_sh' | null
  skillSelector: string | null
}

export interface RemoteSkillFile {
  path: string
  content: Buffer
}

export interface RemoteSkillPackage extends RemoteSkillCandidate {
  content: string
  files: RemoteSkillFile[]
}

export interface RemoteSkillBundle {
  inspection: RemoteSkillInspection
  packages: RemoteSkillPackage[]
}

function parseSegments(url: URL): string[] {
  try {
    return url.pathname
      .split('/')
      .filter(Boolean)
      .map((segment) => decodeURIComponent(segment))
  } catch {
    throw new RemoteSkillError('invalid_url', 'URL path contains invalid encoding')
  }
}

function validateRepositoryPart(value: string, label: string): string {
  const normalized = label === 'repository' ? value.replace(/\.git$/i, '') : value
  if (!/^[A-Za-z0-9_.-]+$/.test(normalized) || normalized === '.' || normalized === '..') {
    throw new RemoteSkillError('invalid_url', `Invalid GitHub ${label}`)
  }
  return normalized
}

function normalizeRepositoryPath(segments: string[]): string {
  if (segments.some((segment) => !segment || segment === '.' || segment === '..')) {
    throw new RemoteSkillError('invalid_url', 'Invalid repository path')
  }
  return segments.join('/')
}

/**
 * Parse only the public GitHub-backed URL forms supported by the remote installer.
 * Arbitrary Git URLs, credentials in URLs, query strings, and fragments are rejected.
 */
export function parseRemoteSkillUrl(rawUrl: string): ParsedRemoteSkillUrl {
  let url: URL
  try {
    url = new URL(rawUrl)
  } catch {
    throw new RemoteSkillError('invalid_url', 'Invalid remote Skill URL')
  }
  if (url.protocol !== 'https:') {
    throw new RemoteSkillError('invalid_url', 'Remote Skill URL must use HTTPS')
  }
  if (url.username || url.password) {
    throw new RemoteSkillError('invalid_url', 'Credentials are not allowed in remote Skill URLs')
  }
  if (url.search || url.hash) {
    throw new RemoteSkillError('invalid_url', 'Query strings and fragments are not supported')
  }

  const hostname = url.hostname.toLowerCase()
  const segments = parseSegments(url)
  if (hostname === 'github.com' || hostname === 'www.github.com') {
    if (segments.length < 2) {
      throw new RemoteSkillError('invalid_url', 'GitHub URL must include an owner and repository')
    }
    const owner = validateRepositoryPart(segments[0], 'owner')
    const repo = validateRepositoryPart(segments[1], 'repository')
    if (segments.length === 2) {
      return {
        inputUrl: url.toString(),
        owner,
        repo,
        requestedRef: null,
        requestedPath: '',
        treeSegments: null,
        catalog: null,
        skillSelector: null,
      }
    }
    if (segments[2] !== 'tree' || segments.length < 4) {
      throw new RemoteSkillError(
        'invalid_url',
        'Use a GitHub repository URL or a /tree/<ref>/<skill-path> URL',
      )
    }
    return {
      inputUrl: url.toString(),
      owner,
      repo,
      requestedRef: segments[3],
      requestedPath: normalizeRepositoryPath(segments.slice(4)),
      treeSegments: segments.slice(3).flatMap((segment) => segment.split('/')),
      catalog: null,
      skillSelector: null,
    }
  }

  if (hostname === 'skills.sh' || hostname === 'www.skills.sh') {
    if (segments.length !== 3) {
      throw new RemoteSkillError(
        'invalid_url',
        'skills.sh URL must have the form https://skills.sh/<owner>/<repo>/<skill>',
      )
    }
    return {
      inputUrl: url.toString(),
      owner: validateRepositoryPart(segments[0], 'owner'),
      repo: validateRepositoryPart(segments[1], 'repository'),
      requestedRef: null,
      requestedPath: '',
      treeSegments: null,
      catalog: 'skills_sh',
      skillSelector: segments[2],
    }
  }

  throw new RemoteSkillError(
    'invalid_url',
    'Only github.com and skills.sh remote Skill URLs are supported',
  )
}

function assertGitHubHop(rawUrl: string): void {
  const url = new URL(rawUrl)
  if (url.protocol !== 'https:' || !GITHUB_DOWNLOAD_HOSTS.has(url.hostname.toLowerCase())) {
    throw new RemoteSkillError('upstream_error', 'GitHub returned an unsafe redirect target')
  }
}

async function githubRequest(url: string): Promise<Response> {
  try {
    return await safeFetch(url, {
      headers: {
        Accept: 'application/vnd.github+json',
        'User-Agent': 'a2wave',
        'X-GitHub-Api-Version': '2022-11-28',
      },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      maxRedirects: 3,
      validateHop: assertGitHubHop,
    })
  } catch (error) {
    if (error instanceof RemoteSkillError) throw error
    const message = error instanceof Error ? error.message : 'Unknown network error'
    throw new RemoteSkillError('upstream_error', `GitHub request failed: ${message}`)
  }
}

async function readJson<T>(url: string, notFoundMessage: string): Promise<T> {
  const response = await githubRequest(url)
  if (response.status === 404) {
    throw new RemoteSkillError('not_found', notFoundMessage)
  }
  if (!response.ok) {
    throw new RemoteSkillError(
      'upstream_error',
      `GitHub API returned HTTP ${response.status}; public API rate limits may have been reached`,
    )
  }
  return (await response.json()) as T
}

async function readMatchingRefs(url: string): Promise<Array<{ ref?: unknown }>> {
  const response = await githubRequest(url)
  if (response.status === 404) return []
  if (!response.ok) {
    throw new RemoteSkillError(
      'upstream_error',
      `GitHub refs API returned HTTP ${response.status}; public API rate limits may have been reached`,
    )
  }
  const value = (await response.json()) as unknown
  return Array.isArray(value) ? (value as Array<{ ref?: unknown }>) : []
}

function requestedPathForRef(parsed: ParsedRemoteSkillUrl, requestedRef: string): string {
  if (!parsed.treeSegments) return parsed.requestedPath
  const refSegments = requestedRef.split('/')
  const prefix = parsed.treeSegments.slice(0, refSegments.length).join('/')
  if (prefix !== requestedRef) {
    throw new RemoteSkillError('invalid_url', 'Requested GitHub ref does not match the tree URL')
  }
  return normalizeRepositoryPath(parsed.treeSegments.slice(refSegments.length))
}

async function resolveTreeRef(parsed: ParsedRemoteSkillUrl): Promise<string> {
  const segments = parsed.treeSegments
  if (!segments || segments.length === 0) {
    throw new RemoteSkillError('invalid_url', 'GitHub tree URL must include a ref')
  }
  if (COMMIT_SHA_PATTERN.test(segments[0])) return segments[0]

  const first = encodeURIComponent(segments[0])
  const refs = await Promise.all([
    readMatchingRefs(
      `https://${GITHUB_API_HOST}/repos/${parsed.owner}/${parsed.repo}/git/matching-refs/heads/${first}`,
    ),
    readMatchingRefs(
      `https://${GITHUB_API_HOST}/repos/${parsed.owner}/${parsed.repo}/git/matching-refs/tags/${first}`,
    ),
  ])
  const candidates = refs
    .flat()
    .flatMap((entry) => {
      if (typeof entry.ref !== 'string') return []
      return [entry.ref.replace(/^refs\/(?:heads|tags)\//, '')]
    })
    .filter((ref) => {
      const parts = ref.split('/')
      return segments.slice(0, parts.length).join('/') === ref
    })
    .sort((a, b) => b.split('/').length - a.split('/').length)

  return candidates[0] ?? segments[0]
}

async function resolveRequestedRef(
  parsed: ParsedRemoteSkillUrl,
  requestedRefOverride?: string,
): Promise<{ requestedRef: string; requestedPath: string; revision: string }> {
  let requestedRef = requestedRefOverride
  if (!requestedRef && parsed.treeSegments) {
    requestedRef = await resolveTreeRef(parsed)
  }
  if (!requestedRef) {
    const repository = await readJson<{ default_branch?: unknown }>(
      `https://${GITHUB_API_HOST}/repos/${parsed.owner}/${parsed.repo}`,
      'Public GitHub repository not found',
    )
    if (typeof repository.default_branch !== 'string' || !repository.default_branch) {
      throw new RemoteSkillError(
        'upstream_error',
        'GitHub response did not include a default branch',
      )
    }
    requestedRef = repository.default_branch
  }
  const requestedPath = requestedPathForRef(parsed, requestedRef)

  const commit = await readJson<{ sha?: unknown }>(
    `https://${GITHUB_API_HOST}/repos/${parsed.owner}/${parsed.repo}/commits/${encodeURIComponent(requestedRef)}`,
    `GitHub ref not found: ${requestedRef}`,
  )
  if (typeof commit.sha !== 'string' || !COMMIT_SHA_PATTERN.test(commit.sha)) {
    throw new RemoteSkillError(
      'upstream_error',
      'GitHub response did not include a valid commit SHA',
    )
  }
  return { requestedRef, requestedPath, revision: commit.sha }
}

async function readBoundedArchive(response: Response): Promise<Buffer> {
  if (response.status === 404) {
    throw new RemoteSkillError('not_found', 'Public GitHub repository or revision not found')
  }
  if (!response.ok) {
    throw new RemoteSkillError(
      'upstream_error',
      `GitHub archive download returned HTTP ${response.status}`,
    )
  }
  const declaredLength = Number(response.headers.get('content-length'))
  if (Number.isFinite(declaredLength) && declaredLength > MAX_ARCHIVE_BYTES) {
    throw new RemoteSkillError(
      'limit_exceeded',
      `GitHub archive exceeds the ${MAX_ARCHIVE_BYTES / 1024 / 1024}MB download limit`,
    )
  }
  if (!response.body) return Buffer.alloc(0)

  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    total += value.byteLength
    if (total > MAX_ARCHIVE_BYTES) {
      await reader.cancel().catch(() => {})
      throw new RemoteSkillError(
        'limit_exceeded',
        `GitHub archive exceeds the ${MAX_ARCHIVE_BYTES / 1024 / 1024}MB download limit`,
      )
    }
    chunks.push(value)
  }
  return Buffer.concat(
    chunks.map((chunk) => Buffer.from(chunk)),
    total,
  )
}

function normalizedArchivePath(rawPath: string): string {
  if (!rawPath || rawPath.startsWith('/') || rawPath.includes('\\') || rawPath.includes('\0')) {
    throw new RemoteSkillError('invalid_url', `GitHub archive contains an invalid path: ${rawPath}`)
  }
  if (rawPath.split('/').some((segment) => segment === '..')) {
    throw new RemoteSkillError('invalid_url', `GitHub archive contains path traversal: ${rawPath}`)
  }
  const normalized = posix.normalize(rawPath).replace(/\/$/, '')
  if (normalized === '..' || normalized.startsWith('../')) {
    throw new RemoteSkillError('invalid_url', `GitHub archive contains path traversal: ${rawPath}`)
  }
  return normalized
}

function isSymlink(entry: AdmZip.IZipEntry): boolean {
  const attr = (entry.header as { attr?: number }).attr ?? 0
  const unixMode = (attr >>> 16) & 0xffff
  return (unixMode & 0o170000) === 0o120000
}

interface ArchiveFile {
  path: string
  size: number
  symlink: boolean
  entry: AdmZip.IZipEntry
}

function collectArchiveFiles(archive: Buffer): ArchiveFile[] {
  let zip: AdmZip
  try {
    zip = new AdmZip(archive)
  } catch {
    throw new RemoteSkillError('invalid_url', 'GitHub returned an invalid ZIP archive')
  }
  const entries = zip.getEntries()
  if (entries.length > MAX_ARCHIVE_ENTRIES) {
    throw new RemoteSkillError(
      'limit_exceeded',
      `GitHub archive contains more than ${MAX_ARCHIVE_ENTRIES} entries`,
    )
  }

  let expandedBytes = 0
  let root: string | null = null
  const files: ArchiveFile[] = []
  for (const entry of entries) {
    const fullPath = normalizedArchivePath(entry.entryName)
    const [entryRoot, ...rest] = fullPath.split('/')
    if (!root) root = entryRoot
    if (entryRoot !== root) {
      throw new RemoteSkillError('invalid_url', 'GitHub archive has multiple top-level roots')
    }
    if (entry.isDirectory) continue
    if (rest.length === 0) continue
    const path = rest.join('/')
    const symlink = isSymlink(entry)
    const size = entry.header?.size ?? 0
    if (!symlink) {
      expandedBytes += size
      if (expandedBytes > MAX_ARCHIVE_EXPANDED_BYTES) {
        throw new RemoteSkillError(
          'limit_exceeded',
          `GitHub archive expands beyond ${MAX_ARCHIVE_EXPANDED_BYTES / 1024 / 1024}MB`,
        )
      }
    }
    files.push({ path, size, symlink, entry })
  }
  return files
}

function readSkillMetadata(
  skillMd: ArchiveFile,
  candidatePath: string,
  repo: string,
): { name: string; description: string; content: string } {
  if (skillMd.size > MAX_SKILL_TOTAL_UPLOAD_BYTES) {
    throw new RemoteSkillError(
      'limit_exceeded',
      `SKILL.md at ${candidatePath} exceeds the ${MAX_SKILL_TOTAL_UPLOAD_BYTES / 1024 / 1024}MB limit`,
    )
  }
  let parsed: matter.GrayMatterFile<string>
  try {
    parsed = matter(skillMd.entry.getData().toString('utf-8'))
  } catch {
    throw new RemoteSkillError('invalid_url', `Invalid SKILL.md frontmatter at ${skillMd.path}`)
  }
  const data = parsed.data as Record<string, unknown>
  const name = typeof data.name === 'string' ? data.name.trim() : ''
  const description = typeof data.description === 'string' ? data.description.trim() : ''
  if (!name || name.length > 64 || !SKILL_NAME_PATTERN.test(name)) {
    throw new RemoteSkillError(
      'invalid_url',
      `Skill at ${candidatePath} has an invalid name; use lowercase letters, digits, and single hyphens`,
    )
  }
  if (!description || description.length > 1024) {
    throw new RemoteSkillError(
      'invalid_url',
      `Skill ${name} must have a non-empty description of at most 1024 characters`,
    )
  }
  const directoryName = candidatePath === '.' ? repo : posix.basename(candidatePath)
  if (name !== directoryName) {
    throw new RemoteSkillError(
      'invalid_url',
      `Skill name "${name}" must match its directory name "${directoryName}"`,
    )
  }
  return { name, description, content: parsed.content.trim() }
}

export function calculateRemoteSkillDigest(files: RemoteSkillFile[]): string {
  const hash = createHash('sha256')
  for (const file of [...files].sort((a, b) => a.path.localeCompare(b.path))) {
    hash.update(file.path)
    hash.update('\0')
    hash.update(file.content)
    hash.update('\0')
  }
  return `sha256:${hash.digest('hex')}`
}

function isWithinPath(candidatePath: string, requestedPath: string): boolean {
  if (!requestedPath) return true
  return candidatePath === requestedPath || candidatePath.startsWith(`${requestedPath}/`)
}

/**
 * Discover valid Agent Skills inside a GitHub-generated ZIP archive and materialize
 * only each selected Skill directory, excluding nested Skill packages.
 */
export function inspectRemoteSkillArchive(
  archive: Buffer,
  parsed: ParsedRemoteSkillUrl,
): RemoteSkillPackage[] {
  const archiveFiles = collectArchiveFiles(archive)
  const skillMdFiles = archiveFiles.filter(
    (file) => !file.symlink && posix.basename(file.path) === 'SKILL.md',
  )
  const candidateRoots = skillMdFiles.map((file) => posix.dirname(file.path) || '.')
  const requestedPath = parsed.requestedPath.replace(/\/$/, '')

  const packages: RemoteSkillPackage[] = []
  let declaredMaterializedBytes = 0
  let actualMaterializedBytes = 0
  for (const skillMd of skillMdFiles) {
    const candidatePath = posix.dirname(skillMd.path) || '.'
    if (!isWithinPath(candidatePath, requestedPath)) continue
    if (parsed.skillSelector && posix.basename(candidatePath) !== parsed.skillSelector) continue

    const metadata = readSkillMetadata(skillMd, candidatePath, parsed.repo)

    const prefix = candidatePath === '.' ? '' : `${candidatePath}/`
    const nestedRoots = candidateRoots
      .filter(
        (root) =>
          root !== candidatePath && (candidatePath === '.' || root.startsWith(`${candidatePath}/`)),
      )
      .map((root) => `${root}/`)
    const matchingEntries = archiveFiles.filter((file) => {
      if (prefix && !file.path.startsWith(prefix)) return false
      return !nestedRoots.some((nestedRoot) => file.path.startsWith(nestedRoot))
    })
    const packageSymlink = matchingEntries.find((file) => file.symlink)
    if (packageSymlink) {
      throw new RemoteSkillError(
        'invalid_url',
        `Skill ${metadata.name} contains a symlink: ${packageSymlink.path}`,
      )
    }
    const matchingFiles = matchingEntries.filter((file) => !file.symlink)
    if (matchingFiles.length > MAX_SKILL_FILES) {
      throw new RemoteSkillError(
        'limit_exceeded',
        `Skill ${metadata.name} contains more than ${MAX_SKILL_FILES} files`,
      )
    }

    let totalBytes = 0
    for (const file of matchingFiles) {
      totalBytes += file.size
      declaredMaterializedBytes += file.size
      if (totalBytes > MAX_SKILL_TOTAL_UPLOAD_BYTES) {
        throw new RemoteSkillError(
          'limit_exceeded',
          `Skill ${metadata.name} exceeds the ${MAX_SKILL_TOTAL_UPLOAD_BYTES / 1024 / 1024}MB limit`,
        )
      }
      if (declaredMaterializedBytes > MAX_MATERIALIZED_SKILL_BYTES) {
        throw new RemoteSkillError(
          'limit_exceeded',
          `Selected Skill packages expand beyond ${MAX_MATERIALIZED_SKILL_BYTES / 1024 / 1024}MB; use a GitHub /tree/ URL to select a smaller path`,
        )
      }
    }
    const files = matchingFiles
      .map((file) => {
        const content = file.entry.getData()
        actualMaterializedBytes += content.length
        if (actualMaterializedBytes > MAX_MATERIALIZED_SKILL_BYTES) {
          throw new RemoteSkillError(
            'limit_exceeded',
            `Selected Skill packages expand beyond ${MAX_MATERIALIZED_SKILL_BYTES / 1024 / 1024}MB; use a GitHub /tree/ URL to select a smaller path`,
          )
        }
        return {
          path: prefix ? file.path.slice(prefix.length) : file.path,
          content,
        }
      })
      .sort((a, b) => a.path.localeCompare(b.path))
    const actualBytes = files.reduce((sum, file) => sum + file.content.length, 0)
    if (actualBytes > MAX_SKILL_TOTAL_UPLOAD_BYTES) {
      throw new RemoteSkillError(
        'limit_exceeded',
        `Skill ${metadata.name} exceeds the ${MAX_SKILL_TOTAL_UPLOAD_BYTES / 1024 / 1024}MB limit`,
      )
    }
    packages.push({
      name: metadata.name,
      description: metadata.description,
      content: metadata.content,
      path: candidatePath,
      digest: calculateRemoteSkillDigest(files),
      fileCount: files.length,
      totalBytes: actualBytes,
      files,
    })
  }

  if (packages.length === 0) {
    const target = parsed.skillSelector ?? parsed.requestedPath
    throw new RemoteSkillError(
      'not_found',
      target
        ? `No valid Skill found for "${target}"`
        : 'No valid SKILL.md packages were found in the repository',
    )
  }
  if (packages.length > MAX_CANDIDATES) {
    throw new RemoteSkillError(
      'limit_exceeded',
      `Repository contains more than ${MAX_CANDIDATES} Skills; use a GitHub /tree/ URL`,
    )
  }
  return packages.sort((a, b) => a.path.localeCompare(b.path))
}

/**
 * Inspect a public GitHub-backed Skill source. When `expectedRevision` is supplied,
 * the exact commit is fetched without resolving a mutable ref again.
 */
export async function loadRemoteSkillBundle(
  rawUrl: string,
  expectedRevision?: string,
  requestedRefOverride?: string,
): Promise<RemoteSkillBundle> {
  const parsed = parseRemoteSkillUrl(rawUrl)
  let requestedRef: string
  let requestedPath: string
  let revision: string
  if (expectedRevision) {
    if (!COMMIT_SHA_PATTERN.test(expectedRevision)) {
      throw new RemoteSkillError('invalid_url', 'Expected revision must be a full Git commit SHA')
    }
    revision = expectedRevision
    requestedRef = requestedRefOverride ?? parsed.requestedRef ?? 'default'
    requestedPath = requestedPathForRef(parsed, requestedRef)
  } else {
    const resolved = await resolveRequestedRef(parsed, requestedRefOverride)
    requestedRef = resolved.requestedRef
    requestedPath = resolved.requestedPath
    revision = resolved.revision
  }

  const archiveResponse = await githubRequest(
    `https://${GITHUB_API_HOST}/repos/${parsed.owner}/${parsed.repo}/zipball/${revision}`,
  )
  const archive = await readBoundedArchive(archiveResponse)
  const packages = inspectRemoteSkillArchive(archive, { ...parsed, requestedPath })
  const repository = `${parsed.owner}/${parsed.repo}`
  const repositoryUrl = `https://github.com/${repository}`

  return {
    inspection: {
      inputUrl: parsed.inputUrl,
      repository,
      repositoryUrl,
      requestedRef,
      revision,
      catalog: parsed.catalog,
      candidates: packages.map(({ content: _content, files: _files, ...candidate }) => candidate),
    },
    packages,
  }
}

function fileMap(files: RemoteSkillFile[]): Map<string, Buffer> {
  return new Map(files.map((file) => [file.path, file.content]))
}

function equalContent(left: Buffer | undefined, right: Buffer | undefined): boolean {
  if (!left || !right) return left === right
  return left.equals(right)
}

function changeKind(
  base: Buffer | undefined,
  current: Buffer | undefined,
): RemoteSkillFileChangeKind | null {
  if (equalContent(base, current)) return null
  if (!base) return 'added'
  if (!current) return 'deleted'
  return 'modified'
}

export function compareRemoteSkillFiles(
  baseFiles: RemoteSkillFile[],
  localFiles: RemoteSkillFile[],
  latestFiles: RemoteSkillFile[],
): RemoteSkillFileDiff[] {
  const base = fileMap(baseFiles)
  const local = fileMap(localFiles)
  const latest = fileMap(latestFiles)
  const paths = new Set([...base.keys(), ...local.keys(), ...latest.keys()])

  return Array.from(paths)
    .sort((a, b) => a.localeCompare(b))
    .flatMap((path) => {
      const baseContent = base.get(path)
      const localContent = local.get(path)
      const latestContent = latest.get(path)
      const localChange = changeKind(baseContent, localContent)
      const remoteChange = changeKind(baseContent, latestContent)
      if (!localChange && !remoteChange) return []
      return [
        {
          path,
          localChange,
          remoteChange,
          conflict:
            localChange !== null &&
            remoteChange !== null &&
            !equalContent(localContent, latestContent),
        },
      ]
    })
}

export function mergeRemoteSkillFiles(
  baseFiles: RemoteSkillFile[],
  localFiles: RemoteSkillFile[],
  latestFiles: RemoteSkillFile[],
  strategy: RemoteSkillUpdateStrategy,
): { files: RemoteSkillFile[]; preservedLocalChanges: boolean } {
  const base = fileMap(baseFiles)
  const local = fileMap(localFiles)
  const latest = fileMap(latestFiles)
  const paths = new Set([...base.keys(), ...local.keys(), ...latest.keys()])
  const merged: RemoteSkillFile[] = []

  for (const path of Array.from(paths).sort((a, b) => a.localeCompare(b))) {
    const baseContent = base.get(path)
    const localContent = local.get(path)
    const latestContent = latest.get(path)
    let selected: Buffer | undefined

    if (strategy === 'overwrite' || equalContent(localContent, baseContent)) {
      selected = latestContent
    } else if (
      equalContent(latestContent, baseContent) ||
      equalContent(localContent, latestContent)
    ) {
      selected = localContent
    } else if (strategy === 'preserve_local') {
      selected = localContent
    } else {
      throw new RemoteSkillError('invalid_url', `Remote Skill update conflicts at ${path}`)
    }

    if (selected) merged.push({ path, content: Buffer.from(selected) })
  }

  return {
    files: merged,
    preservedLocalChanges:
      calculateRemoteSkillDigest(merged) !== calculateRemoteSkillDigest(latestFiles),
  }
}

export function buildRemoteSkillSource(
  inspection: RemoteSkillInspection,
  candidate: RemoteSkillCandidate,
): RemoteSkillSource {
  return {
    provider: 'github',
    catalog: inspection.catalog,
    inputUrl: inspection.inputUrl,
    repository: inspection.repository,
    repositoryUrl: inspection.repositoryUrl,
    requestedRef: inspection.requestedRef,
    path: candidate.path,
    revision: inspection.revision,
    digest: candidate.digest,
  }
}
