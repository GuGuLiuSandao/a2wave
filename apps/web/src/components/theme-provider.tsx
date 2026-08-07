import {
  DEFAULT_THEME_PREFERENCE,
  THEME_STORAGE_KEY,
  type ThemeDefinition,
  type ThemePreference,
  applyTheme,
  getStoredThemePreference,
  isThemePreference,
  persistThemePreference,
  resolveThemePreference,
} from '@/lib/themes'
import {
  type ReactNode,
  createContext,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useState,
} from 'react'

interface ThemeContextValue {
  preference: ThemePreference
  resolvedTheme: ThemeDefinition
  previewPreference: ThemePreference | null
  setPreviewPreference: (preference: ThemePreference | null) => void
  setPreference: (preference: ThemePreference) => void
}

const ThemeContext = createContext<ThemeContextValue | null>(null)

function getInitialPreference(): ThemePreference {
  if (typeof window === 'undefined') return DEFAULT_THEME_PREFERENCE
  const storage = getBrowserStorage()
  return storage ? getStoredThemePreference(storage) : DEFAULT_THEME_PREFERENCE
}

const DARK_MODE_QUERY = '(prefers-color-scheme: dark)'

function getBrowserStorage(): Storage | null {
  if (typeof window === 'undefined') return null

  try {
    return window.localStorage
  } catch {
    return null
  }
}

function getDarkModeMediaQuery(): MediaQueryList | null {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return null

  try {
    return window.matchMedia(DARK_MODE_QUERY) ?? null
  } catch {
    return null
  }
}

function getSystemDarkPreference() {
  return getDarkModeMediaQuery()?.matches ?? false
}

export function ThemeProvider({ children }: { children: ReactNode }) {
  const [preference, updatePreference] = useState<ThemePreference>(getInitialPreference)
  const [previewPreference, setPreviewPreference] = useState<ThemePreference | null>(null)
  const [prefersDark, setPrefersDark] = useState(getSystemDarkPreference)
  const activePreference = previewPreference ?? preference
  const resolvedTheme = useMemo(
    () => resolveThemePreference(activePreference, prefersDark),
    [activePreference, prefersDark],
  )

  useLayoutEffect(() => {
    applyTheme(activePreference, { prefersDark })
  }, [activePreference, prefersDark])

  useEffect(() => {
    const media = getDarkModeMediaQuery()
    if (!media) return

    const handleChange = (event: MediaQueryListEvent) => setPrefersDark(event.matches)
    if (typeof media.addEventListener === 'function') {
      media.addEventListener('change', handleChange)
      return () => media.removeEventListener('change', handleChange)
    }
    if (typeof media.addListener === 'function') {
      media.addListener(handleChange)
      return () => media.removeListener(handleChange)
    }
  }, [])

  useEffect(() => {
    const handleStorage = (event: StorageEvent) => {
      if (event.key !== THEME_STORAGE_KEY || !isThemePreference(event.newValue)) return
      updatePreference(event.newValue)
      setPreviewPreference(null)
    }
    window.addEventListener('storage', handleStorage)
    return () => window.removeEventListener('storage', handleStorage)
  }, [])

  const value = useMemo<ThemeContextValue>(
    () => ({
      preference,
      resolvedTheme,
      previewPreference,
      setPreviewPreference,
      setPreference(nextPreference) {
        const storage = getBrowserStorage()
        if (storage) persistThemePreference(nextPreference, storage)
        updatePreference(nextPreference)
        setPreviewPreference(null)
      },
    }),
    [preference, previewPreference, resolvedTheme],
  )

  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>
}

export function useTheme(): ThemeContextValue {
  const context = useContext(ThemeContext)
  if (!context) throw new Error('useTheme must be used within ThemeProvider')
  return context
}
