import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { and, eq, isNull } from 'drizzle-orm'
import { db } from '../db/client.js'
import { skills } from '../db/schema.js'
import { env } from '../env.js'
import { createId } from './id.js'
import { logger } from './logger.js'
import { getSkillStoragePath, parseSkillMd } from './skill-storage.js'

const __dirname = dirname(fileURLToPath(import.meta.url))

interface BuiltinSkillDefinition {
  name: string
  description: string | null
  content: string
  sourceDir: string
}

function resolveBuiltinSkillsDir(): string {
  const isDev = env.NODE_ENV !== 'production'
  return isDev ? resolve(__dirname, '..', 'builtin-skills') : resolve(__dirname, 'builtin-skills')
}

function getBuiltinSkillDefinitions(): BuiltinSkillDefinition[] {
  const builtinDir = resolveBuiltinSkillsDir()
  if (!existsSync(builtinDir)) {
    logger.warn({ path: builtinDir }, 'Built-in skills dir not found, skipping seed')
    return []
  }

  // 每个子目录即一个内置技能（须含 SKILL.md）；无 SKILL.md 的目录跳过。
  const definitions: BuiltinSkillDefinition[] = []
  for (const entry of readdirSync(builtinDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue
    const sourceDir = join(builtinDir, entry.name)
    const skillMdPath = join(sourceDir, 'SKILL.md')
    if (!existsSync(skillMdPath)) {
      logger.warn({ path: skillMdPath }, 'Built-in skill SKILL.md not found, skipping')
      continue
    }
    const parsed = parseSkillMd(readFileSync(skillMdPath, 'utf-8'))
    definitions.push({
      name: parsed.name,
      description: parsed.description,
      content: parsed.body,
      sourceDir,
    })
  }
  return definitions
}

function syncSkillFiles(sourceDir: string, targetDir: string): void {
  if (existsSync(targetDir)) {
    rmSync(targetDir, { recursive: true, force: true })
  }
  mkdirSync(targetDir, { recursive: true })
  cpSync(sourceDir, targetDir, { recursive: true })
}

export async function seedBuiltinSkills(): Promise<void> {
  for (const builtin of getBuiltinSkillDefinitions()) {
    // Built-ins are identified by both name and system ownership. A user-created
    // same-name Skill must remain a regular private row and must never be updated
    // or published by platform seeding.
    const existing = (
      await db
        .select()
        .from(skills)
        .where(and(eq(skills.name, builtin.name), isNull(skills.userId)))
        .limit(1)
    )[0]

    if (!existing) {
      const id = createId('skl')
      await db.insert(skills).values({
        id,
        name: builtin.name,
        description: builtin.description,
        content: builtin.content,
        storagePath: id,
        userId: null,
        visibility: 'all-users',
      })
      syncSkillFiles(builtin.sourceDir, getSkillStoragePath(id))
      logger.info(`Seeded built-in skill: ${builtin.name} (${id})`)
      continue
    }

    await db
      .update(skills)
      .set({
        name: builtin.name,
        content: builtin.content,
        description: builtin.description,
        visibility: 'all-users',
        updatedAt: new Date(),
      })
      .where(eq(skills.id, existing.id))
    const storagePath = existing.storagePath ?? existing.id
    syncSkillFiles(builtin.sourceDir, getSkillStoragePath(storagePath))
    logger.info(`Updated built-in skill: ${builtin.name}`)
  }
}
