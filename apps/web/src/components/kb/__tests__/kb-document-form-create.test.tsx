import i18n from '@/i18n'
import { KB_BATCH_MAX } from '@/lib/kb-batch'
import { renderWithProviders, screen, userEvent, waitFor } from '@/test/render'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { KbDocumentForm } from '../kb-document-form'

const createMutateAsync = vi.fn()
const uploadMutateAsync = vi.fn()

const mutation = (mutateAsync = vi.fn()) => ({ mutateAsync, isPending: false })

// Create mode means "no document loaded" — the shared kb-document-form.test.tsx mocks
// this hook to always return a Notion document, which would fire the edit-mode reset().
vi.mock('@/hooks/use-kb-documents', () => ({
  useKbDocument: vi.fn(() => ({ data: undefined, isLoading: false })),
  useKbDocumentContent: vi.fn(() => ({ data: undefined, isLoading: false })),
  useCreateKbDocument: vi.fn(() => mutation(createMutateAsync)),
  useUpdateKbDocument: vi.fn(() => mutation()),
  useDeleteKbDocument: vi.fn(() => mutation()),
  useSyncKbDocument: vi.fn(() => mutation()),
  useReuploadKbDocument: vi.fn(() => mutation()),
  useUploadKbDocument: vi.fn(() => mutation(uploadMutateAsync)),
}))

// renderWithProviders does not mount AntdStaticBridge, so the real `message` is undefined.
const messageMock = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn(), warning: vi.fn() }))
vi.mock('@/lib/antd-static', () => ({
  message: messageMock,
  notification: {},
  modal: {},
}))

const FEISHU_A = 'https://x.feishu.cn/docx/aaa'
const FEISHU_B = 'https://x.feishu.cn/docx/bbb'

function renderCreateForm(onSaved = vi.fn()) {
  renderWithProviders(<KbDocumentForm onSaved={onSaved} />)
  return { onSaved }
}

async function fillFeishuCredentials(user: ReturnType<typeof userEvent.setup>) {
  await user.type(screen.getByPlaceholderText('cli_xxxxxxxx'), 'cli_app')
  await user.type(screen.getByPlaceholderText('应用密钥'), 'secret')
}

function urlTextarea() {
  return screen.getByPlaceholderText(/feishu\.cn\/docx/)
}

/** The submit button by type — its label flips to "保存中…" while a batch runs. */
const submit = () => document.querySelector('button[type="submit"]') as HTMLButtonElement

/** Resolves the pending create call, so a test can assert mid-batch UI state. */
function deferredCreate() {
  let release!: (value: { data: { id: string; name: string } }) => void
  const gate = new Promise<{ data: { id: string; name: string } }>((r) => {
    release = r
  })
  createMutateAsync.mockImplementation(() => gate)
  return { release: () => release({ data: { id: 'kbd_x', name: 'Doc' } }) }
}

describe('KbDocumentForm create mode — batch links', () => {
  beforeEach(async () => {
    vi.clearAllMocks()
    createMutateAsync.mockImplementation(async () => ({ data: { id: 'kbd_x', name: 'Doc' } }))
    uploadMutateAsync.mockImplementation(async () => ({ data: { id: 'kbd_x', name: 'File' } }))
    await i18n.changeLanguage('zh')
  })

  it('renders a multi-line URL field and no name input', async () => {
    renderCreateForm()

    expect(urlTextarea().tagName).toBe('TEXTAREA')
    expect(screen.queryByPlaceholderText('文档名称')).not.toBeInTheDocument()
    expect(screen.getByText('每行一个链接，可一次添加多个文档。')).toBeInTheDocument()
  })

  it('creates one document per line, sequentially, with no name in the payload', async () => {
    const user = userEvent.setup()
    const { onSaved } = renderCreateForm()

    await user.type(urlTextarea(), `${FEISHU_A}\n${FEISHU_B}`)
    await fillFeishuCredentials(user)
    await user.click(submit())

    await waitFor(() => expect(createMutateAsync).toHaveBeenCalledTimes(2))
    expect(createMutateAsync.mock.calls[0][0]).toMatchObject({
      sourceType: 'feishu',
      feishuUrl: FEISHU_A,
      feishuAppId: 'cli_app',
      feishuAppSecret: 'secret',
    })
    expect(createMutateAsync.mock.calls[1][0]).toMatchObject({ feishuUrl: FEISHU_B })
    // The api derives the name from the remote title; sending one would override it.
    expect(createMutateAsync.mock.calls[0][0]).not.toHaveProperty('name')
    await waitFor(() => expect(onSaved).toHaveBeenCalledTimes(1))
  })

  it('collapses duplicate lines into a single request', async () => {
    const user = userEvent.setup()
    renderCreateForm()

    await user.type(urlTextarea(), `${FEISHU_A}\n${FEISHU_A}`)
    await fillFeishuCredentials(user)
    await user.click(submit())

    await waitFor(() => expect(createMutateAsync).toHaveBeenCalledTimes(1))
  })

  it('does not submit when the textarea holds only whitespace', async () => {
    const user = userEvent.setup()
    renderCreateForm()

    await user.type(urlTextarea(), '   \n  ')
    await fillFeishuCredentials(user)
    await user.click(submit())

    await waitFor(() => expect(screen.getByText('请至少填写一个链接。')).toBeInTheDocument())
    expect(createMutateAsync).not.toHaveBeenCalled()
  })

  it('blocks submission over the batch cap instead of silently truncating', async () => {
    const user = userEvent.setup()
    renderCreateForm()

    const many = Array.from({ length: KB_BATCH_MAX + 1 }, (_, i) => `https://a.com/${i}`)
    await user.click(urlTextarea())
    await user.paste(many.join('\n'))
    await fillFeishuCredentials(user)

    expect(await screen.findByText(`一次最多添加 ${KB_BATCH_MAX} 个，请分批添加。`)).toBeVisible()
    expect(submit()).toBeDisabled()

    // Submitting the form directly bypasses the disabled button (Enter in a text input,
    // for instance), so onSubmit must carry its own guard.
    const form = document.querySelector('form') as HTMLFormElement
    form.requestSubmit()
    await waitFor(() =>
      expect(screen.getByText('每行一个链接，可一次添加多个文档。')).toBeVisible(),
    )
    expect(createMutateAsync).not.toHaveBeenCalled()
  })

  it('keeps successes, reports the failure and leaves the failed URL for retry', async () => {
    const user = userEvent.setup()
    const { onSaved } = renderCreateForm()
    createMutateAsync.mockImplementation(async (input: { feishuUrl: string }) => {
      if (input.feishuUrl === FEISHU_B) throw new Error('应用无该文档权限')
      return { data: { id: 'kbd_a', name: '2026 Q3 需求' } }
    })

    await user.type(urlTextarea(), `${FEISHU_A}\n${FEISHU_B}`)
    await fillFeishuCredentials(user)
    await user.click(submit())

    await waitFor(() => expect(screen.getByText('应用无该文档权限')).toBeInTheDocument())
    expect(screen.getByText('2026 Q3 需求')).toBeInTheDocument()
    // Only the failed line survives, so a retry re-submits exactly what still needs doing.
    expect(urlTextarea()).toHaveValue(FEISHU_B)
    expect(onSaved).not.toHaveBeenCalled()
  })

  it('posts Notion links on notionUrl and reads the Notion textarea for the cap', async () => {
    const user = userEvent.setup()
    renderCreateForm()
    await user.click(screen.getByText('Notion 页面'))

    const notionBox = screen.getByPlaceholderText(/notion\.so/)
    await user.type(notionBox, 'https://www.notion.so/aaa\nhttps://www.notion.so/bbb')
    await user.type(screen.getByPlaceholderText('ntn_xxxxxxxx'), 'ntn_tok')
    await user.click(submit())

    await waitFor(() => expect(createMutateAsync).toHaveBeenCalledTimes(2))
    expect(createMutateAsync.mock.calls[0][0]).toMatchObject({
      sourceType: 'notion',
      notionUrl: 'https://www.notion.so/aaa',
      notionToken: 'ntn_tok',
      feishuUrl: null,
    })
  })

  it('blocks submission over the cap counted from the Notion textarea', async () => {
    const user = userEvent.setup()
    renderCreateForm()
    await user.click(screen.getByText('Notion 页面'))

    await user.click(screen.getByPlaceholderText(/notion\.so/))
    await user.paste(
      Array.from({ length: KB_BATCH_MAX + 1 }, (_, i) => `https://www.notion.so/${i}`).join('\n'),
    )
    expect(await screen.findByText(`一次最多添加 ${KB_BATCH_MAX} 个，请分批添加。`)).toBeVisible()
    expect(submit()).toBeDisabled()
  })

  it('locks the form while a batch is in flight', async () => {
    const user = userEvent.setup()
    const { release } = deferredCreate()
    renderCreateForm()

    await user.type(urlTextarea(), `${FEISHU_A}\n${FEISHU_B}`)
    await fillFeishuCredentials(user)
    await user.click(submit())

    // Submit stays disabled for the whole run, so a second click cannot start an
    // overlapping batch that would duplicate every document.
    await waitFor(() => expect(submit()).toBeDisabled())
    expect(urlTextarea()).toHaveAttribute('readonly')
    expect(screen.getByRole('button', { name: '停止' })).toBeInTheDocument()

    release()
    await waitFor(() => expect(submit()).toBeEnabled())
  })

  /** Starts a 2-link batch, hits Stop while item 1 is in flight, then lets it finish. */
  async function runAndStop(user: ReturnType<typeof userEvent.setup>) {
    const { release } = deferredCreate()
    await user.type(urlTextarea(), `${FEISHU_A}\n${FEISHU_B}`)
    await fillFeishuCredentials(user)
    await user.click(submit())

    await user.click(await screen.findByRole('button', { name: '停止' }))
    release()
    await waitFor(() => expect(submit()).toBeEnabled())
  }

  it('stops between items and keeps the unrun links for retry', async () => {
    const user = userEvent.setup()
    renderCreateForm()

    await runAndStop(user)

    // Item 2 was never attempted, and it is what a retry should resubmit.
    expect(createMutateAsync).toHaveBeenCalledTimes(1)
    expect(urlTextarea()).toHaveValue(FEISHU_B)
  })

  it('allows a fresh submit after a stop', async () => {
    const user = userEvent.setup()
    const { onSaved } = renderCreateForm()

    await runAndStop(user)
    createMutateAsync.mockImplementation(async () => ({ data: { id: 'kbd_b', name: 'Doc B' } }))

    // The stop latch must reset, or every later submit in this modal silently does
    // nothing — no request, no message, a dead form.
    await user.click(submit())
    await waitFor(() => expect(createMutateAsync).toHaveBeenCalledTimes(2))
    await waitFor(() => expect(onSaved).toHaveBeenCalled())
  })

  it('keeps the URL recovery hint after switching source type', async () => {
    const user = userEvent.setup()
    renderCreateForm()
    createMutateAsync.mockRejectedValue(new Error('应用无该文档权限'))

    await user.type(urlTextarea(), FEISHU_A)
    await fillFeishuCredentials(user)
    await user.click(submit())
    await waitFor(() =>
      expect(screen.getByText('失败的链接已保留在上方输入框，修改后可重试。')).toBeInTheDocument(),
    )

    // The results belong to a URL batch; switching the segment must not relabel them
    // with the file-recovery instruction.
    await user.click(screen.getByText('文件上传'))
    expect(screen.getByText('失败的链接已保留在上方输入框，修改后可重试。')).toBeInTheDocument()
    expect(screen.queryByText('失败的文件需要重新选择。')).not.toBeInTheDocument()
  })

  it('does not send a request for a line that is not an absolute URL', async () => {
    const user = userEvent.setup()
    renderCreateForm()

    await user.type(urlTextarea(), `${FEISHU_A}\nnot-a-url`)
    await fillFeishuCredentials(user)
    await user.click(submit())

    await waitFor(() => expect(createMutateAsync).toHaveBeenCalledTimes(1))
    expect(createMutateAsync.mock.calls[0][0]).toMatchObject({ feishuUrl: FEISHU_A })
    expect(screen.getByText('不是有效的链接')).toBeInTheDocument()
  })
})

describe('KbDocumentForm create mode — batch upload', () => {
  beforeEach(async () => {
    vi.clearAllMocks()
    uploadMutateAsync.mockImplementation(async () => ({ data: { id: 'kbd_x', name: 'File' } }))
    await i18n.changeLanguage('zh')
  })

  async function switchToUpload(user: ReturnType<typeof userEvent.setup>) {
    await user.click(screen.getByText('文件上传'))
    return document.querySelector('input[type="file"]') as HTMLInputElement
  }

  const md = (name: string) => new File(['# hi'], name, { type: 'text/markdown' })

  it('uploads every selected file', async () => {
    const user = userEvent.setup()
    const { onSaved } = renderCreateForm()

    const input = await switchToUpload(user)
    expect(input.multiple).toBe(true)
    await user.upload(input, [md('a.md'), md('b.md')])

    await waitFor(() => expect(uploadMutateAsync).toHaveBeenCalledTimes(2))
    expect((uploadMutateAsync.mock.calls[0][0] as File).name).toBe('a.md')
    expect((uploadMutateAsync.mock.calls[1][0] as File).name).toBe('b.md')
    await waitFor(() => expect(onSaved).toHaveBeenCalledTimes(1))
  })

  it('uploads nothing when the selection exceeds the batch cap', async () => {
    const user = userEvent.setup()
    renderCreateForm()

    const input = await switchToUpload(user)
    await user.upload(
      input,
      Array.from({ length: KB_BATCH_MAX + 1 }, (_, i) => md(`f${i}.md`)),
    )

    await waitFor(() => expect(messageMock.warning).toHaveBeenCalled())
    expect(uploadMutateAsync).not.toHaveBeenCalled()
  })
})
