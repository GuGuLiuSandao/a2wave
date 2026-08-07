import i18n from '@/i18n'
import { renderWithProviders, screen, userEvent } from '@/test/render'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { SetupPage } from '../setup'

const { authStatusMock, setupMutationMock } = vi.hoisted(() => ({
  authStatusMock: vi.fn(),
  setupMutationMock: vi.fn(),
}))

vi.mock('@/hooks/use-auth', () => ({
  useAuthStatus: () => authStatusMock(),
  useSetup: () => ({ mutateAsync: setupMutationMock, isPending: false }),
}))

describe('SetupPage first-time setup', () => {
  beforeEach(() => {
    authStatusMock.mockReset()
    setupMutationMock.mockReset().mockResolvedValue({})
    authStatusMock.mockReturnValue({ data: { needSetup: true }, isLoading: false })
  })

  it('submits only the password pair, with no bootstrap credential', async () => {
    const user = userEvent.setup()
    renderWithProviders(<SetupPage />, { routerProps: { initialEntries: ['/setup'] } })

    await user.type(screen.getByLabelText(i18n.t('auth.password')), 'Secure123')
    await user.type(screen.getByLabelText(i18n.t('auth.confirmPassword')), 'Secure123')
    await user.click(screen.getByRole('button', { name: i18n.t('auth.setupButton') }))

    expect(setupMutationMock).toHaveBeenCalledWith({
      password: 'Secure123',
      confirmPassword: 'Secure123',
    })
  })

  it('renders no setup-code field at all', () => {
    // Requiring a code meant every Docker install had to stop and read the
    // container logs; re-adding the field would silently restore that.
    renderWithProviders(<SetupPage />, { routerProps: { initialEntries: ['/setup'] } })

    expect(document.querySelector('#setup-token')).toBeNull()
    expect(screen.getByLabelText(i18n.t('auth.password'))).toHaveFocus()
  })

  it('still enforces the password policy before calling the API', async () => {
    const user = userEvent.setup()
    renderWithProviders(<SetupPage />, { routerProps: { initialEntries: ['/setup'] } })

    await user.type(screen.getByLabelText(i18n.t('auth.password')), 'short')
    await user.type(screen.getByLabelText(i18n.t('auth.confirmPassword')), 'short')

    expect(screen.getByRole('button', { name: i18n.t('auth.setupButton') })).toBeDisabled()
    expect(setupMutationMock).not.toHaveBeenCalled()
  })
})
