import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const packageJson = JSON.parse(readFileSync(join(process.cwd(), 'package.json'), 'utf-8')) as {
  name: string
  description: string
  license: string
  homepage: string
  bugs: { url: string }
  repository: { type: string; url: string; directory: string }
  keywords: string[]
  engines: { node: string }
  bin: Record<string, string>
  files: string[]
  publishConfig?: { registry?: string; access?: string }
}

describe('package metadata', () => {
  it('publishes the CLI under its public npm identity', () => {
    expect(packageJson.name).toBe('a2wave')
    // A single command name. `wave` was dropped before the package was ever
    // published, so no installed binary depends on it.
    expect(packageJson.bin).toEqual({ a2wave: 'dist/index.cjs' })
    expect(packageJson.description).toBe(
      'Command-line client for the a2wave agent orchestration platform',
    )
    expect(packageJson.license).toBe('Apache-2.0')
    expect(packageJson.homepage).toBe('https://github.com/LilithGames/a2wave#readme')
    expect(packageJson.bugs.url).toBe('https://github.com/LilithGames/a2wave/issues')
    expect(packageJson.repository).toEqual({
      type: 'git',
      url: 'git+https://github.com/LilithGames/a2wave.git',
      directory: 'apps/cli',
    })
    expect(packageJson.keywords).toEqual(['a2wave', 'agent', 'orchestration', 'cli'])
    expect(packageJson.engines.node).toBe('>=22.0.0')
    expect(packageJson.publishConfig?.access).toBe('public')
  })

  // publishConfig.registry takes precedence over both `npm publish --registry`
  // and the registry setup-node writes into the runner .npmrc, so pinning one
  // here would silently redirect every release away from public npm.
  it('does not pin a publish registry', () => {
    expect(packageJson.publishConfig?.registry).toBeUndefined()
  })

  it('limits published package contents to runtime and distribution files', () => {
    expect(packageJson.files).toEqual(['dist', 'README.md', 'LICENSE', 'NOTICE'])
  })

  it('ships the applicable legal notices', () => {
    expect(readFileSync(join(process.cwd(), 'LICENSE'), 'utf-8')).toBe(
      readFileSync(join(process.cwd(), '../../LICENSE'), 'utf-8'),
    )
    const notice = readFileSync(join(process.cwd(), 'NOTICE'), 'utf-8')
    expect(notice).toContain('a2wave CLI\nCopyright 2026 Lilith Games')
    expect(notice).not.toContain('apps/api/')
  })
})
