/**
 * Regression tests for `mcpServerHasToolPreview`.
 *
 * The bug: the MCP card wrapped its tool previews in a `border-t` container
 * gated only on "some server is selected". `<McpServerTools>` renders null for
 * stdio servers, so selecting a stdio server (the common case — the bundled
 * platform-admin server is stdio) drew an empty bordered div: a stray rule
 * hanging under the picker with nothing beneath it.
 *
 * The predicate is exported so the container's visibility and the component's
 * own early return are decided by one function and cannot drift apart.
 */
import { describe, expect, it } from 'vitest'
import { mcpServerHasToolPreview } from '../mcp-server-tools'

describe('mcpServerHasToolPreview', () => {
  it('is false for stdio, which renders no preview', () => {
    expect(mcpServerHasToolPreview('stdio')).toBe(false)
  })

  it.each(['sse', 'http', 'group'])('is true for %s', (type) => {
    expect(mcpServerHasToolPreview(type)).toBe(true)
  })

  it('is false for an unknown type rather than defaulting to visible', () => {
    // A future server type should not silently reintroduce the empty container.
    expect(mcpServerHasToolPreview('something-new')).toBe(false)
  })
})
