import { renderWithProviders, screen } from '@/test/render'
import { describe, expect, it } from 'vitest'
import { ChannelConnectionStatus } from '../channel-connection-status'

describe('ChannelConnectionStatus', () => {
  it('names the protocol so three enabled chat channels are told apart', () => {
    renderWithProviders(<ChannelConnectionStatus channel="feishu" kind="connected" />)
    renderWithProviders(<ChannelConnectionStatus channel="slack" kind="connected" />)
    renderWithProviders(<ChannelConnectionStatus channel="discord" kind="connected" />)

    expect(screen.getByText('WebSocket')).toBeInTheDocument()
    expect(screen.getByText('Socket Mode')).toBeInTheDocument()
    expect(screen.getByText('Gateway')).toBeInTheDocument()
  })

  it('exposes the raw state so the card can be asserted on without copy coupling', () => {
    renderWithProviders(<ChannelConnectionStatus channel="slack" kind="reconnecting" />)
    expect(screen.getByTestId('channel-connection-slack')).toHaveAttribute(
      'data-state',
      'reconnecting',
    )
  })

  it('renders a disconnected state when the channel has been switched off', () => {
    renderWithProviders(<ChannelConnectionStatus channel="discord" kind="disabled" />)
    expect(screen.getByTestId('channel-connection-discord')).toHaveAttribute(
      'data-state',
      'disabled',
    )
  })

  it('renders the spinner while the status query is in flight', () => {
    const { container } = renderWithProviders(
      <ChannelConnectionStatus channel="feishu" kind="loading" />,
    )
    expect(screen.getByTestId('channel-connection-feishu')).toHaveAttribute('data-state', 'loading')
    expect(container.querySelector('.animate-spin')).toBeInTheDocument()
  })

  it('distinguishes a preempted app from a switched-off channel', () => {
    // `absent` is the "another Agent claimed this app" state the FAQ points
    // operators at, so it must not render like a disabled channel.
    renderWithProviders(<ChannelConnectionStatus channel="feishu" kind="absent" />)
    expect(screen.getByTestId('channel-connection-feishu')).toHaveAttribute('data-state', 'absent')
    expect(screen.getByText(/无连接|No connection/)).toBeInTheDocument()
  })

  it('surfaces a failed status query instead of spinning forever', () => {
    renderWithProviders(<ChannelConnectionStatus channel="slack" kind="error" />)
    expect(screen.getByTestId('channel-connection-slack')).toHaveAttribute('data-state', 'error')
  })

  it('marks an unsaved switch toggle as pending rather than contradicting it', () => {
    renderWithProviders(<ChannelConnectionStatus channel="slack" kind="pending" />)
    expect(screen.getByTestId('channel-connection-slack')).toHaveAttribute('data-state', 'pending')
  })
})
