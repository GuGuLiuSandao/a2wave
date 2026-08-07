/**
 * Unit tests for lib/share-render.ts — focused on the Markdown sanitizer, which is
 * the one place user/agent-authored content is turned into HTML for the share page.
 *
 * The CSP sandbox (allow-scripts on an opaque origin) is the production backstop, but
 * the module header promises sanitized output regardless — these tests pin that promise:
 * <script>, event-handler attributes, and javascript:/data: schemes must not survive.
 */
import { describe, expect, it } from 'vitest'
import { renderMarkdown, renderMarkdownPage } from '../share-render.js'

describe('renderMarkdown — happy path', () => {
  it('renders headings, emphasis and safe links', async () => {
    const html = renderMarkdown('# Title\n\nHello **world** and [a2wave](https://a2wave.dev)')
    expect(html).toContain('<h1')
    expect(html).toContain('Title')
    expect(html).toContain('<strong>world</strong>')
    expect(html).toContain('href="https://a2wave.dev"')
  })

  it('keeps img with a safe http(s) src but only allowed attributes', async () => {
    const html = renderMarkdown('![alt text](https://cdn.example/img.png "t")')
    expect(html).toContain('<img')
    expect(html).toContain('src="https://cdn.example/img.png"')
    expect(html).toContain('alt="alt text"')
  })
})

describe('renderMarkdown — XSS sanitization (negative)', () => {
  it('strips raw <script> tags and their contents', async () => {
    const html = renderMarkdown('Hi\n\n<script>alert(document.cookie)</script>')
    expect(html).not.toContain('<script')
    // nonTextTags: script body must be dropped entirely, not just the tag
    expect(html).not.toContain('alert(document.cookie)')
  })

  it('strips inline event-handler attributes (onerror)', async () => {
    const html = renderMarkdown('<img src="x" onerror="alert(1)">')
    expect(html).not.toContain('onerror')
    expect(html).not.toContain('alert(1)')
  })

  it('drops javascript: hrefs while keeping the link text', async () => {
    const html = renderMarkdown('[click me](javascript:alert(1))')
    expect(html).not.toContain('javascript:')
    expect(html).not.toContain('alert(1)')
    expect(html).toContain('click me')
  })

  it('drops data: image sources', async () => {
    const html = renderMarkdown('![x](data:text/html;base64,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg==)')
    expect(html).not.toContain('data:text/html')
  })

  it('escapes the surrounding page chrome too (filename is not raw HTML)', async () => {
    const page = renderMarkdownPage('<script>evil</script>.md', '# ok')
    // the <title> / heading must show the filename escaped, never as a live tag
    expect(page).not.toContain('<script>evil</script>')
    expect(page).toContain('&lt;script&gt;')
  })
})
