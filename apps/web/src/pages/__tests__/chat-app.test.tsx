/**
 * Render tests for the chat app page.
 *
 * Focus: the states a visitor can land in (loading / unavailable / ready), the
 * profile sidebar contents, and the suggested-question affordance — the parts a
 * forwarded link exposes to someone who has never seen the console.
 */
import { renderWithProviders, screen, userEvent, waitFor } from '@/test/render'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const mockProfile = vi.fn()

vi.mock('@/hooks/use-chat-app', () => ({
  useChatAppProfile: () => mockProfile(),
}))

const sendMessage = vi.fn()
let mockMessages: Array<{ role: 'user' | 'agent'; content: string }> = []

vi.mock('@/hooks/use-agent-chat', () => ({
  useAgentChat: () => ({
    messages: mockMessages,
    setMessages: vi.fn(),
    chatInput: '',
    setChatInput: vi.fn(),
    pendingAttachments: [],
    addFiles: vi.fn(),
    removeAttachment: vi.fn(),
    isStreaming: false,
    chatError: null,
    setChatError: vi.fn(),
    streamLogs: [],
    currentRunId: undefined,
    setCurrentRunId: vi.fn(),
    chatId: undefined,
    agentChats: [],
    attachmentConfig: { allowedExtensions: ['png'], maxFilesPerRequest: 5, maxFileSizeBytes: 100 },
    sendMessage,
    stopStreaming: vi.fn(),
    startNewConversation: vi.fn(),
    canSend: false,
  }),
}))

vi.mock('react-router-dom', async () => {
  const actual = await vi.importActual<typeof import('react-router-dom')>('react-router-dom')
  return { ...actual, useParams: () => ({ id: 'agt_test1' }) }
})

import { ChatAppPage } from '../chat-app'

const READY_PROFILE = {
  id: 'agt_test1',
  name: '客服助手',
  description: '回答产品相关问题',
  icon: '🤖',
  status: 'active',
  publishStatus: 'published',
  createdAt: new Date().toISOString(),
  creator: { name: 'Alice' },
  welcomeMessage: null,
  suggestedQuestions: ['怎么重置密码？'],
  showCreator: true,
  allowAttachments: true,
  showThinking: true,
}

describe('ChatAppPage', () => {
  beforeEach(() => {
    mockMessages = []
    sendMessage.mockClear()
  })

  it('renders the agent profile and creator once loaded', async () => {
    mockProfile.mockReturnValue({ data: READY_PROFILE, isLoading: false, isError: false })
    renderWithProviders(<ChatAppPage />)

    expect(await screen.findByText('客服助手')).toBeInTheDocument()
    expect(screen.getByText('回答产品相关问题')).toBeInTheDocument()
    expect(screen.getByText('Alice')).toBeInTheDocument()
  })

  it('hides the creator when the config opts out', async () => {
    mockProfile.mockReturnValue({
      data: { ...READY_PROFILE, showCreator: false },
      isLoading: false,
      isError: false,
    })
    renderWithProviders(<ChatAppPage />)

    await screen.findByText('客服助手')
    expect(screen.queryByText('Alice')).not.toBeInTheDocument()
  })

  it('sends a suggested question on click', async () => {
    const user = userEvent.setup()
    sendMessage.mockClear()
    mockProfile.mockReturnValue({ data: READY_PROFILE, isLoading: false, isError: false })
    renderWithProviders(<ChatAppPage />)

    await user.click(await screen.findByRole('button', { name: '怎么重置密码？' }))
    await waitFor(() => expect(sendMessage).toHaveBeenCalledWith('怎么重置密码？'))
  })

  it('offers a reset affordance that is not gated behind the lg breakpoint', async () => {
    mockProfile.mockReturnValue({ data: READY_PROFILE, isLoading: false, isError: false })
    // A transcript must exist for the reset control to be offered at all.
    mockMessages = [{ role: 'user', content: 'hi' }]
    renderWithProviders(<ChatAppPage />)

    const resets = await screen.findAllByRole('button', { name: '开启新对话' })
    // Below lg the sidebar collapses and the footer block is display:none, so at
    // least one reset control must sit outside a lg-only container.
    const alwaysVisible = resets.filter(
      (el) => !el.closest('.lg\\:flex') && !el.closest('.lg\\:block'),
    )
    expect(alwaysVisible.length).toBeGreaterThan(0)
  })

  it('shows the unavailable state when the channel is off (404)', async () => {
    mockProfile.mockReturnValue({ data: undefined, isLoading: false, isError: true })
    renderWithProviders(<ChatAppPage />)

    expect(await screen.findByText('页面不可用')).toBeInTheDocument()
  })

  it('explains itself instead of failing silently when the agent is stopped', async () => {
    mockProfile.mockReturnValue({
      data: { ...READY_PROFILE, publishStatus: 'stopped' },
      isLoading: false,
      isError: false,
    })
    renderWithProviders(<ChatAppPage />)

    expect(await screen.findByText(/已停止发布/)).toBeInTheDocument()
  })

  it('explains itself when the agent is inactive', async () => {
    mockProfile.mockReturnValue({
      data: { ...READY_PROFILE, status: 'inactive' },
      isLoading: false,
      isError: false,
    })
    renderWithProviders(<ChatAppPage />)

    expect(await screen.findByText(/未激活/)).toBeInTheDocument()
  })
})
