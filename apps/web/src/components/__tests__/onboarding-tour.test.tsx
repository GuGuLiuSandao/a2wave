import { OnboardingTour } from '@/components/onboarding/onboarding-tour'
import { renderWithProviders } from '@/test/render'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const { joyrideSpy } = vi.hoisted(() => ({ joyrideSpy: vi.fn() }))

vi.mock('react-joyride', () => ({
  ACTIONS: { CLOSE: 'close' },
  EVENTS: { TOUR_END: 'tour:end' },
  Joyride: (props: unknown) => {
    joyrideSpy(props)
    return null
  },
}))

vi.mock('@/hooks/use-onboarding', () => ({
  useOnboarding: () => ({
    active: false,
    complete: vi.fn(),
    pause: vi.fn(),
  }),
}))

describe('OnboardingTour theme tokens', () => {
  beforeEach(() => {
    joyrideSpy.mockClear()
  })

  it('passes the semantic primary token to Joyride', () => {
    renderWithProviders(<OnboardingTour />)

    expect(joyrideSpy).toHaveBeenCalled()
    const props = joyrideSpy.mock.lastCall?.[0] as {
      options?: { primaryColor?: string }
    }
    expect(props.options?.primaryColor).toBe('var(--color-primary)')
  })
})
