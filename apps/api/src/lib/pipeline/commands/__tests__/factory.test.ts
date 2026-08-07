/**
 * createCommandPlugin factory 单测。
 *
 * 覆盖：
 *   - CommandSpec 字段透传（commandName / prefixes / allowedContexts / emptyTextFallback / longRunningAck）
 *   - LifecyclePlugin 必要字段（name / priority / onBeforeRun 钩子）
 *   - onBeforeRun 在 ctx.matchedCommand !== init.commandName 时短路（不副作用）
 *   - applySession（override null / string / undefined）
 *   - runConfigPatch 浅合并到 ctx.runConfigPatch
 *   - longRunningAck 静态字符串 / 动态函数
 */
import { describe, expect, it } from 'vitest'
import type { RunCtx } from '../../types.js'
import { createCommandPlugin } from '../factory.js'

function makeRunCtx(overrides: Partial<RunCtx> = {}): RunCtx {
  return {
    channelId: 'feishu',
    rawEvent: {},
    rawText: '/x raw',
    sender: { userId: 'usr_x' },
    messageKey: 'msg_x',
    meta: {},
    channelConfig: {},
    messageContext: { chatType: 'p2p', isThreadReply: false },
    agent: { id: 'agt_1', userId: null },
    agentConfig: {} as never,
    engineType: 'claude-code',
    matchedCommand: 'x',
    strippedText: 'raw',
    runId: 'r',
    taskId: 't',
    payload: {} as never,
    ...overrides,
  } as RunCtx
}

describe('createCommandPlugin — CommandSpec 字段透传', () => {
  it('完整透传所有 spec 字段到产出的 plugin', async () => {
    const plugin = createCommandPlugin({
      commandName: 'foo',
      prefixes: ['/foo', '/f'],
      allowedContexts: ['p2p'],
      emptyTextFallback: '默认',
      longRunningAck: 'wait...',
    })
    expect(plugin.commandName).toBe('foo')
    expect(plugin.prefixes).toEqual(['/foo', '/f'])
    expect(plugin.allowedContexts).toEqual(['p2p'])
    expect(plugin.emptyTextFallback).toBe('默认')
    expect(plugin.longRunningAck).toBe('wait...')
  })

  it('LifecyclePlugin name 用 cmd: 前缀 + commandName', async () => {
    const plugin = createCommandPlugin({ commandName: 'new', prefixes: ['/new'] })
    expect(plugin.name).toBe('cmd:new')
  })

  it('priority 默认 20（比 dispatcher 大，跑在后面）', async () => {
    const plugin = createCommandPlugin({ commandName: 'x', prefixes: ['/x'] })
    expect(plugin.priority).toBe(20)
  })
})

describe('createCommandPlugin — onBeforeRun 短路', () => {
  it('ctx.matchedCommand 不等于自己 commandName 时不做任何副作用', async () => {
    const plugin = createCommandPlugin({
      commandName: 'foo',
      prefixes: ['/foo'],
      applySession: () => ({ override: null }),
      runConfigPatch: () => ({ extraEngineFlags: ['--foo'] }),
      longRunningAck: 'wait',
    })
    const ctx = makeRunCtx({ matchedCommand: 'bar' })
    await plugin.onBeforeRun?.(ctx)
    expect(ctx.chatIdOverride).toBeUndefined()
    expect(ctx.runConfigPatch).toBeUndefined()
    expect(ctx.preAck).toBeUndefined()
  })

  it('ctx.matchedCommand undefined 时也短路（普通消息）', async () => {
    const plugin = createCommandPlugin({
      commandName: 'foo',
      prefixes: ['/foo'],
      applySession: () => ({ override: null }),
    })
    const ctx = makeRunCtx({ matchedCommand: undefined })
    await plugin.onBeforeRun?.(ctx)
    expect(ctx.chatIdOverride).toBeUndefined()
  })
})

describe('createCommandPlugin — onBeforeRun 命中后副作用', () => {
  it('applySession.override = null → ctx.chatIdOverride = null（开新会话）', async () => {
    const plugin = createCommandPlugin({
      commandName: 'new',
      prefixes: ['/new'],
      applySession: () => ({ override: null }),
    })
    const ctx = makeRunCtx({ matchedCommand: 'new' })
    await plugin.onBeforeRun?.(ctx)
    expect(ctx.chatIdOverride).toBeNull()
  })

  it('applySession.override = string → ctx.chatIdOverride = 该字符串', async () => {
    const plugin = createCommandPlugin({
      commandName: 'resume',
      prefixes: ['/resume'],
      applySession: () => ({ override: 'oc_explicit' }),
    })
    const ctx = makeRunCtx({ matchedCommand: 'resume' })
    await plugin.onBeforeRun?.(ctx)
    expect(ctx.chatIdOverride).toBe('oc_explicit')
  })

  it('applySession.override = undefined → 不动 ctx.chatIdOverride', async () => {
    const plugin = createCommandPlugin({
      commandName: 'noop',
      prefixes: ['/noop'],
      applySession: () => ({ override: undefined }),
    })
    const ctx = makeRunCtx({ matchedCommand: 'noop', chatIdOverride: 'existing-chat' })
    await plugin.onBeforeRun?.(ctx)
    expect(ctx.chatIdOverride).toBe('existing-chat')
  })

  it('runConfigPatch 浅合并到 ctx.runConfigPatch', async () => {
    const plugin = createCommandPlugin({
      commandName: 'x',
      prefixes: ['/x'],
      runConfigPatch: () => ({ added: 'value' }),
    })
    const ctx = makeRunCtx({
      matchedCommand: 'x',
      runConfigPatch: { existing: 'kept' },
    } as Partial<RunCtx>)
    await plugin.onBeforeRun?.(ctx)
    expect(ctx.runConfigPatch).toEqual({ existing: 'kept', added: 'value' })
  })

  it('longRunningAck 静态字符串 → ctx.preAck = 字符串', async () => {
    const plugin = createCommandPlugin({
      commandName: 'wait',
      prefixes: ['/wait'],
      longRunningAck: 'please wait',
    })
    const ctx = makeRunCtx({ matchedCommand: 'wait' })
    await plugin.onBeforeRun?.(ctx)
    expect(ctx.preAck).toBe('please wait')
  })

  it('longRunningAck 函数 → 调用并把返回值写入 ctx.preAck', async () => {
    const plugin = createCommandPlugin({
      commandName: 'wait',
      prefixes: ['/wait'],
      longRunningAck: (c) => `waiting on ${c.agentEngineType}`,
    })
    const ctx = makeRunCtx({ matchedCommand: 'wait', engineType: 'codex' })
    await plugin.onBeforeRun?.(ctx)
    expect(ctx.preAck).toBe('waiting on codex')
  })

  it('longRunningAck 未声明 → 不动 ctx.preAck', async () => {
    const plugin = createCommandPlugin({
      commandName: 'silent',
      prefixes: ['/silent'],
    })
    const ctx = makeRunCtx({ matchedCommand: 'silent', preAck: 'preset' })
    await plugin.onBeforeRun?.(ctx)
    expect(ctx.preAck).toBe('preset')
  })

  it('init 没传 applySession / runConfigPatch / longRunningAck → 全部不动 ctx', async () => {
    const plugin = createCommandPlugin({
      commandName: 'lazy',
      prefixes: ['/lazy'],
    })
    const ctx = makeRunCtx({ matchedCommand: 'lazy' })
    await plugin.onBeforeRun?.(ctx)
    expect(ctx.chatIdOverride).toBeUndefined()
    expect(ctx.runConfigPatch).toBeUndefined()
    expect(ctx.preAck).toBeUndefined()
  })
})

describe('createCommandPlugin — applySession ctx 形状', () => {
  it('applySession 收到的 SessionResolveCtx 字段齐全', async () => {
    const seen: unknown[] = []
    const plugin = createCommandPlugin({
      commandName: 'probe',
      prefixes: ['/probe'],
      applySession: (c) => {
        seen.push(c)
        return { override: null }
      },
    })
    const ctx = makeRunCtx({
      matchedCommand: 'probe',
      engineType: 'codex',
      rawText: '/probe hello world',
      strippedText: 'hello world',
    })
    await plugin.onBeforeRun?.(ctx)
    expect(seen).toEqual([
      {
        commandName: 'probe',
        agentEngineType: 'codex',
        rawText: '/probe hello world',
        strippedText: 'hello world',
      },
    ])
  })
})
