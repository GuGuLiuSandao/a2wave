#!/usr/bin/env node
/**
 * Docker build-context hygiene gate.
 *
 * It checks three things without requiring a Docker daemon or a third-party parser:
 *   1. representative local secrets, Agent configuration, databases, and build output are ignored;
 *   2. public files that look similar to secrets (notably .env.example) remain visible; and
 *   3. every local Dockerfile COPY source exists and remains in the context. For directory COPY
 *      sources, every tracked file must remain visible except AGENTS.md, which is intentionally
 *      context-only metadata rather than a build input.
 *
 * The matcher covers the Docker ignore syntax used by this repository: comments, negation, `*`,
 * `?`, `**`, root-relative paths, basename patterns, and directory patterns. Unsupported future
 * COPY forms fail closed so the gate cannot silently stop protecting a newly structured Dockerfile.
 */
import { execFileSync } from 'node:child_process'
import { existsSync, lstatSync, readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const DOCKERIGNORE = '.dockerignore'
const DOCKERFILE = 'Dockerfile'
const scanAll = process.argv.includes('--all')

const REQUIRED_EXCLUDED = [
  '.kubeconfig',
  'cluster.kubeconfig',
  'kubeconfig',
  '.claude/settings.json',
  '.codex/config.toml',
  '.agents/skills/local/SKILL.md',
  '.cursor/settings.json',
  '.continue/config.json',
  '.gemini/settings.json',
  '.windsurf/settings.json',
  '.roo/config.json',
  '.opencode/config.json',
  '.aider.conf.yml',
  '.mcp.json',
  'AGENTS.md',
  'CLAUDE.md',
  'CODEX.md',
  'GEMINI.md',
  'apps/api/AGENTS.md',
  '.env',
  '.env.local',
  '.env.production',
  'apps/api/.env',
  '.envrc',
  '.direnv/allow',
  '.secrets/local.json',
  'service-account-prod.json',
  'private.pem',
  'tls.key',
  'tls.crt',
  'tls.cer',
  'tls.der',
  'certificate.p12',
  'certificate.pfx',
  'certificate.pkcs8',
  'certificate.pkcs12',
  'client.ovpn',
  'trust.jks',
  'signing.keystore',
  'id_rsa',
  '.ssh/id_ed25519',
  '.credentials.json',
  'credentials.json',
  'auth.json',
  '.npmrc',
  '.netrc',
  'data/a2wave.db',
  'apps/api/data/a2wave.sqlite',
  'apps/api/data/a2wave.db-wal',
  'coverage/index.html',
  'playwright-report/index.html',
  'test-results/results.json',
  'logs/api.log',
  'app.log.1',
  'node_modules/pkg/index.js',
  'apps/api/node_modules/pkg/index.js',
  'apps/api/dist/index.js',
  'apps/web/build/index.html',
  '.cache/tool/state.json',
  '.pnpm-store/v3/index.json',
  '.turbo/cache.json',
  'apps/web/.vite/manifest.json',
  'apps/web/.parcel-cache/index',
  'apps/web/.eslintcache',
  'apps/api/tsconfig.tsbuildinfo',
]

const REQUIRED_INCLUDED = [
  DOCKERFILE,
  DOCKERIGNORE,
  '.env.example',
  'apps/api/.env.example',
  'LICENSE',
  'NOTICE',
  'README.md',
  'package.json',
  'pnpm-lock.yaml',
]

function escapeRegexChar(char) {
  return /[\\^$.*+?()[\]{}|]/.test(char) ? `\\${char}` : char
}

/** Convert one normalised Docker ignore pattern to a regular expression. */
export function dockerPatternToRegex(rawPattern) {
  let pattern = rawPattern.replace(/\\/g, '/').replace(/^\/+/, '')
  pattern = pattern.replace(/\/+$/, '')
  const hasSlash = pattern.includes('/')

  let body = ''
  for (let i = 0; i < pattern.length; i++) {
    const char = pattern[i]
    if (char === '*') {
      if (pattern[i + 1] === '*') {
        i++
        if (pattern[i + 1] === '/') {
          i++
          body += '(?:.*/)?'
        } else {
          body += '.*'
        }
      } else {
        body += '[^/]*'
      }
    } else if (char === '?') {
      body += '[^/]'
    } else {
      body += escapeRegexChar(char)
    }
  }

  if (!hasSlash) {
    return new RegExp(`(?:^|/)${body}(?:$|/)`)
  }
  return new RegExp(`^${body}(?:$|/)`)
}

/** Parse .dockerignore in order; the last matching rule wins. */
export function parseDockerignore(content) {
  const rules = []
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim()
    if (!line || line.startsWith('#')) continue
    const negated = line.startsWith('!')
    const pattern = negated ? line.slice(1) : line
    if (!pattern || pattern === '.') continue
    rules.push({ pattern, negated, regex: dockerPatternToRegex(pattern) })
  }
  return rules
}

/** Apply ordered Docker ignore rules to a POSIX path relative to the build-context root. */
export function isDockerIgnored(path, rules) {
  const normalised = path.replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/+$/, '')
  let ignored = false
  for (const rule of rules) {
    if (rule.regex.test(normalised)) ignored = !rule.negated
  }
  return ignored
}

function shellTokens(value) {
  const tokens = []
  const re = /"(?:\\.|[^"\\])*"|'[^']*'|\S+/g
  for (const match of value.matchAll(re)) {
    const token = match[0]
    tokens.push(
      (token.startsWith('"') && token.endsWith('"')) ||
        (token.startsWith("'") && token.endsWith("'"))
        ? token.slice(1, -1)
        : token,
    )
  }
  return tokens
}

/** Extract local COPY sources. Stage-to-stage COPY statements are intentionally excluded. */
export function dockerfileLocalCopySources(content) {
  const logicalLines = content.replace(/\\\r?\n\s*/g, ' ').split(/\r?\n/)
  const sources = []
  for (const [index, rawLine] of logicalLines.entries()) {
    const match = /^\s*COPY\s+(.+)$/i.exec(rawLine)
    if (!match) continue

    const body = match[1].trim()
    let tokens
    if (body.startsWith('[')) {
      try {
        tokens = JSON.parse(body)
      } catch (error) {
        throw new Error(`Dockerfile:${index + 1} has invalid JSON COPY syntax: ${error.message}`)
      }
    } else {
      tokens = shellTokens(body)
    }

    let fromStage = false
    while (tokens[0]?.startsWith('--')) {
      const flag = tokens.shift()
      if (flag === '--from' || flag.startsWith('--from=')) fromStage = true
      if (flag === '--from') tokens.shift()
    }
    if (fromStage) continue
    if (tokens.length < 2) {
      throw new Error(
        `Dockerfile:${index + 1} COPY must have at least one source and a destination`,
      )
    }

    for (const source of tokens.slice(0, -1)) {
      if (/[*?$[{]/.test(source) || source.startsWith('http://') || source.startsWith('https://')) {
        throw new Error(
          `Dockerfile:${index + 1} uses unsupported local COPY source ${JSON.stringify(source)}; extend this gate before changing the build context`,
        )
      }
      sources.push(source.replace(/^\.\//, '').replace(/\/+$/, ''))
    }
  }
  return [...new Set(sources)]
}

function stagedNames() {
  try {
    return new Set(
      execFileSync('git', ['diff', '--cached', '--name-only', '--diff-filter=ACMR'], {
        cwd: ROOT,
        encoding: 'utf8',
      })
        .split('\n')
        .map((line) => line.trim())
        .filter(Boolean),
    )
  } catch {
    return new Set()
  }
}

const staged = scanAll ? new Set() : stagedNames()

/** Read the post-commit version in hook mode, or the working tree with --all. */
function readRepoFile(path) {
  if (scanAll) return readFileSync(resolve(ROOT, path), 'utf8')
  try {
    const ref = staged.has(path) ? `:${path}` : `HEAD:${path}`
    return execFileSync('git', ['show', ref], { cwd: ROOT, encoding: 'utf8' })
  } catch {
    return readFileSync(resolve(ROOT, path), 'utf8')
  }
}

function trackedFilesUnder(path) {
  return execFileSync('git', ['ls-files', '-z', '--', path], { cwd: ROOT })
    .toString('utf8')
    .split('\0')
    .filter(Boolean)
}

function isAllowedContextMetadata(path) {
  return /(^|\/)(AGENTS|CLAUDE|CODEX|GEMINI)\.md$/.test(path)
}

export function checkDockerContext({ dockerignore, dockerfile }) {
  const rules = parseDockerignore(dockerignore)
  const errors = []

  for (const path of REQUIRED_EXCLUDED) {
    if (!isDockerIgnored(path, rules))
      errors.push(`${path} must be excluded from the Docker context`)
  }
  for (const path of REQUIRED_INCLUDED) {
    if (isDockerIgnored(path, rules))
      errors.push(`${path} must remain visible in the Docker context`)
  }

  let copySources = []
  try {
    copySources = dockerfileLocalCopySources(dockerfile)
  } catch (error) {
    errors.push(error.message)
    return { copySources, errors }
  }

  for (const source of copySources) {
    const absolute = resolve(ROOT, source)
    if (!existsSync(absolute)) {
      errors.push(`Dockerfile COPY source does not exist: ${source}`)
      continue
    }
    if (isDockerIgnored(source, rules)) {
      errors.push(`Dockerfile COPY source is excluded by .dockerignore: ${source}`)
      continue
    }

    if (!lstatSync(absolute).isDirectory()) continue
    const trackedFiles = trackedFilesUnder(source)
    if (trackedFiles.length === 0) {
      errors.push(`directory COPY source contains no tracked files: ${source}`)
      continue
    }
    const excludedTracked = trackedFiles.filter(
      (file) => isDockerIgnored(file, rules) && !isAllowedContextMetadata(file),
    )
    if (excludedTracked.length > 0) {
      errors.push(
        `directory COPY source ${source}/ loses tracked build inputs: ${excludedTracked.slice(0, 5).join(', ')}${excludedTracked.length > 5 ? ' …' : ''}`,
      )
    }
  }

  return { copySources, errors }
}

function main() {
  const result = checkDockerContext({
    dockerignore: readRepoFile(DOCKERIGNORE),
    dockerfile: readRepoFile(DOCKERFILE),
  })
  if (result.errors.length > 0) {
    console.error('\n[docker-context] ✗ build-context hygiene gate failed:\n')
    for (const error of result.errors) console.error(`  - ${error}`)
    console.error(
      '\nUpdate .dockerignore or extend the gate deliberately before changing COPY inputs.\n',
    )
    process.exit(1)
  }

  console.log(
    `[docker-context] ✓ ${REQUIRED_EXCLUDED.length} sensitive/output probes excluded; ${result.copySources.length} local COPY sources visible`,
  )
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main()
