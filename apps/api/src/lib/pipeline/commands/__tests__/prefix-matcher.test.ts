/**
 * matchByLongestPrefix 单测。
 *
 * 行为等价于旧 `commands/plugin.ts` 里的 `tryMatchPrefix`，但接收 CommandPlugin 列表
 * 而不是单个 prefixes 数组。从旧 plugin.test.ts 迁移过来。
 */
import { describe, expect, it } from 'vitest'
import { createCommandPlugin } from '../factory.js'
import { matchByLongestPrefix } from '../prefix-matcher.js'

const cmdNew = createCommandPlugin({ commandName: 'new', prefixes: ['/new'] })

describe('matchByLongestPrefix — basic match', () => {
  it('bare prefix on EOS matches', async () => {
    const r = matchByLongestPrefix('/new', [cmdNew])
    expect(r?.plugin.commandName).toBe('new')
    expect(r?.rest).toBe('')
  })

  it('prefix + space + text → rest 是剥掉前缀和空白后的内容', async () => {
    const r = matchByLongestPrefix('/new hello', [cmdNew])
    expect(r?.plugin.commandName).toBe('new')
    expect(r?.rest).toBe('hello')
  })

  it('prefix + tab + text 也命中（word-boundary 接受任意空白）', async () => {
    const r = matchByLongestPrefix('/new\thello', [cmdNew])
    expect(r?.plugin.commandName).toBe('new')
    expect(r?.rest).toBe('hello')
  })

  it('plain text without prefix returns null', async () => {
    const r = matchByLongestPrefix('plain text', [cmdNew])
    expect(r).toBeNull()
  })
})

describe('matchByLongestPrefix — word boundary 防误命中', () => {
  it('does NOT match /new when followed by ASCII letters (/newer)', async () => {
    const r = matchByLongestPrefix('/newer please', [cmdNew])
    expect(r).toBeNull()
  })

  it('does NOT match /new when followed by digits (/new123)', async () => {
    const r = matchByLongestPrefix('/new123', [cmdNew])
    expect(r).toBeNull()
  })

  it('does NOT match /new when followed by punctuation (/new-foo)', async () => {
    const r = matchByLongestPrefix('/new-foo', [cmdNew])
    expect(r).toBeNull()
  })
})

describe('matchByLongestPrefix — 单 plugin 内多前缀长度倒序', () => {
  it('matches longer prefix first when prefixes share a common start', async () => {
    const cmd = createCommandPlugin({ commandName: 'new', prefixes: ['/n', '/new'] })
    const r = matchByLongestPrefix('/new world', [cmd])
    expect(r?.plugin.commandName).toBe('new')
    expect(r?.rest).toBe('world')
  })

  it('shorter prefix still works on its own', async () => {
    const cmd = createCommandPlugin({ commandName: 'new', prefixes: ['/n', '/new'] })
    const r = matchByLongestPrefix('/n hello', [cmd])
    expect(r?.plugin.commandName).toBe('new')
    expect(r?.rest).toBe('hello')
  })
})

describe('matchByLongestPrefix — 空 prefix 过滤', () => {
  it('filters out empty-string prefixes', async () => {
    const cmd = createCommandPlugin({ commandName: 'new', prefixes: [''] })
    const r = matchByLongestPrefix('anything', [cmd])
    expect(r).toBeNull()
  })

  it('mixed empty + valid: 空被过滤，valid 正常匹配', async () => {
    const cmd = createCommandPlugin({ commandName: 'new', prefixes: ['', '/new'] })
    const r = matchByLongestPrefix('/new go', [cmd])
    expect(r?.plugin.commandName).toBe('new')
    expect(r?.rest).toBe('go')
  })
})

describe('matchByLongestPrefix — trim & 短路', () => {
  it('trims LEADING whitespace before matching', async () => {
    const r = matchByLongestPrefix('   /new go', [cmdNew])
    expect(r?.plugin.commandName).toBe('new')
    expect(r?.rest).toBe('go')
  })

  it('short-circuits to null on empty rawText', async () => {
    const r = matchByLongestPrefix('', [cmdNew])
    expect(r).toBeNull()
  })

  it('short-circuits to null on whitespace-only rawText', async () => {
    const r = matchByLongestPrefix('     ', [cmdNew])
    expect(r).toBeNull()
  })

  it('tolerates undefined rawText', async () => {
    const r = matchByLongestPrefix(undefined, [cmdNew])
    expect(r).toBeNull()
  })
})

describe('matchByLongestPrefix — 多 command plugin', () => {
  it('returns the first registered command whose prefix matches', async () => {
    const cmdA = createCommandPlugin({ commandName: 'a', prefixes: ['/aaa'] })
    const cmdB = createCommandPlugin({ commandName: 'b', prefixes: ['/bbb'] })
    expect(matchByLongestPrefix('/aaa hi', [cmdA, cmdB])?.plugin.commandName).toBe('a')
    expect(matchByLongestPrefix('/bbb hi', [cmdA, cmdB])?.plugin.commandName).toBe('b')
  })

  it('returns null when none of the candidates match', async () => {
    const cmdA = createCommandPlugin({ commandName: 'a', prefixes: ['/aaa'] })
    const cmdB = createCommandPlugin({ commandName: 'b', prefixes: ['/bbb'] })
    expect(matchByLongestPrefix('/ccc hi', [cmdA, cmdB])).toBeNull()
  })

  it('empty candidates list → null', async () => {
    expect(matchByLongestPrefix('/anything', [])).toBeNull()
  })
})
