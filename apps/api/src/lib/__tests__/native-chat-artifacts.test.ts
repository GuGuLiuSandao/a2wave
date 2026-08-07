import { describe, expect, it } from 'vitest'
import { prepareNativeArtifactUpload } from '../native-chat-artifacts.js'

describe('prepareNativeArtifactUpload', () => {
  it('passes file artifacts to channel SDKs by storage path', async () => {
    expect(
      prepareNativeArtifactUpload({
        id: 'art_1',
        filename: 'report.pdf',
        storagePath: '/artifacts/report.pdf',
        kind: 'file',
        mimeType: 'application/pdf',
        agentId: 'agt_1',
      }),
    ).toEqual({
      filename: 'report.pdf',
      data: '/artifacts/report.pdf',
    })
  })
})
