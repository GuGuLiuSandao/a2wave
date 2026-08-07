import { describe, expect, it } from 'vitest'
import { appendNativeArtifactDownloadSection, prepareNativeChatText } from '../native-chat-text.js'

describe('native chat text', () => {
  it('removes standalone sandbox download links and preserves inline labels', async () => {
    const output = [
      'The report is [available here](sandbox:/tmp/report.csv).',
      '[Download report](sandbox:/tmp/report.csv)',
    ].join('\n')

    expect(prepareNativeChatText(output, false)).toBe(
      'The report is available here.\nDownload report',
    )
  })

  it('removes only the platform artifact section when files are uploaded directly', async () => {
    const output = appendNativeArtifactDownloadSection(
      '### Result\n\nThe analysis is complete.',
      '- [report.csv](https://a2wave.example.com/api/artifacts/art_1/download)',
    )

    expect(prepareNativeChatText(output, true)).toBe('### Result\n\nThe analysis is complete.')
    expect(prepareNativeChatText(output, false)).toContain('**产物下载**')
  })

  it('removes Agent-authored local artifact HTML without changing fenced code examples', async () => {
    const output = [
      '**Data source:**',
      '- Historical prices',
      '',
      '<div id="artifacts-list">',
      '<a href="/tmp/a2wave-sandbox/run/artifacts/report.csv" download="report.csv">Download report</a>',
      '</div>',
      '',
      '```html',
      '<div id="example">This code sample must stay intact.</div>',
      '```',
    ].join('\n')

    const prepared = prepareNativeChatText(output, true)

    expect(prepared).not.toContain('artifacts-list')
    expect(prepared).not.toContain('/tmp/a2wave-sandbox')
    expect(prepared).not.toContain('Download report')
    expect(prepared).toContain('<div id="example">This code sample must stay intact.</div>')
  })
})
