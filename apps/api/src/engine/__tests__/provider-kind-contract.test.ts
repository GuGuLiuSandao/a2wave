import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { PROVIDER_KINDS, providerKindSchema } from '@a2wave/shared'
import { describe, expect, it } from 'vitest'
import { providers } from '../../db/schema.js'

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../../../..')

function readJson<T>(path: string): T {
  return JSON.parse(readFileSync(resolve(repositoryRoot, path), 'utf8')) as T
}

describe('Provider kind contract', () => {
  it('keeps runtime schemas, persistence, and CLI installation inventories aligned', async () => {
    const lock = readJson<{ providers: Array<{ kind: string }> }>('provider-cli-lock.json')
    const lockSchema = readJson<{
      properties: {
        providers: { items: { properties: { kind: { enum: string[] } } } }
      }
    }>('scripts/provider-clis/provider-cli-lock.schema.json')

    const expected = [...PROVIDER_KINDS]
    expect(providerKindSchema.options).toEqual(expected)
    expect(providers.kind.enumValues).toEqual(expected)
    expect(lock.providers.map(({ kind }) => kind).sort()).toEqual([...expected].sort())
    expect(lockSchema.properties.providers.items.properties.kind.enum).toEqual(expected)
  })
})
