import { ThemePickerDialog } from '@/components/theme-picker-dialog'
import { ThemeProvider, useTheme } from '@/components/theme-provider'
import { themeRegistry } from '@/lib/themes'
import { renderWithProviders, screen, waitFor } from '@/test/render'
import { fireEvent } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { useState } from 'react'
import { beforeEach, describe, expect, it } from 'vitest'

function ThemeHarness({
  initiallyOpen = true,
  closeOnRequest = true,
}: {
  initiallyOpen?: boolean
  closeOnRequest?: boolean
}) {
  const [open, setOpen] = useState(initiallyOpen)
  const { preference, resolvedTheme } = useTheme()
  const handleOpenChange = (nextOpen: boolean) => {
    if (nextOpen || closeOnRequest) setOpen(nextOpen)
  }

  return (
    <>
      <output data-testid="preference">{preference}</output>
      <output data-testid="resolved">{resolvedTheme.id}</output>
      {!open && (
        <button type="button" onClick={() => setOpen(true)}>
          Open themes
        </button>
      )}
      <ThemePickerDialog open={open} onOpenChange={handleOpenChange} />
    </>
  )
}

function renderDialog(initiallyOpen = true, closeOnRequest = true) {
  return renderWithProviders(
    <ThemeProvider>
      <ThemeHarness initiallyOpen={initiallyOpen} closeOnRequest={closeOnRequest} />
    </ThemeProvider>,
  )
}

function UnmountPickerHarness() {
  const [mounted, setMounted] = useState(true)
  const { resolvedTheme } = useTheme()
  return (
    <>
      <output data-testid="unmount-resolved">{resolvedTheme.id}</output>
      <button type="button" onClick={() => setMounted(false)}>
        Unmount picker
      </button>
      {mounted && <ThemePickerDialog open onOpenChange={() => {}} />}
    </>
  )
}

describe('ThemePickerDialog', () => {
  beforeEach(() => {
    localStorage.clear()
  })

  it('previews on selection without persisting, then restores on cancel', async () => {
    const user = userEvent.setup()
    renderDialog()

    await user.click(await screen.findByRole('radio', { name: /Neo Yellow/ }))

    await waitFor(() => expect(document.documentElement.dataset.theme).toBe('neo-yellow'))
    expect(localStorage.getItem('a2wave.theme')).toBeNull()

    await user.click(screen.getByRole('button', { name: '取消' }))
    expect(document.documentElement.dataset.theme).toBe('wave-light')
    expect(screen.getByTestId('preference')).toHaveTextContent('system')
  })

  it('does not repaint the app merely from pointing at a theme card', async () => {
    // Preview is a deliberate act. Repainting the whole UI on hover made the
    // dialog flicker as the pointer crossed the grid on its way to a target,
    // and moving the mouse out of the modal snapped everything back.
    renderDialog()

    const neoOption = (await screen.findByRole('radio', { name: /Neo Yellow/ })).closest('label')
    expect(neoOption).not.toBeNull()

    fireEvent.pointerEnter(neoOption as HTMLLabelElement)

    expect(document.documentElement.dataset.theme).toBe('wave-light')
    expect(localStorage.getItem('a2wave.theme')).toBeNull()
  })

  it('commits the selected theme and persists it', async () => {
    const user = userEvent.setup()
    renderDialog()

    await user.click(await screen.findByRole('radio', { name: /Midnight/ }))
    expect(document.documentElement.dataset.theme).toBe('midnight')
    expect(localStorage.getItem('a2wave.theme')).toBeNull()

    await user.click(screen.getByRole('button', { name: '应用主题' }))

    expect(localStorage.getItem('a2wave.theme')).toBe('midnight')
    expect(document.documentElement.dataset.appearance).toBe('dark')
    expect(screen.getByTestId('preference')).toHaveTextContent('midnight')
  })

  it('offers System plus all registered themes as an accessible radio group', async () => {
    renderDialog()

    expect(await screen.findByRole('radiogroup', { name: '主题' })).toBeInTheDocument()
    expect(screen.getAllByRole('radio')).toHaveLength(7)
    expect(screen.getByRole('radio', { name: /跟随系统/ })).toBeChecked()
  })

  it('renders every swatch from ThemeSpec depth tokens without theme-id branches', async () => {
    renderDialog()
    await screen.findByRole('radiogroup', { name: '主题' })

    for (const theme of themeRegistry) {
      const swatch = document.querySelector<HTMLElement>(
        `[data-theme-option="${theme.id}"] > [aria-hidden="true"]`,
      )
      expect(swatch?.style.boxShadow).toBe(theme.shadows.sm)
    }
  })

  it('opens without previewing a different theme and focuses the selected option', async () => {
    localStorage.setItem('a2wave.theme', 'midnight')
    const user = userEvent.setup()
    renderDialog(false)
    expect(document.documentElement.dataset.theme).toBe('midnight')

    await user.click(screen.getByRole('button', { name: 'Open themes' }))
    const midnight = await screen.findByRole('radio', { name: /Midnight/ })

    await waitFor(() => expect(midnight).toHaveFocus())
    expect(document.documentElement.dataset.theme).toBe('midnight')
    expect(localStorage.getItem('a2wave.theme')).toBe('midnight')
  })

  // Arrow keys move *and* check a radio, so keyboard navigation is a real
  // selection and previews like a click. What must not survive is the preview
  // once Escape closes the dialog.
  it('does not keep a keyboard-selected preview when Escape closes the dialog', async () => {
    localStorage.setItem('a2wave.theme', 'wave-light')
    const user = userEvent.setup()
    renderDialog(true, false)

    const waveLight = await screen.findByRole('radio', { name: /Wave Light/ })
    await waitFor(() => expect(waveLight).toHaveFocus())
    await user.keyboard('{ArrowRight}')

    const waveDark = screen.getByRole('radio', { name: /Wave Dark/ })
    expect(waveDark).toBeChecked()
    expect(document.documentElement.dataset.theme).toBe('wave-dark')
    expect(localStorage.getItem('a2wave.theme')).toBe('wave-light')

    await user.keyboard('{Escape}')
    // Ant Design keeps the modal mounted through its closing motion, so a late
    // event can still reach the radio after cancel() ran. It must not re-apply
    // the abandoned draft.
    fireEvent.blur(waveDark)

    expect(document.documentElement.dataset.theme).toBe('wave-light')
    expect(localStorage.getItem('a2wave.theme')).toBe('wave-light')
  })

  it('clears a transient preview when the picker unmounts', async () => {
    renderWithProviders(
      <ThemeProvider>
        <UnmountPickerHarness />
      </ThemeProvider>,
    )

    fireEvent.click(await screen.findByRole('radio', { name: /Neo Yellow/ }))
    await waitFor(() =>
      expect(screen.getByTestId('unmount-resolved')).toHaveTextContent('neo-yellow'),
    )

    fireEvent.click(screen.getByRole('button', { name: 'Unmount picker' }))
    await waitFor(() =>
      expect(screen.getByTestId('unmount-resolved')).toHaveTextContent('wave-light'),
    )
    expect(localStorage.getItem('a2wave.theme')).toBeNull()
  })

  it('does not overwrite an open draft when another tab changes the persisted preference', async () => {
    const user = userEvent.setup()
    renderDialog()

    const midnight = await screen.findByRole('radio', { name: /Midnight/ })
    await user.click(midnight)
    expect(midnight).toBeChecked()

    localStorage.setItem('a2wave.theme', 'forest')
    fireEvent(
      window,
      new StorageEvent('storage', {
        key: 'a2wave.theme',
        newValue: 'forest',
      }),
    )

    await waitFor(() => expect(screen.getByTestId('preference')).toHaveTextContent('forest'))
    expect(midnight).toBeChecked()

    await user.click(screen.getByRole('button', { name: '应用主题' }))
    expect(localStorage.getItem('a2wave.theme')).toBe('midnight')
  })
})
