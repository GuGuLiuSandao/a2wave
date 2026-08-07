import { describe, expect, it } from 'vitest'
import { createKbDocumentInput, updateKbDocumentInput } from '../schemas/kb-document.js'

const FEISHU_BODY = {
  sourceType: 'feishu' as const,
  feishuUrl: 'https://example.feishu.cn/docx/abc',
  feishuAppId: 'cli_x',
  feishuAppSecret: 'secret',
}

describe('createKbDocumentInput.name', () => {
  it('accepts a remote source with no name at all', () => {
    // The create form no longer asks for one: the remote title is a better
    // default than anything a user types while pasting ten links.
    const parsed = createKbDocumentInput.safeParse(FEISHU_BODY)
    expect(parsed.success).toBe(true)
    expect(parsed.success && parsed.data.name).toBeUndefined()
  })

  it('accepts an explicitly provided name', () => {
    const parsed = createKbDocumentInput.safeParse({ ...FEISHU_BODY, name: 'Q3 spec' })
    expect(parsed.success && parsed.data.name).toBe('Q3 spec')
  })

  it('still rejects an empty name', () => {
    // Optional means "may be omitted", never "may be blank" — a blank name
    // would land in a NOT NULL column and produce an unnameable document.
    expect(createKbDocumentInput.safeParse({ ...FEISHU_BODY, name: '' }).success).toBe(false)
  })

  it('still rejects a name over 200 characters', () => {
    const parsed = createKbDocumentInput.safeParse({ ...FEISHU_BODY, name: 'a'.repeat(201) })
    expect(parsed.success).toBe(false)
  })

  it('accepts a name of exactly 200 characters', () => {
    const parsed = createKbDocumentInput.safeParse({ ...FEISHU_BODY, name: 'a'.repeat(200) })
    expect(parsed.success).toBe(true)
  })

  it('still requires sourceType', () => {
    expect(createKbDocumentInput.safeParse({ name: 'x' }).success).toBe(false)
  })
})

describe('updateKbDocumentInput.name', () => {
  it('is unchanged: optional, non-empty, capped at 200', () => {
    expect(updateKbDocumentInput.safeParse({}).success).toBe(true)
    expect(updateKbDocumentInput.safeParse({ name: 'renamed' }).success).toBe(true)
    expect(updateKbDocumentInput.safeParse({ name: '' }).success).toBe(false)
    expect(updateKbDocumentInput.safeParse({ name: 'a'.repeat(201) }).success).toBe(false)
  })
})
