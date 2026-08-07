import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const __dirname = dirname(fileURLToPath(import.meta.url))
const rootDir = resolve(__dirname, '../../../../..')

describe('Dockerfile MCP build outputs', () => {
  it('bundles every built-in MCP subprocess used in production', async () => {
    const apiPackageJson = readFileSync(resolve(rootDir, 'apps/api/package.json'), 'utf-8')
    const dockerfile = readFileSync(resolve(rootDir, 'Dockerfile'), 'utf-8')

    expect(apiPackageJson).toContain('src/mcp-servers/a2wave-agent-router.ts')
    expect(apiPackageJson).toContain('src/mcp-servers/a2wave-platform-admin.ts')
    expect(apiPackageJson).toContain('src/mcp-servers/a2wave-mcp-group-proxy.ts')
    expect(apiPackageJson).toContain('--format esm')
    // Matched as a pattern rather than a fixed string: the point of the
    // assertion is that the built dist (MCP subprocess bundles included) is
    // copied out of the builder stage, not which COPY flags are in play.
    // `--chown` was added for ownership hygiene and broke the literal form.
    expect(dockerfile).toMatch(
      /COPY --from=builder(?: --\S+)* \/app\/apps\/api\/dist apps\/api\/dist/,
    )
  })
})
