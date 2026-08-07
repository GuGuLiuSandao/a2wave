import { useCallback, useMemo } from 'react'
import { useLocation, useNavigate } from 'react-router-dom'

/**
 * Query-string backed UI state.
 *
 * Filters and open dialogs used to live in `useState`, so a filtered list or an
 * open record could not be linked, bookmarked, or restored after a reload —
 * "look at this MCP server" meant "open the page, pick the group, find the row".
 * Putting that state in the URL makes those views addressable.
 *
 * Writes use `replace: true`: a filter keystroke is not a navigation step, and
 * pushing one entry per change would turn Back into an undo of the filter rather
 * than a way off the page.
 */

/** Values that mean "nothing selected" and are therefore dropped from the URL. */
function isDefault(value: string, defaultValue: string) {
  return value === defaultValue || value === ''
}

/**
 * The search string as of the last write in this tick, or null when idle.
 *
 * Two hooks writing in the same tick used to lose an update. `setSearchParams`
 * looks like `useState`'s functional form, but it is not queued the same way:
 * both callbacks receive the *same* pre-update params, so the second write
 * rebuilds from a snapshot that never saw the first and overwrites it. The
 * remote-skill installer hits this exactly — it opens the editor for the new
 * skill and closes the installer in one tick, leaving the user on a bare
 * /skills with no editor open.
 *
 * Each write navigates immediately and records its own result here, so a second
 * write in the same tick builds on the first instead of on the render-time
 * snapshot. Cleared on a microtask, by which point React has re-rendered and
 * `useLocation` is authoritative again.
 *
 * Applying synchronously (rather than batching onto a microtask) keeps these
 * hooks drop-in for `useState`: a caller that writes and then reads the URL in
 * the same `act()` — as the tests do — still sees the update.
 */
let liveSearch: string | null = null
let resetScheduled = false

/**
 * Apply one param edit against the freshest search string available, navigate,
 * and remember the result for any further write in this same tick.
 *
 * `baseSearch` comes from the router's location (not `window.location`) so this
 * works under MemoryRouter in tests and under a basename in the app.
 */
function applyParamEdit(
  edit: (params: URLSearchParams) => void,
  baseSearch: string,
  navigate: (search: string) => void,
) {
  const params = new URLSearchParams(liveSearch ?? baseSearch)
  edit(params)
  const search = params.toString()
  liveSearch = search ? `?${search}` : ''

  if (!resetScheduled) {
    resetScheduled = true
    queueMicrotask(() => {
      liveSearch = null
      resetScheduled = false
    })
  }

  navigate(liveSearch)
}

interface UrlParamOptions {
  /** Value when the param is absent; also the value that removes it from the URL. */
  defaultValue?: string
  /**
   * Whitelist of acceptable values. A URL is user-editable input, so anything
   * outside the list falls back to the default rather than reaching the page.
   */
  allowed?: readonly string[]
}

/**
 * A single query param as `[value, setValue]`, shaped like `useState` so a page
 * can swap one for the other without restructuring.
 */
export function useUrlParam(
  key: string,
  options: UrlParamOptions = {},
): [string, (next: string) => void] {
  const { defaultValue = '', allowed } = options
  const { search } = useLocation()
  const navigate = useNavigate()

  const raw = new URLSearchParams(search).get(key)
  const value = raw == null || (allowed && !allowed.includes(raw)) ? defaultValue : raw

  const setValue = useCallback(
    (next: string) => {
      applyParamEdit(
        (params) => {
          if (isDefault(next, defaultValue)) params.delete(key)
          else params.set(key, next)
        },
        search,
        (nextSearch) => navigate({ search: nextSearch }, { replace: true }),
      )
    },
    [key, defaultValue, navigate, search],
  )

  return [value, setValue]
}

/**
 * A boolean dialog with no record behind it (an installer, a wizard), as
 * `[open, setOpen]`. Present in the URL means open; absent means closed.
 */
export function useUrlFlag(key: string): [boolean, (next: boolean) => void] {
  const [value, setValue] = useUrlParam(key)
  const setOpen = useCallback((next: boolean) => setValue(next ? '1' : ''), [setValue])
  return [value !== '', setOpen]
}

/** Sentinel for "create" — distinguishes an empty form from editing a record. */
export const NEW_RECORD = 'new'

export interface UrlRecordState {
  /** True when the dialog should be rendered. */
  open: boolean
  /** The record being edited; undefined in create mode. */
  id: string | undefined
  openCreate: () => void
  openEdit: (id: string) => void
  close: () => void
}

/**
 * A create/edit dialog addressed by one query param: `?skill=new` for create,
 * `?skill=skl_42` to edit. Other params are preserved, so opening and closing a
 * dialog never discards the filter the user set behind it.
 */
export function useUrlRecord(key: string): UrlRecordState {
  const { search } = useLocation()
  const navigate = useNavigate()
  const raw = new URLSearchParams(search).get(key)

  const write = useCallback(
    (next: string | null) => {
      applyParamEdit(
        (params) => {
          if (next == null) params.delete(key)
          else params.set(key, next)
        },
        search,
        (nextSearch) => navigate({ search: nextSearch }, { replace: true }),
      )
    },
    [key, navigate, search],
  )

  return useMemo(
    () => ({
      open: raw != null && raw !== '',
      id: raw && raw !== NEW_RECORD ? raw : undefined,
      openCreate: () => write(NEW_RECORD),
      openEdit: (id: string) => write(id),
      close: () => write(null),
    }),
    [raw, write],
  )
}
