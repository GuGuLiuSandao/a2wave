import i18n from '@/i18n'
import { KB_BATCH_MAX } from '@/lib/kb-batch'
import { renderWithProviders, screen, userEvent, waitFor } from '@/test/render'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { KbDocumentsPage } from '../kb-documents'

const uploadMutateAsync = vi.fn()
const openEdit = vi.fn()

vi.mock('@/hooks/use-kb-documents', () => ({
  useKbDocuments: vi.fn(() => ({ data: { data: [] }, isLoading: false })),
  useUploadKbDocument: vi.fn(() => ({ mutateAsync: uploadMutateAsync, isPending: false })),
  useKbDocument: vi.fn(() => ({ data: undefined, isLoading: false })),
}))

vi.mock('@/hooks/use-url-state', () => ({
  useUrlRecord: vi.fn(() => ({
    open: false,
    id: undefined,
    openEdit,
    openCreate: vi.fn(),
    close: vi.fn(),
  })),
}))

// The modal is not under test here and pulls in the whole form.
vi.mock('@/components/kb/kb-document-form-modal', () => ({
  KbDocumentFormModal: () => null,
}))

const messageMock = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn(), warning: vi.fn() }))
vi.mock('@/lib/antd-static', () => ({ message: messageMock, notification: {}, modal: {} }))

const md = (name: string) => new File(['# hi'], name, { type: 'text/markdown' })
const fileInput = () => document.querySelector('input[type="file"]') as HTMLInputElement

describe('KbDocumentsPage quick upload', () => {
  beforeEach(async () => {
    vi.clearAllMocks()
    uploadMutateAsync.mockImplementation(async (file: File) => ({
      data: { id: `kbd_${file.name}`, name: file.name.replace('.md', '') },
    }))
    await i18n.changeLanguage('zh')
  })

  it('accepts a multi-select and uploads every file', async () => {
    const user = userEvent.setup()
    renderWithProviders(<KbDocumentsPage />)

    expect(fileInput().multiple).toBe(true)
    await user.upload(fileInput(), [md('a.md'), md('b.md'), md('c.md')])

    await waitFor(() => expect(uploadMutateAsync).toHaveBeenCalledTimes(3))
    expect(uploadMutateAsync.mock.calls.map((c) => (c[0] as File).name)).toEqual([
      'a.md',
      'b.md',
      'c.md',
    ])
  })

  it('opens the editor for a single pick but not for a batch', async () => {
    const user = userEvent.setup()
    const { unmount } = renderWithProviders(<KbDocumentsPage />)

    await user.upload(fileInput(), [md('solo.md')])
    await waitFor(() => expect(openEdit).toHaveBeenCalledWith('kbd_solo.md'))

    unmount()
    vi.clearAllMocks()
    renderWithProviders(<KbDocumentsPage />)
    await user.upload(fileInput(), [md('a.md'), md('b.md')])

    await waitFor(() => expect(messageMock.success).toHaveBeenCalled())
    // No defensible "which one" to open for a batch — jumping into one hides the rest.
    expect(openEdit).not.toHaveBeenCalled()
  })

  it('reports successes alongside failures on a partial batch', async () => {
    const user = userEvent.setup()
    renderWithProviders(<KbDocumentsPage />)
    uploadMutateAsync.mockImplementation(async (file: File) => {
      if (file.name === 'bad.md') throw new Error('文件过大')
      return { data: { id: `kbd_${file.name}`, name: file.name } }
    })

    await user.upload(fileInput(), [md('ok.md'), md('bad.md')])

    await waitFor(() => expect(messageMock.error).toHaveBeenCalled())
    const text = messageMock.error.mock.calls[0][0] as string
    // A bare failure count reads as "nothing happened" and invites a re-pick that
    // duplicates the documents that did land.
    expect(text).toContain('成功 1 个')
    expect(text).toContain('失败 1 个')
    expect(text).toContain('文件过大')
    expect(openEdit).not.toHaveBeenCalled()
  })

  it('uploads nothing when the selection exceeds the batch cap', async () => {
    const user = userEvent.setup()
    renderWithProviders(<KbDocumentsPage />)

    await user.upload(
      fileInput(),
      Array.from({ length: KB_BATCH_MAX + 1 }, (_, i) => md(`f${i}.md`)),
    )

    await waitFor(() => expect(messageMock.warning).toHaveBeenCalled())
    expect(uploadMutateAsync).not.toHaveBeenCalled()
  })
})
