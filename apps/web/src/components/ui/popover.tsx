import { cn } from '@/lib/utils'
import {
  type ReactElement,
  type ReactNode,
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
} from 'react'
import { createPortal } from 'react-dom'

// ─── Context ────────────────────────────────────────────────
interface PopoverContextValue {
  open: boolean
  setOpen: (v: boolean) => void
  triggerRef: React.RefObject<HTMLElement | null>
}
const PopoverContext = createContext<PopoverContextValue>({
  open: false,
  setOpen: () => {},
  triggerRef: { current: null },
})

// ─── Root ───────────────────────────────────────────────────
interface PopoverProps {
  open?: boolean
  onOpenChange?: (open: boolean) => void
  children: ReactNode
}

function Popover({ open: controlledOpen, onOpenChange, children }: PopoverProps) {
  const [internalOpen, setInternalOpen] = useState(false)
  const open = controlledOpen ?? internalOpen
  const setOpen = onOpenChange ?? setInternalOpen
  const triggerRef = useRef<HTMLElement | null>(null)

  return (
    <PopoverContext.Provider value={{ open, setOpen, triggerRef }}>
      {children}
    </PopoverContext.Provider>
  )
}

// ─── Trigger ────────────────────────────────────────────────
interface PopoverTriggerProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  asChild?: boolean
}

function PopoverTrigger({ children, asChild, ...props }: PopoverTriggerProps) {
  const { open, setOpen, triggerRef } = useContext(PopoverContext)
  const localRef = useRef<HTMLElement>(null)

  const handleRef = useCallback(
    (node: HTMLElement | null) => {
      ;(localRef as React.MutableRefObject<HTMLElement | null>).current = node
      ;(triggerRef as React.MutableRefObject<HTMLElement | null>).current = node
    },
    [triggerRef],
  )

  if (asChild && children && typeof children === 'object' && 'type' in children) {
    const child = children as ReactElement<Record<string, unknown>>
    return (
      <child.type
        {...(child.props as Record<string, unknown>)}
        ref={handleRef}
        onClick={(e: React.MouseEvent) => {
          setOpen(!open)
          if (typeof (child.props as Record<string, unknown>).onClick === 'function') {
            ;((child.props as Record<string, unknown>).onClick as (e: React.MouseEvent) => void)(e)
          }
        }}
        role="combobox"
        aria-expanded={open}
        data-state={open ? 'open' : 'closed'}
      />
    )
  }

  return (
    <button
      type="button"
      ref={handleRef as React.Ref<HTMLButtonElement>}
      onClick={() => setOpen(!open)}
      aria-expanded={open}
      {...props}
    >
      {children}
    </button>
  )
}

// ─── Content ────────────────────────────────────────────────
interface PopoverContentProps extends React.HTMLAttributes<HTMLDivElement> {
  align?: 'start' | 'center' | 'end'
  sideOffset?: number
  /**
   * Stacking order of the portaled content. Defaults to 50. Raise it (e.g.
   * ~1100) when the popover is opened from inside an antd Modal (z-index 1000),
   * otherwise the content renders behind the modal.
   */
  contentZIndex?: number
}

function PopoverContent({
  className,
  children,
  align = 'center',
  sideOffset = 4,
  contentZIndex = 50,
  ...props
}: PopoverContentProps) {
  const { open, setOpen, triggerRef } = useContext(PopoverContext)
  const contentRef = useRef<HTMLDivElement>(null)
  const [position, setPosition] = useState<{ top: number; left: number; width: number }>({
    top: 0,
    left: 0,
    width: 0,
  })

  // Position the popover relative to the trigger
  useEffect(() => {
    if (!open || !triggerRef.current) return
    const rect = triggerRef.current.getBoundingClientRect()
    let left = rect.left
    if (align === 'center') left = rect.left + rect.width / 2
    else if (align === 'end') left = rect.right

    setPosition({
      top: rect.bottom + sideOffset + window.scrollY,
      left: left + window.scrollX,
      width: rect.width,
    })
  }, [open, align, sideOffset, triggerRef])

  // Close on click-outside
  useEffect(() => {
    if (!open) return
    function handleClick(e: MouseEvent) {
      if (
        contentRef.current &&
        !contentRef.current.contains(e.target as Node) &&
        triggerRef.current &&
        !triggerRef.current.contains(e.target as Node)
      ) {
        setOpen(false)
      }
    }
    document.addEventListener('mousedown', handleClick)
    return () => document.removeEventListener('mousedown', handleClick)
  }, [open, setOpen, triggerRef])

  // Close on Escape
  useEffect(() => {
    if (!open) return
    function handleKey(e: KeyboardEvent) {
      if (e.key === 'Escape') setOpen(false)
    }
    document.addEventListener('keydown', handleKey)
    return () => document.removeEventListener('keydown', handleKey)
  }, [open, setOpen])

  if (!open) return null

  const transformOrigin = align === 'start' ? 'left' : align === 'end' ? 'right' : 'center'

  const style: React.CSSProperties = {
    position: 'absolute',
    top: position.top,
    left: position.left,
    minWidth: position.width,
    transform:
      align === 'center' ? 'translateX(-50%)' : align === 'end' ? 'translateX(-100%)' : undefined,
    transformOrigin: `top ${transformOrigin}`,
    zIndex: contentZIndex,
  }

  return createPortal(
    <div ref={contentRef} style={style}>
      <div
        className={cn(
          'w-full rounded-lg border border-border bg-card p-4 text-popover-foreground shadow-md animate-in fade-in-0 zoom-in-95',
          className,
        )}
        {...props}
      >
        {children}
      </div>
    </div>,
    document.body,
  )
}

export { Popover, PopoverTrigger, PopoverContent }
