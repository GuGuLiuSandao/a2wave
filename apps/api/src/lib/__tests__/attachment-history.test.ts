import { describe, expect, it } from 'vitest'
import { extractStepAttachments, pairAttachmentsToMessages } from '../attachment-history.js'

const refA = [{ token: 'att_a', name: 'a.png', mimeType: 'image/png' }]
const refB = [{ token: 'att_b', name: 'b.pdf', mimeType: 'application/pdf' }]

describe('extractStepAttachments', () => {
  it('pulls attachments arrays, empty → undefined', async () => {
    expect(
      extractStepAttachments([
        { input: { message: 'x', attachments: refA } },
        { input: { message: 'y' } },
        { input: null },
        { input: { attachments: [] } },
      ]),
    ).toEqual([refA, undefined, undefined, undefined])
  })
})

describe('pairAttachmentsToMessages', () => {
  it('pairs Nth step attachments to Nth user message; agents get undefined', async () => {
    const messages = [
      { role: 'user' }, // turn 1
      { role: 'agent' },
      { role: 'user' }, // turn 2
      { role: 'agent' },
    ]
    const paired = pairAttachmentsToMessages(messages, [refA, refB])
    expect(paired).toEqual([refA, undefined, refB, undefined])
  })

  it('user message without a matching step → undefined', async () => {
    const messages = [{ role: 'user' }, { role: 'user' }]
    expect(pairAttachmentsToMessages(messages, [refA])).toEqual([refA, undefined])
  })

  it('no attachments anywhere', async () => {
    const messages = [{ role: 'user' }, { role: 'agent' }]
    expect(pairAttachmentsToMessages(messages, [undefined])).toEqual([undefined, undefined])
  })
})
