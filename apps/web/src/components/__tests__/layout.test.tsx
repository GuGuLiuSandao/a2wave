import { renderWithProviders, screen } from '@/test/render'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { Layout } from '../layout'

// No signed-in user: UserMenu renders nothing, so only the nav is under test.
vi.mock('@/hooks/use-auth', () => ({
  useCurrentUser: () => ({ data: null }),
  useOauthConfig: () => ({ data: undefined }),
  useLogout: () => vi.fn(),
  useUpdateLocale: () => ({ mutate: vi.fn() }),
  useChangePassword: () => ({ mutate: vi.fn(), isPending: false }),
}))
vi.mock('@/hooks/use-settings', () => ({
  useSettings: () => ({ data: undefined }),
}))
// OnboardingTour pulls in react-joyride + several queries; the sidebar doesn't need it.
vi.mock('@/components/onboarding/onboarding-tour', () => ({
  OnboardingTour: () => null,
}))

describe('Layout sidebar collapse', () => {
  beforeEach(() => {
    localStorage.clear()
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 1024 })
    // jsdom doesn't implement Element.scrollTo; Layout calls it on route change.
    Element.prototype.scrollTo = vi.fn()
  })

  it('shows nav labels when expanded and hides them once collapsed', async () => {
    const user = userEvent.setup()
    renderWithProviders(
      <Layout>
        <div>content</div>
      </Layout>,
    )

    const agentsLink = screen.getByRole('link', { name: /agents/i })
    expect(agentsLink).toHaveTextContent(/agents/i)

    await user.click(screen.getByRole('button', { name: /collapse sidebar|收起侧边栏/i }))

    // Collapsed: the icon-only link keeps its accessible name via aria-label,
    // but the visible text label is gone.
    expect(screen.getByRole('link', { name: /agents/i }).textContent).toBe('')
  })

  it('persists the collapsed choice across mounts', async () => {
    const user = userEvent.setup()
    const { unmount } = renderWithProviders(
      <Layout>
        <div>content</div>
      </Layout>,
    )

    await user.click(screen.getByRole('button', { name: /collapse sidebar|收起侧边栏/i }))
    unmount()

    renderWithProviders(
      <Layout>
        <div>content</div>
      </Layout>,
    )
    expect(screen.getByRole('button', { name: /expand sidebar|展开侧边栏/i })).toBeInTheDocument()
  })

  it('uses dedicated semantic tokens for the active navigation item', () => {
    renderWithProviders(
      <Layout>
        <div>content</div>
      </Layout>,
    )

    const dashboardLink = screen.getByRole('link', { name: /dashboard|仪表盘/i })
    expect(dashboardLink).toHaveClass('bg-sidebar-active-background')
    expect(dashboardLink).toHaveClass('text-sidebar-active-foreground')
    expect(dashboardLink).toHaveClass('border-sidebar-active-border')
    expect(dashboardLink.className).not.toMatch(/primary|rgb/)
  })

  it('forces the sidebar into its compact layout at a 390px viewport', () => {
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 390 })

    renderWithProviders(
      <Layout>
        <div>mobile content</div>
      </Layout>,
    )

    const sidebar = document.querySelector('aside')
    const main = document.querySelector('main')
    expect(sidebar).toHaveStyle({ width: '64px' })
    expect(main).toHaveStyle({ marginLeft: '64px' })
    expect(main).toHaveClass('min-w-0')
    expect(screen.getByRole('link', { name: /agents/i }).textContent).toBe('')
    expect(
      screen.queryByRole('button', {
        name: /collapse sidebar|expand sidebar|收起侧边栏|展开侧边栏/i,
      }),
    ).not.toBeInTheDocument()
  })
})
