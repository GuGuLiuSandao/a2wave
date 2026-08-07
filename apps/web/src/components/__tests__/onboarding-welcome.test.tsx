import { renderWithProviders, screen, userEvent } from '@/test/render'
import { beforeEach, describe, expect, it, vi } from 'vitest'

// useOnboarding 用 spy 替身，断言 dismiss/start 被正确调用。默认 done=false 让欢迎弹窗弹出。
const dismiss = vi.fn()
const start = vi.fn()
const reset = vi.fn()
let onboardingState = { done: false, active: false, isLoading: false }
vi.mock('@/hooks/use-onboarding', () => ({
  useOnboarding: () => ({ ...onboardingState, start, dismiss, reset }),
}))

import { OnboardingWelcome } from '../onboarding-welcome'

describe('OnboardingWelcome', () => {
  beforeEach(() => {
    dismiss.mockClear()
    start.mockClear()
    reset.mockClear()
    onboardingState = { done: false, active: false, isLoading: false }
  })

  it('does not show when onboarding already done', () => {
    onboardingState = { done: true, active: false, isLoading: false }
    renderWithProviders(<OnboardingWelcome />)
    expect(screen.queryByText('欢迎使用 a2wave')).not.toBeInTheDocument()
  })

  it('「我想试试」starts the tour', async () => {
    const user = userEvent.setup()
    renderWithProviders(<OnboardingWelcome />)
    await user.click(screen.getByText('我想试试'))
    expect(start).toHaveBeenCalledTimes(1)
    expect(dismiss).not.toHaveBeenCalled()
  })

  it('「不再提示」directly persists dismissed (no retention step)', async () => {
    const user = userEvent.setup()
    renderWithProviders(<OnboardingWelcome />)
    await user.click(screen.getByText('不再提示'))
    expect(dismiss).toHaveBeenCalledTimes(1)
    expect(start).not.toHaveBeenCalled()
  })

  // 回归：ESC 关闭也要记录 dismissed，否则 done 仍 false，下次登录又弹。
  it('closing via ESC persists dismissed (no re-pop next login)', async () => {
    const user = userEvent.setup()
    renderWithProviders(<OnboardingWelcome />)
    expect(screen.getByText('欢迎使用 a2wave')).toBeInTheDocument()
    await user.keyboard('{Escape}')
    expect(dismiss).toHaveBeenCalledTimes(1)
  })
})
