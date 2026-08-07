import { cn } from '@/lib/utils'
import { Search } from 'lucide-react'
import {
  type HTMLAttributes,
  type InputHTMLAttributes,
  type ReactNode,
  createContext,
  forwardRef,
  useCallback,
  useContext,
  useEffect,
  useId,
  useMemo,
  useState,
} from 'react'

// ─── Context ────────────────────────────────────────────────
interface CommandContextValue {
  search: string
  setSearch: (v: string) => void
  selectedValue: string
  setSelectedValue: (v: string) => void
  /** An item reports whether it is currently visible (matched the search). */
  registerItem: (id: string, visible: boolean) => void
  unregisterItem: (id: string) => void
  /** Total number of mounted items (visible or not). */
  totalCount: number
  /** Number of currently visible (search-matched) items. */
  visibleCount: number
}
const CommandContext = createContext<CommandContextValue>({
  search: '',
  setSearch: () => {},
  selectedValue: '',
  setSelectedValue: () => {},
  registerItem: () => {},
  unregisterItem: () => {},
  totalCount: 0,
  visibleCount: 0,
})

// ─── Command (Root) ─────────────────────────────────────────
interface CommandProps extends HTMLAttributes<HTMLDivElement> {
  filter?: (value: string, search: string) => number
}

const Command = forwardRef<HTMLDivElement, CommandProps>(
  ({ className, children, ...props }, ref) => {
    const [search, setSearch] = useState('')
    const [selectedValue, setSelectedValue] = useState('')
    // Track item visibility so CommandEmpty knows whether any item is showing.
    // A Map keyed by the item's stable id → its current visibility.
    const [itemVisibility, setItemVisibility] = useState<Map<string, boolean>>(new Map())

    const registerItem = useCallback((id: string, visible: boolean) => {
      setItemVisibility((prev) => {
        if (prev.get(id) === visible) return prev
        const next = new Map(prev)
        next.set(id, visible)
        return next
      })
    }, [])

    const unregisterItem = useCallback((id: string) => {
      setItemVisibility((prev) => {
        if (!prev.has(id)) return prev
        const next = new Map(prev)
        next.delete(id)
        return next
      })
    }, [])

    const totalCount = itemVisibility.size
    const visibleCount = useMemo(() => {
      let count = 0
      for (const visible of itemVisibility.values()) if (visible) count++
      return count
    }, [itemVisibility])

    return (
      <CommandContext.Provider
        value={{
          search,
          setSearch,
          selectedValue,
          setSelectedValue,
          registerItem,
          unregisterItem,
          totalCount,
          visibleCount,
        }}
      >
        <div
          ref={ref}
          className={cn(
            'flex h-full w-full flex-col overflow-hidden rounded-lg bg-card text-popover-foreground',
            className,
          )}
          {...props}
        >
          {children}
        </div>
      </CommandContext.Provider>
    )
  },
)
Command.displayName = 'Command'

// ─── CommandInput ───────────────────────────────────────────
interface CommandInputProps extends Omit<InputHTMLAttributes<HTMLInputElement>, 'onChange'> {
  onValueChange?: (value: string) => void
}

const CommandInput = forwardRef<HTMLInputElement, CommandInputProps>(
  ({ className, onValueChange, ...props }, ref) => {
    const { search, setSearch } = useContext(CommandContext)

    const handleChange = useCallback(
      (e: React.ChangeEvent<HTMLInputElement>) => {
        setSearch(e.target.value)
        onValueChange?.(e.target.value)
      },
      [setSearch, onValueChange],
    )

    return (
      <div className="flex items-center border-b border-border px-3">
        <Search className="mr-2 h-4 w-4 shrink-0 opacity-50" />
        <input
          ref={ref}
          value={search}
          onChange={handleChange}
          className={cn(
            'flex h-10 w-full rounded-md bg-transparent py-3 text-sm outline-none placeholder:text-muted-foreground disabled:cursor-not-allowed disabled:opacity-50',
            className,
          )}
          {...props}
        />
      </div>
    )
  },
)
CommandInput.displayName = 'CommandInput'

// ─── CommandList ────────────────────────────────────────────
const CommandList = forwardRef<HTMLDivElement, HTMLAttributes<HTMLDivElement>>(
  ({ className, ...props }, ref) => (
    <div
      ref={ref}
      className={cn('max-h-[300px] overflow-y-auto overflow-x-hidden', className)}
      {...props}
    />
  ),
)
CommandList.displayName = 'CommandList'

// ─── CommandEmpty ───────────────────────────────────────────
const CommandEmpty = forwardRef<HTMLDivElement, HTMLAttributes<HTMLDivElement>>((props, ref) => {
  const { visibleCount } = useContext(CommandContext)
  // Render the empty state whenever no item is currently visible — whether the
  // list is genuinely empty from the start OR a search filtered everything out.
  // (We intentionally do NOT gate on totalCount: a Combobox with zero options
  // must still show its empty message. Items register in an effect, so at worst
  // there is a one-frame flash on a populated list before it hides.)
  if (visibleCount > 0) return null
  return <div ref={ref} className="py-6 text-center text-sm text-muted-foreground" {...props} />
})
CommandEmpty.displayName = 'CommandEmpty'

// ─── CommandGroup ───────────────────────────────────────────
interface CommandGroupProps extends HTMLAttributes<HTMLDivElement> {
  heading?: string
}

const CommandGroup = forwardRef<HTMLDivElement, CommandGroupProps>(
  ({ className, heading, children, ...props }, ref) => (
    <div ref={ref} className={cn('overflow-hidden p-1 text-foreground', className)} {...props}>
      {heading && (
        <div className="px-2 py-1.5 text-xs font-medium text-muted-foreground">{heading}</div>
      )}
      {children}
    </div>
  ),
)
CommandGroup.displayName = 'CommandGroup'

// ─── CommandItem ────────────────────────────────────────────
interface CommandItemProps extends Omit<HTMLAttributes<HTMLDivElement>, 'onSelect'> {
  value?: string
  onSelect?: (value: string) => void
  disabled?: boolean
}

const CommandItem = forwardRef<HTMLDivElement, CommandItemProps>(
  ({ className, value = '', onSelect, disabled, children, ...props }, ref) => {
    const { search, registerItem, unregisterItem } = useContext(CommandContext)
    const [isHovered, setIsHovered] = useState(false)
    const itemId = useId()

    // Basic filtering: if search is set, hide items that don't match
    const isVisible = useMemo(() => {
      if (!search) return true
      const text = value.toLowerCase()
      return text.includes(search.toLowerCase())
    }, [search, value])

    // Register visibility so CommandEmpty can decide whether to show. This runs
    // before the early-return below so a hidden item still counts toward the
    // total (letting CommandEmpty appear only when ALL items are filtered out).
    useEffect(() => {
      registerItem(itemId, isVisible)
      return () => unregisterItem(itemId)
    }, [itemId, isVisible, registerItem, unregisterItem])

    if (!isVisible) return null

    return (
      <div
        ref={ref}
        // biome-ignore lint/a11y/useSemanticElements: a native <option> only renders inside
        // <select>/<datalist> and cannot host the arbitrary JSX (icons, check marks, badges)
        // every CommandItem call site passes as children.
        role="option"
        tabIndex={disabled ? -1 : 0}
        aria-selected={isHovered}
        aria-disabled={disabled}
        data-selected={isHovered}
        data-disabled={disabled}
        onMouseEnter={() => setIsHovered(true)}
        onMouseLeave={() => setIsHovered(false)}
        onClick={() => {
          if (!disabled) onSelect?.(value)
        }}
        onKeyDown={(e) => {
          if (disabled) return
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault()
            onSelect?.(value)
          }
        }}
        className={cn(
          'relative flex cursor-default select-none items-center rounded-sm px-2 py-1.5 text-sm outline-none transition-colors',
          isHovered && 'bg-accent text-accent-foreground',
          disabled && 'pointer-events-none opacity-50',
          className,
        )}
        {...props}
      >
        {children}
      </div>
    )
  },
)
CommandItem.displayName = 'CommandItem'

export { Command, CommandInput, CommandList, CommandEmpty, CommandGroup, CommandItem }
