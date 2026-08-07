import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { describe, it } from 'node:test'
import { fileURLToPath } from 'node:url'
import {
  checkDockerContext,
  dockerfileLocalCopySources,
  isDockerIgnored,
  parseDockerignore,
} from '../check-docker-context.mjs'

const SCRIPT = fileURLToPath(new URL('../check-docker-context.mjs', import.meta.url))
const ROOT = fileURLToPath(new URL('../../..', import.meta.url))
const DOCKERIGNORE = readFileSync(new URL('../../../.dockerignore', import.meta.url), 'utf8')
const DOCKERFILE = readFileSync(new URL('../../../Dockerfile', import.meta.url), 'utf8')

describe('Docker ignore matcher', () => {
  it('applies nested globs and last-match negation', () => {
    const rules = parseDockerignore(`
      **/.env*
      !**/.env.example
      **/data/
      **/*.pem
    `)

    assert.equal(isDockerIgnored('.env', rules), true)
    assert.equal(isDockerIgnored('apps/api/.env.local', rules), true)
    assert.equal(isDockerIgnored('.env.example', rules), false)
    assert.equal(isDockerIgnored('apps/api/.env.example', rules), false)
    assert.equal(isDockerIgnored('apps/api/data/a2wave.db', rules), true)
    assert.equal(isDockerIgnored('certs/server.pem', rules), true)
  })
})

describe('Dockerfile COPY parser', () => {
  it('returns local sources and skips stage-to-stage copies', () => {
    const sources = dockerfileLocalCopySources(`
      COPY --chown=app:app package.json README.md ./
      COPY --from=builder /app/dist ./dist
      COPY ["scripts/start.mjs", "/app/start.mjs"]
    `)

    assert.deepEqual(sources, ['package.json', 'README.md', 'scripts/start.mjs'])
  })

  it('fails closed for a COPY glob the gate does not model', () => {
    assert.throws(
      () => dockerfileLocalCopySources('COPY packages/*.json packages/'),
      /unsupported local COPY source/,
    )
  })
})

describe('Docker context gate', () => {
  it('passes the repository Dockerfile and .dockerignore together', () => {
    const result = spawnSync(process.execPath, [SCRIPT, '--all'], {
      cwd: ROOT,
      encoding: 'utf8',
    })

    assert.equal(result.status, 0, `${result.stdout}${result.stderr}`)
    assert.match(result.stdout, /sensitive\/output probes excluded/)
    assert.match(result.stdout, /local COPY sources visible/)
  })

  it('fails when kubeconfig coverage is removed', () => {
    const weakened = DOCKERIGNORE.replace('*.kubeconfig\n.kubeconfig\nkubeconfig\n', '')
    const result = checkDockerContext({ dockerignore: weakened, dockerfile: DOCKERFILE })

    assert.ok(result.errors.some((error) => error.includes('.kubeconfig must be excluded')))
  })

  it('fails when a tracked directory COPY source is excluded', () => {
    const result = checkDockerContext({
      dockerignore: `${DOCKERIGNORE}\napps/api/\n`,
      dockerfile: DOCKERFILE,
    })

    assert.ok(
      result.errors.some((error) =>
        error.includes('Dockerfile COPY source is excluded by .dockerignore: apps/api'),
      ),
    )
  })
})
