import { worktreeCallParamsSchema } from '@a2wave/shared'
import { describe, expect, it } from 'vitest'

describe('worktreeCallParamsSchema.branch', () => {
  it('accepts typical branch names', async () => {
    for (const branch of ['main', 'feature/x', 'release-1.0', 'v1.2.3', 'user_a/fix']) {
      expect(worktreeCallParamsSchema.safeParse({ name: 'ws', branch }).success).toBe(true)
    }
  })

  // 核心安全测试：前导 `-` 的 branch 值会被 git 解析成 option，可能触发
  // --orphan / --detach / --help 等行为。schema 必须在入口拒绝。
  it.each(['-orphan', '--orphan', '--detach', '--help', '--force', '-f'])(
    'rejects branch starting with "-" (option injection: %s)',
    (branch) => {
      expect(worktreeCallParamsSchema.safeParse({ name: 'ws', branch }).success).toBe(false)
    },
  )

  it('rejects empty branch', async () => {
    expect(worktreeCallParamsSchema.safeParse({ name: 'ws', branch: '' }).success).toBe(false)
  })

  it('rejects whitespace / special chars', async () => {
    for (const branch of ['foo bar', 'foo;rm', 'foo$bar', 'foo`bar', 'foo\nbar']) {
      expect(worktreeCallParamsSchema.safeParse({ name: 'ws', branch }).success).toBe(false)
    }
  })

  it('allows omitted branch', async () => {
    expect(worktreeCallParamsSchema.safeParse({ name: 'ws' }).success).toBe(true)
  })
})
