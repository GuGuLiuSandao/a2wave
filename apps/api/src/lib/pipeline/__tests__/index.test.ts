/**
 * pipeline/index barrel — buildDefaultPlugins / buildPlugins coverage.
 */
import { describe, expect, it } from 'vitest'
import * as pipeline from '../index.js'
import { buildDefaultPlugins, buildPlugins, emit, emitStreamFrame } from '../index.js'
import type { LifecyclePlugin } from '../index.js'

describe('pipeline/index barrel', () => {
  it('buildDefaultPlugins returns [core:command-dispatch, cmd:new]', async () => {
    const plugins = buildDefaultPlugins()
    expect(plugins).toHaveLength(2)
    expect(plugins[0]?.name).toBe('core:command-dispatch')
    expect(plugins[0]?.priority).toBe(10)
    expect(plugins[1]?.name).toBe('cmd:new')
    expect(plugins[1]?.priority).toBe(20)
  })

  it('buildPlugins returns a defensive copy of the provided list', async () => {
    const custom: LifecyclePlugin[] = [{ name: 'obs:test' }]
    const result = buildPlugins(custom)
    expect(result).toEqual(custom)
    // Defensive copy: mutating the source array does not affect the result.
    custom.push({ name: 'obs:added-later' })
    expect(result).toHaveLength(1)
  })

  it('re-exports emit and emitStreamFrame', async () => {
    expect(typeof emit).toBe('function')
    expect(typeof emitStreamFrame).toBe('function')
  })

  it('does not export global test plugin mutators', async () => {
    expect(Object.keys(pipeline)).not.toContain('_registerTestPlugin')
    expect(Object.keys(pipeline)).not.toContain('_resetTestPlugins')
  })
})
