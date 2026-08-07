import i18n from '@/i18n'
import { renderWithProviders, screen, userEvent, waitFor } from '@/test/render'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { KbDocumentForm } from '../kb-document-form'

const updateMutateAsync = vi.fn().mockResolvedValue({ data: { id: 'kbd_notion' } })

const notionDocument = {
  id: 'kbd_notion',
  name: 'Product handbook',
  description: 'Internal product documentation',
  sourceType: 'notion',
  notionUrl: 'https://www.notion.so/2dc2541e45a5495e817e2ac6e189ea5a',
  notionToken: 'ntn_stored-should-never-render',
  autoSync: true,
  syncIntervalMin: 60,
  syncStatus: 'synced',
  lastSyncAt: null,
  lastSyncError: null,
  fileSize: 1024,
}

const mutation = (mutateAsync = vi.fn()) => ({ mutateAsync, isPending: false })

vi.mock('@/hooks/use-kb-documents', () => ({
  useKbDocument: vi.fn(() => ({ data: notionDocument, isLoading: false })),
  useKbDocumentContent: vi.fn(() => ({ data: undefined, isLoading: false })),
  useCreateKbDocument: vi.fn(() => mutation()),
  useUpdateKbDocument: vi.fn(() => mutation(updateMutateAsync)),
  useDeleteKbDocument: vi.fn(() => mutation()),
  useSyncKbDocument: vi.fn(() => mutation()),
  useReuploadKbDocument: vi.fn(() => mutation()),
  useUploadKbDocument: vi.fn(() => mutation()),
}))

function renderNotionForm() {
  return renderWithProviders(<KbDocumentForm documentId="kbd_notion" onSaved={() => {}} />)
}

describe('KbDocumentForm Notion credentials', () => {
  beforeEach(async () => {
    vi.clearAllMocks()
    await i18n.changeLanguage('zh')
  })

  it('shows the current Notion URL but never exposes the stored token', async () => {
    renderNotionForm()

    expect(await screen.findByLabelText('Notion 页面链接')).toHaveValue(notionDocument.notionUrl)
    expect(screen.getByLabelText('Notion Integration Token')).toHaveValue('')
    expect(screen.getByText('留空则保留当前 Token。')).toBeInTheDocument()
  })

  it('updates the Notion URL without sending an empty token', async () => {
    const user = userEvent.setup()
    renderNotionForm()

    const urlInput = await screen.findByLabelText('Notion 页面链接')
    await user.clear(urlInput)
    await user.type(urlInput, 'https://www.notion.so/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa')
    await user.click(screen.getByRole('button', { name: '保存' }))

    await waitFor(() =>
      expect(updateMutateAsync).toHaveBeenCalledWith({
        id: 'kbd_notion',
        name: notionDocument.name,
        description: notionDocument.description,
        notionUrl: 'https://www.notion.so/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
        autoSync: true,
        syncIntervalMin: 60,
      }),
    )
  })

  it('sends a replacement token when the user enters one', async () => {
    const user = userEvent.setup()
    renderNotionForm()

    await user.type(await screen.findByLabelText('Notion Integration Token'), 'ntn_replacement')
    await user.click(screen.getByRole('button', { name: '保存' }))

    await waitFor(() =>
      expect(updateMutateAsync).toHaveBeenCalledWith(
        expect.objectContaining({
          id: 'kbd_notion',
          notionToken: 'ntn_replacement',
        }),
      ),
    )
    expect(updateMutateAsync.mock.calls.at(-1)?.[0]).not.toHaveProperty('notionUrl')
  })

  it('does not mark credentials changed when saving unrelated metadata', async () => {
    const user = userEvent.setup()
    renderNotionForm()

    const nameInput = await screen.findByDisplayValue(notionDocument.name)
    await user.clear(nameInput)
    await user.type(nameInput, 'Renamed handbook')
    await user.click(await screen.findByRole('button', { name: '保存' }))

    await waitFor(() => expect(updateMutateAsync).toHaveBeenCalled())
    expect(updateMutateAsync.mock.calls.at(-1)?.[0]).not.toHaveProperty('notionUrl')
    expect(updateMutateAsync.mock.calls.at(-1)?.[0]).not.toHaveProperty('notionToken')
  })
})
