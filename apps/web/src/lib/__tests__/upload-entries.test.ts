import { describe, expect, it } from 'vitest'
import { toUploadEntries } from '../upload-entries'

function makeFile(name: string, relPath?: string): File {
  const f = new File(['x'], name, { type: 'text/plain' })
  if (relPath !== undefined) {
    Object.defineProperty(f, 'webkitRelativePath', { value: relPath })
  }
  return f
}

function makeFileList(files: File[]): FileList {
  const list: Record<number | string | symbol, unknown> = {
    length: files.length,
    item: (i: number) => files[i] ?? null,
    [Symbol.iterator]: function* () {
      for (const f of files) yield f
    },
  }
  files.forEach((f, i) => {
    list[i] = f
  })
  return list as unknown as FileList
}

describe('toUploadEntries', () => {
  it('returns [] for null or empty input', () => {
    expect(toUploadEntries(null)).toEqual([])
    expect(toUploadEntries(makeFileList([]))).toEqual([])
  })

  it('uses webkitRelativePath when present (folder pick)', () => {
    const list = makeFileList([
      makeFile('SKILL.md', 'my-skill/SKILL.md'),
      makeFile('helper.py', 'my-skill/scripts/helper.py'),
    ])
    expect(toUploadEntries(list).map((e) => e.path)).toEqual([
      'my-skill/SKILL.md',
      'my-skill/scripts/helper.py',
    ])
  })

  it('falls back to file.name when webkitRelativePath is missing or empty', () => {
    const list = makeFileList([makeFile('a.md'), makeFile('b.md', '')])
    expect(toUploadEntries(list).map((e) => e.path)).toEqual(['a.md', 'b.md'])
  })

  it('drops OS noise files (.DS_Store, Thumbs.db, desktop.ini)', () => {
    const list = makeFileList([
      makeFile('.DS_Store', 'pkg/.DS_Store'),
      makeFile('SKILL.md', 'pkg/SKILL.md'),
      makeFile('Thumbs.db', 'pkg/sub/Thumbs.db'),
      makeFile('desktop.ini', 'pkg/desktop.ini'),
    ])
    expect(toUploadEntries(list).map((e) => e.path)).toEqual(['pkg/SKILL.md'])
  })

  it('keeps legitimate dotfiles (.gitignore, .env.example)', () => {
    const list = makeFileList([
      makeFile('.gitignore', 'pkg/.gitignore'),
      makeFile('.env.example', 'pkg/.env.example'),
    ])
    expect(toUploadEntries(list).map((e) => e.path)).toEqual(['pkg/.gitignore', 'pkg/.env.example'])
  })

  it('drops macOS __MACOSX subtree and AppleDouble (._*) resource forks', () => {
    const list = makeFileList([
      makeFile('SKILL.md', 'pkg/SKILL.md'),
      makeFile('._SKILL.md', 'pkg/._SKILL.md'),
      makeFile('something', '__MACOSX/pkg/._SKILL.md'),
      makeFile('something', 'pkg/__MACOSX/._helper.py'),
      makeFile('helper.py', 'pkg/scripts/helper.py'),
      makeFile('._helper.py', 'pkg/scripts/._helper.py'),
    ])
    expect(toUploadEntries(list).map((e) => e.path)).toEqual([
      'pkg/SKILL.md',
      'pkg/scripts/helper.py',
    ])
  })

  it('preserves the original File objects in entries', () => {
    const f1 = makeFile('a.md', 'pkg/a.md')
    const f2 = makeFile('b.md', 'pkg/b.md')
    const entries = toUploadEntries(makeFileList([f1, f2]))
    expect(entries.map((e) => e.file)).toEqual([f1, f2])
  })
})
