/**
 * Markdown -> Feishu rich-text ("post") conversion.
 *
 * Split out of feishu-service.ts, which sits at the 3000-line gate. This block is
 * a natural seam: it is pure string/AST work with no Feishu client, database, or
 * run-lifecycle dependency, so it is also the part that is cheapest to test in
 * isolation.
 *
 * Feishu renders a `md` node itself, so ordinary prose is passed through as one
 * markdown node. Tables are the exception — the md node does not render them, so
 * they are expanded into per-cell text nodes with a bold header row.
 */
export type FeishuPostNode = {
  tag: 'text' | 'md'
  text?: string
  style?: Array<'bold'>
}

function parseMarkdownTableRow(line: string): string[] {
  return line
    .trim()
    .replace(/^\|/, '')
    .replace(/\|$/, '')
    .split('|')
    .map((cell) => cell.trim())
}

function isMarkdownTableRow(line: string): boolean {
  const trimmed = line.trim()
  return trimmed.startsWith('|') && trimmed.endsWith('|')
}

function isMarkdownTableSeparator(line: string): boolean {
  return /^\|(?:\s*:?-{3,}:?\s*\|)+$/.test(line.trim())
}

function buildTableRowNodes(cells: string[], isHeader = false): FeishuPostNode[] {
  return cells.flatMap((cell, index) => {
    const nodes: FeishuPostNode[] = [
      isHeader ? { tag: 'text', text: cell, style: ['bold'] } : { tag: 'text', text: cell },
    ]
    if (index < cells.length - 1) {
      nodes.push({ tag: 'text', text: ' | ' })
    }
    return nodes
  })
}

export function textToPostContent(text: string): string {
  try {
    const parsed = JSON.parse(text)
    if (parsed.zh_cn || parsed.en_us || parsed.ja_jp) return text
  } catch {
    /* not JSON — convert below */
  }

  const lines = text.split('\n')
  const content: FeishuPostNode[][] = []
  const markdownBuffer: string[] = []

  const flushMarkdownBuffer = () => {
    const markdown = markdownBuffer.join('\n').trim()
    markdownBuffer.length = 0
    if (!markdown) return
    content.push([{ tag: 'md', text: markdown }])
  }

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? ''
    const trimmed = line.trim()

    if (!trimmed) {
      markdownBuffer.push('')
      continue
    }

    const nextLine = lines[i + 1]?.trim() ?? ''
    if (isMarkdownTableRow(trimmed) && isMarkdownTableSeparator(nextLine)) {
      flushMarkdownBuffer()
      const headerCells = parseMarkdownTableRow(trimmed)
      content.push(buildTableRowNodes(headerCells, true))
      i += 2

      while (i < lines.length) {
        const rowLine = lines[i]?.trim() ?? ''
        if (!isMarkdownTableRow(rowLine)) {
          i -= 1
          break
        }

        content.push(buildTableRowNodes(parseMarkdownTableRow(rowLine)))
        i += 1
      }

      if (i >= lines.length) break
      continue
    }

    markdownBuffer.push(line)
  }

  flushMarkdownBuffer()

  return JSON.stringify({ zh_cn: { title: '', content } })
}
