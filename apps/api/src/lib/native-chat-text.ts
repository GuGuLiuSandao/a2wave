const ARTIFACT_DOWNLOAD_MARKER = '\n\n---\n**产物下载**\n'

const SANDBOX_MARKDOWN_IMAGE = /!\[([^\]\n]*)\]\([ \t]*sandbox:[^)\n]+\)/gi
const SANDBOX_MARKDOWN_LINK = /\[([^\]\n]+)\]\([ \t]*sandbox:[^)\n]+\)/gi
const SANDBOX_AUTOLINK = /<sandbox:[^>\n]+>/gi
const FENCED_CODE_BLOCK = /(```[\s\S]*?```|~~~[\s\S]*?~~~)/g
const ARTIFACTS_LIST_HTML = /<div\b[^>]*\bid\s*=\s*["']artifacts-list["'][^>]*>[\s\S]*?<\/div\s*>/gi
const HTML_DOWNLOAD_CONTROL = /<a\b(?=[^>]*\bdownload(?:\s|=|>))[^>]*>[\s\S]*?<\/a\s*>/gi

export function appendNativeArtifactDownloadSection(content: string, links: string): string {
  return `${content}${ARTIFACT_DOWNLOAD_MARKER}${links}`
}

/**
 * Remove execution-local links that cannot be opened outside the Agent
 * sandbox. When artifacts are uploaded directly, also remove the platform
 * download section so the channel does not show a duplicate or internal URL.
 */
export function prepareNativeChatText(text: string, artifactsUploadedDirectly: boolean): string {
  let prepared = text
  if (artifactsUploadedDirectly) {
    const markerIndex = prepared.lastIndexOf(ARTIFACT_DOWNLOAD_MARKER)
    if (markerIndex >= 0) prepared = prepared.slice(0, markerIndex)
  }

  return prepared
    .split(FENCED_CODE_BLOCK)
    .map((part, index) => {
      if (index % 2 === 1) return part
      return part
        .replace(ARTIFACTS_LIST_HTML, '')
        .replace(HTML_DOWNLOAD_CONTROL, '')
        .replace(SANDBOX_MARKDOWN_IMAGE, '$1')
        .replace(SANDBOX_MARKDOWN_LINK, '$1')
        .replace(SANDBOX_AUTOLINK, '')
        .replace(/[ \t]+\n/g, '\n')
        .replace(/\n{3,}/g, '\n\n')
    })
    .join('')
    .trim()
}
