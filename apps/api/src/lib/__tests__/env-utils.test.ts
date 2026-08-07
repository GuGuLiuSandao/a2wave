import { describe, expect, it } from 'vitest'
import { unsetEnv } from '../env-utils.js'

describe('unsetEnv', () => {
  it('deletes the key instead of assigning undefined', async () => {
    const env: Record<string, string | undefined> = { API_KEY: 'secret' }

    unsetEnv(env, 'API_KEY')

    expect(Object.prototype.hasOwnProperty.call(env, 'API_KEY')).toBe(false)
    expect(env.API_KEY).toBeUndefined()
  })

  it('is safe when the key is already absent', async () => {
    const env: Record<string, string | undefined> = {}

    expect(() => unsetEnv(env, 'API_KEY')).not.toThrow()
  })
})
