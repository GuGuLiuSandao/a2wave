export type UploadEntry = { file: File; path: string }

const IGNORED_FILENAMES = new Set(['.DS_Store', 'Thumbs.db', 'desktop.ini'])

function isMacOsxResourceFork(path: string, basename: string): boolean {
  // macOS ZIPs from Finder include a __MACOSX/ shadow tree of resource forks.
  // Selecting such a folder via <input webkitdirectory> surfaces these too.
  if (path === '__MACOSX' || path.startsWith('__MACOSX/') || path.includes('/__MACOSX/'))
    return true
  // AppleDouble resource forks ride along as `._<originalName>` siblings.
  return basename.startsWith('._')
}

export function toUploadEntries(fileList: FileList | null): UploadEntry[] {
  if (!fileList || fileList.length === 0) return []
  const out: UploadEntry[] = []
  for (const file of Array.from(fileList)) {
    const rel = (file as File & { webkitRelativePath?: string }).webkitRelativePath
    const path = rel && rel.length > 0 ? rel : file.name
    const basename = path.split('/').pop() ?? path
    if (IGNORED_FILENAMES.has(basename)) continue
    if (isMacOsxResourceFork(path, basename)) continue
    out.push({ file, path })
  }
  return out
}
