import { renderWithProviders, screen, waitFor } from '@/test/render'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { AboutDialog, GITHUB_REPO_URL } from '../about-dialog'

vi.mock('@/hooks/use-settings', () => ({
  useSettings: () => ({ data: { branding: {} } }),
}))

const fetchMock = vi.fn()

describe('AboutDialog', () => {
  beforeEach(() => {
    fetchMock.mockReset()
    fetchMock.mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ version: 'v0.7.0' }),
    })
    vi.stubGlobal('fetch', fetchMock)
  })

  it('renders product info, version and action links', async () => {
    renderWithProviders(<AboutDialog open onOpenChange={vi.fn()} />)

    expect(screen.getByText('A2WAVE')).toBeInTheDocument()
    expect(screen.getByText(/Agent 搭建与编排平台/)).toBeInTheDocument()

    await waitFor(() => {
      expect(screen.getByText(/v0\.7\.0/)).toBeInTheDocument()
    })

    const github = screen.getByRole('link', { name: /GitHub/ })
    expect(github).toHaveAttribute('href', GITHUB_REPO_URL)
    expect(github).toHaveAttribute('target', '_blank')

    const changelog = screen.getByRole('link', { name: /更新日志/ })
    expect(changelog).toHaveAttribute('href', '/changelog')
  })

  it('closes the dialog when navigating to changelog', async () => {
    const onOpenChange = vi.fn()
    renderWithProviders(<AboutDialog open onOpenChange={onOpenChange} />)

    await userEvent.click(screen.getByRole('link', { name: /更新日志/ }))
    expect(onOpenChange).toHaveBeenCalledWith(false)
  })

  it('renders nothing version-related when health fetch fails', async () => {
    fetchMock.mockResolvedValue({ ok: false, json: () => Promise.resolve({}) })
    renderWithProviders(<AboutDialog open onOpenChange={vi.fn()} />)

    expect(screen.getByText('A2WAVE')).toBeInTheDocument()
    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalled()
    })
    expect(screen.queryByText(/v0\.7\.0/)).not.toBeInTheDocument()
  })
})
