import { describe, expect, it } from 'vitest'
import {
  ATTACHMENT_ALL_EXTS,
  ATTACHMENT_DOC_EXTS,
  ATTACHMENT_IMAGE_EXTS,
  ATTACHMENT_MIME_BY_EXT,
  ATTACHMENT_MIME_TYPES,
  attachmentRefSchema,
  attachmentsInputSchema,
  isAttachmentImageExt,
} from '../schemas/attachment.js'

describe('attachment allow-list constants', () => {
  it('ALL = images + docs, no overlap', () => {
    expect(ATTACHMENT_ALL_EXTS).toEqual([...ATTACHMENT_IMAGE_EXTS, ...ATTACHMENT_DOC_EXTS])
    const overlap = ATTACHMENT_IMAGE_EXTS.filter((e) =>
      (ATTACHMENT_DOC_EXTS as readonly string[]).includes(e),
    )
    expect(overlap).toEqual([])
  })

  it('every ext has a mime mapping', () => {
    for (const ext of ATTACHMENT_ALL_EXTS) {
      expect(ATTACHMENT_MIME_BY_EXT[ext]).toBeTruthy()
    }
  })

  it('ATTACHMENT_MIME_TYPES is deduped', () => {
    expect(ATTACHMENT_MIME_TYPES.length).toBe(new Set(ATTACHMENT_MIME_TYPES).size)
    // jpg + jpeg collapse to one image/jpeg
    expect(ATTACHMENT_MIME_TYPES.filter((m) => m === 'image/jpeg').length).toBe(1)
  })

  it('isAttachmentImageExt handles dot + case', () => {
    expect(isAttachmentImageExt('png')).toBe(true)
    expect(isAttachmentImageExt('.PNG')).toBe(true)
    expect(isAttachmentImageExt('pdf')).toBe(false)
    expect(isAttachmentImageExt('docx')).toBe(false)
  })
})

describe('attachmentRefSchema', () => {
  it('accepts a valid ref', () => {
    const ref = { token: 'att_abc', name: 'x.png', mimeType: 'image/png', size: 10 }
    expect(attachmentRefSchema.parse(ref)).toEqual(ref)
  })

  it('rejects empty token / name / mimeType', () => {
    expect(attachmentRefSchema.safeParse({ token: '', name: 'x', mimeType: 'y' }).success).toBe(
      false,
    )
    expect(attachmentRefSchema.safeParse({ token: 't', name: '', mimeType: 'y' }).success).toBe(
      false,
    )
    expect(attachmentRefSchema.safeParse({ token: 't', name: 'x', mimeType: '' }).success).toBe(
      false,
    )
  })

  it('size optional but must be non-negative int', () => {
    expect(attachmentRefSchema.safeParse({ token: 't', name: 'x', mimeType: 'y' }).success).toBe(
      true,
    )
    expect(
      attachmentRefSchema.safeParse({ token: 't', name: 'x', mimeType: 'y', size: -1 }).success,
    ).toBe(false)
  })
})

describe('attachmentsInputSchema', () => {
  const ref = { token: 't', name: 'x.png', mimeType: 'image/png' }

  it('accepts undefined and empty array', () => {
    expect(attachmentsInputSchema.parse(undefined)).toBeUndefined()
    expect(attachmentsInputSchema.parse([])).toEqual([])
  })

  it('caps at 10', () => {
    expect(attachmentsInputSchema.safeParse(Array(10).fill(ref)).success).toBe(true)
    expect(attachmentsInputSchema.safeParse(Array(11).fill(ref)).success).toBe(false)
  })
})
