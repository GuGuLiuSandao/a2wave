import { existsSync, realpathSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, isAbsolute, join, resolve, sep } from 'node:path'
import { SETTINGS_DEFAULTS } from '@a2wave/shared'
import { eq } from 'drizzle-orm'
import { db } from '../db/client.js'
import { users } from '../db/schema.js'
import { env } from '../env.js'
import { defaultWorkspacesPath } from './git-workspace.js'

interface ValidationOptions {
  protectedPaths?: string[]
  allowOutsideConfiguredRoots?: boolean
  platform?: NodeJS.Platform
}

function normalizeForComparison(value: string, platform: NodeJS.Platform): string {
  const resolved = resolve(value)
  return platform === 'win32' ? resolved.toLowerCase() : resolved
}

function isSameOrDescendant(parent: string, candidate: string, platform: NodeJS.Platform): boolean {
  const normalizedParent = normalizeForComparison(parent, platform)
  const normalizedCandidate = normalizeForComparison(candidate, platform)
  const parentPrefix = normalizedParent.endsWith(sep)
    ? normalizedParent
    : `${normalizedParent}${sep}`
  return normalizedCandidate === normalizedParent || normalizedCandidate.startsWith(parentPrefix)
}

function pathsOverlap(a: string, b: string, platform: NodeJS.Platform): boolean {
  return isSameOrDescendant(a, b, platform) || isSameOrDescendant(b, a, platform)
}

/**
 * Resolve every existing ancestor through realpath, then append the missing
 * suffix. This catches a symlink in the approved path even before the final
 * per-source workspaces directory has been created.
 */
function canonicalizeThroughExistingAncestor(value: string): string {
  const suffix: string[] = []
  let cursor = resolve(value)

  while (!existsSync(cursor)) {
    const parent = dirname(cursor)
    if (parent === cursor) break
    suffix.unshift(basename(cursor))
    cursor = parent
  }

  try {
    return resolve(realpathSync(cursor), ...suffix)
  } catch {
    return resolve(value)
  }
}

export function getDefaultScmWorkspacesAllowedRoot(): string {
  return join(homedir(), '.a2wave', 'workspaces')
}

function getProtectedPlatformPaths(): string[] {
  return [
    env.DATABASE_URL,
    env.A2WAVE_SKILLS_STORAGE,
    env.A2WAVE_KB_STORAGE,
    env.A2WAVE_MEMORY_STORAGE,
    env.LOG_FILE_PATH,
    SETTINGS_DEFAULTS.artifacts.storagePath,
    SETTINGS_DEFAULTS.attachments.stagingPath,
  ].map((value) => canonicalizeThroughExistingAncestor(value))
}

/**
 * Validate a per-source workspaces root against operator-approved roots and
 * platform-owned storage. Returns a user-facing error, or null when safe.
 */
export function validateScmWorkspacesRoot(
  candidate: string,
  configuredAllowedRoots: string = env.SCM_WORKSPACES_ALLOWED_ROOTS,
  options: ValidationOptions = {},
): string | null {
  if (!isAbsolute(candidate)) return 'workspacesPath must be an absolute path'

  const candidatePath = canonicalizeThroughExistingAncestor(candidate)
  const platform = options.platform ?? process.platform
  const configuredRoots = configuredAllowedRoots
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean)
  const allowedRoots = [getDefaultScmWorkspacesAllowedRoot(), ...configuredRoots]
    .filter(isAbsolute)
    .map((root) => canonicalizeThroughExistingAncestor(root))

  if (
    !options.allowOutsideConfiguredRoots &&
    !allowedRoots.some((root) => isSameOrDescendant(root, candidatePath, platform))
  ) {
    return 'workspacesPath must be inside the default a2wave workspaces directory or a root listed in SCM_WORKSPACES_ALLOWED_ROOTS'
  }

  const protectedPaths = (options.protectedPaths ?? getProtectedPlatformPaths()).map((value) =>
    canonicalizeThroughExistingAncestor(value),
  )
  if (
    protectedPaths.some((protectedPath) => pathsOverlap(protectedPath, candidatePath, platform))
  ) {
    return 'workspacesPath must not overlap protected platform storage'
  }

  return null
}

export interface StoredScmSourceWorkspace {
  id: string
  workspacesPath?: string | null
  userId?: string | null
}

/**
 * Runtime backstop for rows created before workspace-root validation existed.
 * The owner id is resolved to a live role on every use; a persisted admin bit
 * would keep arbitrary-root access after demotion or disable.
 */
export async function validateStoredScmWorkspacesRoot(
  source: StoredScmSourceWorkspace,
  ownerIsActiveAdmin?: boolean,
): Promise<string | null> {
  let allowOutsideConfiguredRoots = ownerIsActiveAdmin
  if (allowOutsideConfiguredRoots === undefined) {
    const owner = source.userId
      ? (
          await db
            .select({ role: users.role, isActive: users.isActive })
            .from(users)
            .where(eq(users.id, source.userId))
            .limit(1)
        )[0]
      : undefined
    allowOutsideConfiguredRoots = owner?.role === 'admin' && owner.isActive === true
  }

  const effectiveRoot = source.workspacesPath ?? defaultWorkspacesPath(source.id)
  const error = validateScmWorkspacesRoot(effectiveRoot, undefined, {
    allowOutsideConfiguredRoots,
  })
  if (!error) return null
  return `Unsafe saved workspacesPath: ${error}. Update this SCM source to an approved dedicated root before using workspaces`
}

export class UnsafeScmWorkspacesRootError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'UnsafeScmWorkspacesRootError'
  }
}

export async function assertStoredScmWorkspacesRoot(
  source: StoredScmSourceWorkspace,
  ownerIsActiveAdmin?: boolean,
): Promise<void> {
  const error = await validateStoredScmWorkspacesRoot(source, ownerIsActiveAdmin)
  if (error) throw new UnsafeScmWorkspacesRootError(error)
}
