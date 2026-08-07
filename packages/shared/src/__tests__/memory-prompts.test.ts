import { describe, expect, it } from 'vitest'
import { DEFAULT_MEMORY_INSIGHT_PROMPT, DEFAULT_MEMORY_WORKLOG_PROMPT } from '../memory-prompts.js'

describe('memory prompt defaults', () => {
  it('defines the worklog prompt with the required time placeholder', () => {
    expect(DEFAULT_MEMORY_WORKLOG_PROMPT).toContain('{{time}}')
    expect(DEFAULT_MEMORY_WORKLOG_PROMPT).toContain('目标')
    expect(DEFAULT_MEMORY_WORKLOG_PROMPT).toContain('过程')
    expect(DEFAULT_MEMORY_WORKLOG_PROMPT).toContain('结果')
  })

  it('separates long-term insight facts from transient worklog facts', () => {
    expect(DEFAULT_MEMORY_INSIGHT_PROMPT).toContain('{{existingMemory}}')
    expect(DEFAULT_MEMORY_INSIGHT_PROMPT).toContain('四问门槛')
    expect(DEFAULT_MEMORY_INSIGHT_PROMPT).toContain('长期性')
    expect(DEFAULT_MEMORY_INSIGHT_PROMPT).toContain('稳定性')
    expect(DEFAULT_MEMORY_INSIGHT_PROMPT).toContain('可行动性')
    expect(DEFAULT_MEMORY_INSIGHT_PROMPT).toContain('非显而易见')

    expect(DEFAULT_MEMORY_INSIGHT_PROMPT).toContain(
      '以后 / 默认 / 长期 / stable preference / 每次 / 固定 / 总是 / always',
    )
    expect(DEFAULT_MEMORY_INSIGHT_PROMPT).toContain('标题风格')
    expect(DEFAULT_MEMORY_INSIGHT_PROMPT).toContain('一次性报告标题')
    expect(DEFAULT_MEMORY_INSIGHT_PROMPT).toContain('视为长期用户偏好，应保存')
    expect(DEFAULT_MEMORY_INSIGHT_PROMPT).toContain('只用于当前任务')
    expect(DEFAULT_MEMORY_INSIGHT_PROMPT).toContain('本次一次性报告标题')
  })
})
