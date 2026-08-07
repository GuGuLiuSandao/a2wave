import { act, renderHook } from '@testing-library/react'
import type { ReactNode } from 'react'
import { MemoryRouter, useLocation } from 'react-router-dom'
import { describe, expect, it } from 'vitest'
import { useUrlFlag, useUrlParam, useUrlRecord } from '../use-url-state'

function wrapper(initial: string) {
  return ({ children }: { children: ReactNode }) => (
    <MemoryRouter initialEntries={[initial]}>{children}</MemoryRouter>
  )
}

describe('useUrlParam', () => {
  it('reads the initial value from the query string', () => {
    const { result } = renderHook(() => useUrlParam('action'), { wrapper: wrapper('/?action=x') })
    expect(result.current[0]).toBe('x')
  })

  it('falls back to the default when the param is absent', () => {
    const { result } = renderHook(() => useUrlParam('action'), { wrapper: wrapper('/') })
    expect(result.current[0]).toBe('')
  })

  it('reads an allowed value and writes it back to the URL', () => {
    const { result } = renderHook(
      () => ({
        param: useUrlParam('type', { allowed: ['stdio', 'sse'] }),
        location: useLocation(),
      }),
      { wrapper: wrapper('/?type=sse') },
    )
    expect(result.current.param[0]).toBe('sse')

    act(() => result.current.param[1]('stdio'))
    expect(result.current.location.search).toContain('type=stdio')
  })

  it('ignores a value outside the allowed list', () => {
    // A hand-edited URL must not put the page into an unrenderable state.
    const { result } = renderHook(() => useUrlParam('type', { allowed: ['stdio'] }), {
      wrapper: wrapper('/?type=../../etc/passwd'),
    })
    expect(result.current[0]).toBe('')
  })

  it('drops the param from the URL when set back to the default', () => {
    const { result } = renderHook(() => ({ param: useUrlParam('q'), location: useLocation() }), {
      wrapper: wrapper('/?q=hello'),
    })
    act(() => result.current.param[1](''))
    expect(result.current.location.search).not.toContain('q=')
  })

  it('honours a non-empty default', () => {
    const { result } = renderHook(
      () => ({ param: useUrlParam('type', { defaultValue: 'all' }), location: useLocation() }),
      { wrapper: wrapper('/') },
    )
    expect(result.current.param[0]).toBe('all')

    act(() => result.current.param[1]('all'))
    expect(result.current.location.search).not.toContain('type=')
  })

  it('preserves unrelated params when updating', () => {
    const { result } = renderHook(() => ({ param: useUrlParam('a'), location: useLocation() }), {
      wrapper: wrapper('/?a=1&keep=yes'),
    })
    act(() => result.current.param[1]('2'))
    expect(result.current.location.search).toContain('keep=yes')
  })
})

describe('useUrlFlag', () => {
  it('is closed by default and opens into the URL', () => {
    const { result } = renderHook(
      () => ({ flag: useUrlFlag('install'), location: useLocation() }),
      { wrapper: wrapper('/') },
    )
    expect(result.current.flag[0]).toBe(false)

    act(() => result.current.flag[1](true))
    expect(result.current.location.search).toContain('install=1')
  })

  it('restores an open dialog from a deep link', () => {
    const { result } = renderHook(() => useUrlFlag('install'), { wrapper: wrapper('/?install=1') })
    expect(result.current[0]).toBe(true)
  })

  it('removes the param when closed', () => {
    const { result } = renderHook(
      () => ({ flag: useUrlFlag('install'), location: useLocation() }),
      { wrapper: wrapper('/?install=1') },
    )
    act(() => result.current.flag[1](false))
    expect(result.current.location.search).not.toContain('install')
  })
})

describe('useUrlRecord', () => {
  it('opens with an id and reflects it in the URL', () => {
    const { result } = renderHook(
      () => ({ modal: useUrlRecord('skill'), location: useLocation() }),
      { wrapper: wrapper('/') },
    )
    expect(result.current.modal.open).toBe(false)

    act(() => result.current.modal.openEdit('skl_1'))
    expect(result.current.location.search).toContain('skill=skl_1')
  })

  it('restores an edit target from a deep link', () => {
    const { result } = renderHook(() => useUrlRecord('skill'), {
      wrapper: wrapper('/?skill=skl_42'),
    })
    expect(result.current.open).toBe(true)
    expect(result.current.id).toBe('skl_42')
  })

  it('treats the "new" sentinel as create mode, not an id', () => {
    const { result } = renderHook(() => useUrlRecord('skill'), { wrapper: wrapper('/?skill=new') })
    expect(result.current.open).toBe(true)
    expect(result.current.id).toBeUndefined()
  })

  it('clears the param on close', () => {
    const { result } = renderHook(
      () => ({ modal: useUrlRecord('skill'), location: useLocation() }),
      { wrapper: wrapper('/?skill=skl_1') },
    )
    act(() => result.current.modal.close())
    expect(result.current.location.search).not.toContain('skill=')
    expect(result.current.modal.open).toBe(false)
  })

  it('keeps filters intact while a modal opens and closes', () => {
    // Closing a modal must not discard the filter the user set behind it.
    const { result } = renderHook(
      () => ({ modal: useUrlRecord('skill'), location: useLocation() }),
      { wrapper: wrapper('/?group=g1') },
    )
    act(() => result.current.modal.openCreate())
    expect(result.current.location.search).toContain('group=g1')

    act(() => result.current.modal.close())
    expect(result.current.location.search).toContain('group=g1')
  })
})

describe('combined updates in one tick', () => {
  it('keeps both writes when a record opens as a flag closes', () => {
    // The remote-skill installer does exactly this: on success it opens the
    // editor for the new skill and closes the installer. Both writes land in one
    // tick from two different hooks, so a lost update leaves the user on a bare
    // /skills with no editor.
    const { result } = renderHook(
      () => ({
        skill: useUrlRecord('skill'),
        install: useUrlFlag('install'),
        location: useLocation(),
      }),
      { wrapper: wrapper('/?install=1') },
    )

    act(() => {
      result.current.skill.openEdit('skl_new')
      result.current.install[1](false)
    })

    expect(result.current.location.search).toBe('?skill=skl_new')
  })

  it('keeps both writes in the reverse order too', () => {
    const { result } = renderHook(
      () => ({
        skill: useUrlRecord('skill'),
        install: useUrlFlag('install'),
        location: useLocation(),
      }),
      { wrapper: wrapper('/?install=1') },
    )

    act(() => {
      result.current.install[1](false)
      result.current.skill.openEdit('skl_new')
    })

    expect(result.current.location.search).toBe('?skill=skl_new')
  })
})
