import { ThemeProvider, useTheme } from '@/components/theme-provider'
import { act, fireEvent, renderWithProviders, screen } from '@/test/render'
import { afterEach, describe, expect, it, vi } from 'vitest'

function CurrentTheme() {
  const { preference, resolvedTheme, setPreference } = useTheme()
  return (
    <>
      <output data-testid="theme-state">
        {preference}:{resolvedTheme.id}
      </output>
      <button type="button" onClick={() => setPreference('neo-yellow')}>
        Use Neo
      </button>
    </>
  )
}

describe('ThemeProvider', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  it('updates a System preference immediately when the OS appearance changes', () => {
    let dark = false
    let onChange: ((event: MediaQueryListEvent) => void) | undefined
    vi.stubGlobal(
      'matchMedia',
      vi.fn(() => ({
        matches: dark,
        media: '(prefers-color-scheme: dark)',
        onchange: null,
        addListener: vi.fn(),
        removeListener: vi.fn(),
        addEventListener: vi.fn(
          (_event: string, listener: (event: MediaQueryListEvent) => void) => {
            onChange = listener
          },
        ),
        removeEventListener: vi.fn(),
        dispatchEvent: vi.fn(),
      })),
    )

    renderWithProviders(
      <ThemeProvider>
        <CurrentTheme />
      </ThemeProvider>,
    )
    expect(screen.getByTestId('theme-state')).toHaveTextContent('system:wave-light')

    dark = true
    act(() => onChange?.({ matches: true } as MediaQueryListEvent))

    expect(screen.getByTestId('theme-state')).toHaveTextContent('system:wave-dark')
    expect(document.documentElement.dataset.appearance).toBe('dark')
  })

  it('falls back to the light theme when matchMedia is unavailable', () => {
    vi.stubGlobal('matchMedia', undefined)

    expect(() =>
      renderWithProviders(
        <ThemeProvider>
          <CurrentTheme />
        </ThemeProvider>,
      ),
    ).not.toThrow()

    expect(screen.getByTestId('theme-state')).toHaveTextContent('system:wave-light')
  })

  it('subscribes through the legacy MediaQueryList listener API', () => {
    let onChange: ((event: MediaQueryListEvent) => void) | undefined
    const addListener = vi.fn((listener: (event: MediaQueryListEvent) => void) => {
      onChange = listener
    })
    const removeListener = vi.fn()
    vi.stubGlobal(
      'matchMedia',
      vi.fn(() => ({
        matches: false,
        media: '(prefers-color-scheme: dark)',
        onchange: null,
        addListener,
        removeListener,
        dispatchEvent: vi.fn(),
      })),
    )

    const { unmount } = renderWithProviders(
      <ThemeProvider>
        <CurrentTheme />
      </ThemeProvider>,
    )
    expect(addListener).toHaveBeenCalledOnce()

    act(() => onChange?.({ matches: true } as MediaQueryListEvent))
    expect(screen.getByTestId('theme-state')).toHaveTextContent('system:wave-dark')

    unmount()
    expect(removeListener).toHaveBeenCalledWith(onChange)
  })

  it('keeps working in memory when access to localStorage is blocked', () => {
    vi.spyOn(window, 'localStorage', 'get').mockImplementation(() => {
      throw new DOMException('Blocked', 'SecurityError')
    })

    expect(() =>
      renderWithProviders(
        <ThemeProvider>
          <CurrentTheme />
        </ThemeProvider>,
      ),
    ).not.toThrow()
    expect(screen.getByTestId('theme-state')).toHaveTextContent('system:wave-light')

    fireEvent.click(screen.getByRole('button', { name: 'Use Neo' }))
    expect(screen.getByTestId('theme-state')).toHaveTextContent('neo-yellow:neo-yellow')
  })
})
