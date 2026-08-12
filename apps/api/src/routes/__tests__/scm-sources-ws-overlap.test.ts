import { describe, expect, it } from 'vitest'
import { defaultWorkspacesPath } from '../../lib/git-workspace.js'
import { findWorkspacesPathConflict, pathsOverlap } from '../scm-sources.js'

describe('pathsOverlap', () => {
  it('detects exact match', async () => {
    expect(pathsOverlap('/a/b', '/a/b')).toBe(true)
  })
  it('detects ancestor relation', async () => {
    expect(pathsOverlap('/a', '/a/b')).toBe(true)
    expect(pathsOverlap('/a/b', '/a')).toBe(true)
  })
  it('does not false-match sibling with shared prefix', async () => {
    expect(pathsOverlap('/a/bcd', '/a/b')).toBe(false)
  })
})

describe('findWorkspacesPathConflict', () => {
  const sources = [
    { id: 'scm_1', name: 'one', localPath: '/repos/one', workspacesPath: '/ws/one' },
    { id: 'scm_2', name: 'two', localPath: '/repos/two', workspacesPath: '/ws/two' },
    { id: 'scm_3', name: 'three', localPath: '/repos/three', workspacesPath: null },
  ]

  it('returns null when no overlap', async () => {
    expect(findWorkspacesPathConflict(sources, '/ws/three')).toBeNull()
  })

  it('flags exact-match conflict', async () => {
    const hit = findWorkspacesPathConflict(sources, '/ws/one')
    expect(hit?.id).toBe('scm_1')
  })

  it('flags when candidate is child of existing', async () => {
    const hit = findWorkspacesPathConflict(sources, '/ws/one/sub')
    expect(hit?.id).toBe('scm_1')
  })

  it('flags when candidate is parent of existing', async () => {
    const hit = findWorkspacesPathConflict(sources, '/ws')
    // Either /ws/one or /ws/two — both overlap; just assert *some* conflict
    expect(hit).not.toBeNull()
  })

  it('flags overlap with another source checkout', () => {
    const hit = findWorkspacesPathConflict(sources, '/repos/one/worktrees')
    expect(hit?.id).toBe('scm_1')
  })

  it('excludes self by id', async () => {
    const hit = findWorkspacesPathConflict(sources, '/ws/one', 'scm_1')
    expect(hit).toBeNull()
  })

  it('ignores rows with null workspacesPath for unrelated path', async () => {
    expect(findWorkspacesPathConflict(sources, '/nonexistent')).toBeNull()
  })

  it('expands null workspacesPath to defaultWorkspacesPath(id) and flags overlap', async () => {
    // scm_3 的 workspacesPath 为 null，运行时等价于 ~/.a2wave/workspaces/3
    // （indexOf('_')<0 时 suffix 就是整个 id）。
    // 新 source 显式填到该默认目录下必须被挡住。
    const defaultRoot = defaultWorkspacesPath('scm_3')
    const hit = findWorkspacesPathConflict(sources, `${defaultRoot}/sub`)
    expect(hit?.id).toBe('scm_3')
  })
})
