/**
 * /new command plugin — direct field assertions.
 *
 * Uses vi.resetModules() + dynamic import per test so v8 records new.ts module-init
 * lines as executed inside each `it` body. Without this, stryker's per-test
 * coverage attributes the lines only to the test that happened to be first to
 * import (typically an unrelated agents.test.ts), and these assertions don't
 * appear in the mutant's coveredBy list — leaving them surviving.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { RunCtx } from '../../../types.js'
import type { CommandPlugin } from '../../types.js'
import { isCommandPlugin } from '../../types.js'

let newCommandPlugin: CommandPlugin

beforeEach(async () => {
  vi.resetModules()
  newCommandPlugin = (await import('../new.js')).newCommandPlugin
})

describe('newCommandPlugin — CommandSpec 字段', () => {
  it('commandName 是 "new"', async () => {
    expect(newCommandPlugin.commandName).toBe('new')
  })

  it('prefixes 是 ["/new"]', async () => {
    expect(newCommandPlugin.prefixes).toEqual(['/new'])
  })

  it('emptyTextFallback 是 "新会话已开始"——bare /new 走完整 pipeline 的注入文本', async () => {
    expect(newCommandPlugin.emptyTextFallback).toBe('新会话已开始')
  })

  it('allowedContexts 限定 ["p2p"]——群聊和 thread reply 自带新开会话方式', async () => {
    expect(newCommandPlugin.allowedContexts).toEqual(['p2p'])
  })

  it('无 longRunningAck（瞬时操作）', async () => {
    expect(newCommandPlugin.longRunningAck).toBeUndefined()
  })
})

describe('newCommandPlugin — LifecyclePlugin 字段', () => {
  it('plugin.name 用 "cmd:new"（factory 自动加前缀）', async () => {
    expect(newCommandPlugin.name).toBe('cmd:new')
  })

  it('通过 isCommandPlugin 类型谓词识别', async () => {
    expect(isCommandPlugin(newCommandPlugin)).toBe(true)
  })

  it('暴露 onBeforeRun 钩子（factory 注入）', async () => {
    expect(newCommandPlugin.onBeforeRun).toBeDefined()
  })
})

describe('newCommandPlugin — onBeforeRun 行为', () => {
  function makeCtx(matched: string | undefined): RunCtx {
    return {
      channelId: 'feishu',
      rawEvent: {},
      rawText: '/new',
      sender: { userId: 'usr_x' },
      messageKey: 'msg_x',
      meta: {},
      channelConfig: null,
      messageContext: { chatType: 'p2p', isThreadReply: false },
      agent: { id: 'agt_1', userId: null },
      agentConfig: {} as never,
      engineType: 'claude-code',
      matchedCommand: matched,
      strippedText: '',
      runId: 'r',
      taskId: 't',
      payload: {} as never,
    } as RunCtx
  }

  it('ctx.matchedCommand === "new" 时 applySession → ctx.chatIdOverride=null', async () => {
    const ctx = makeCtx('new')
    await newCommandPlugin.onBeforeRun?.(ctx)
    expect(ctx.chatIdOverride).toBeNull()
  })

  it('ctx.matchedCommand !== "new" 时不触发 applySession', async () => {
    const ctx = makeCtx('other')
    await newCommandPlugin.onBeforeRun?.(ctx)
    expect(ctx.chatIdOverride).toBeUndefined()
  })

  it('ctx.matchedCommand undefined（普通消息）也不触发', async () => {
    const ctx = makeCtx(undefined)
    await newCommandPlugin.onBeforeRun?.(ctx)
    expect(ctx.chatIdOverride).toBeUndefined()
  })
})
