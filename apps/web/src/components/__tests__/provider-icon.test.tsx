import type { ProviderKind } from '@a2wave/shared'
import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { PROVIDER_ICON_TILE, getProviderIconSpec } from '../provider-icon'

describe('getProviderIconSpec', () => {
  it.each<[ProviderKind, string]>([
    ['cursor', 'Cursor'],
    ['claude-code', 'Claude'],
    ['codex', 'OpenAI'],
    ['opencode', 'OpenCode'],
    ['qoder', 'Qoder'],
    ['trae', 'Trae'],
    ['kimi', 'Kimi'],
    ['pi', 'Pi'],
  ])('selects the %s brand by stable kind', (kind, accessibleName) => {
    const { Icon } = getProviderIconSpec(kind)

    render(<Icon />)

    expect(screen.getByRole('img', { name: accessibleName })).toBeInTheDocument()
  })

  it('carries no tile background for any kind, including the fallback', () => {
    /**
     * Brand marks render bare. Kimi, Trae and Qoder ship assets that already
     * contain their own black rounded tile, so a wrapper background framed a
     * black square inside a black square. Reintroducing a `bgClass` here would
     * bring that back for exactly those three and look fine for the rest,
     * which is the kind of asymmetry nobody notices in review.
     */
    const kinds: (ProviderKind | undefined)[] = [
      'cursor',
      'claude-code',
      'codex',
      'opencode',
      'qoder',
      'trae',
      'kimi',
      'pi',
      undefined,
    ]

    for (const kind of kinds) {
      expect(getProviderIconSpec(kind)).not.toHaveProperty('bgClass')
    }
  })

  it('keeps the icon tile light in dark themes', () => {
    /**
     * Counter-intuitive on purpose. Every mark renders as an `<img>`, so the
     * three assets drawn with `fill="currentColor"` (OpenCode, OpenAI, Pi)
     * cannot inherit a foreground and always paint black. A tile that darkened
     * with the theme erased exactly those three — OpenCode's glyph reached
     * 1.3:1 against a `bg-muted` tile on Wave Dark, which is how it shipped
     * looking like an empty square.
     */
    expect(PROVIDER_ICON_TILE).toMatch(/\bdark:bg-/)
    expect(PROVIDER_ICON_TILE).not.toMatch(/dark:bg-(?:muted|transparent|zinc-[89])/)
  })

  it('falls back to a shield for an unknown kind', () => {
    const { Icon, fgClass } = getProviderIconSpec(undefined)
    expect(fgClass).toBeTruthy()

    const { container } = render(<Icon className="h-9 w-9" />)
    expect(container.querySelector('svg')).not.toBeNull()
  })
})
