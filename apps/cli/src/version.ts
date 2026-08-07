import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

interface PackageJson {
  name?: string
  version?: string
}

function readPackageJson(): PackageJson {
  // Works both when running from src (tsx, ESM) and from the tsup single-file
  // CJS bundle in dist: package.json sits one level above either directory.
  const dir = typeof __dirname !== 'undefined' ? __dirname : dirname(fileURLToPath(import.meta.url))
  return JSON.parse(readFileSync(join(dir, '..', 'package.json'), 'utf-8')) as PackageJson
}

export function getVersion(): string {
  try {
    return readPackageJson().version ?? '0.0.0'
  } catch {
    return '0.0.0'
  }
}

export function getPackageName(): string | null {
  try {
    return readPackageJson().name ?? null
  } catch {
    return null
  }
}
