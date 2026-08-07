import { cn } from '@/lib/utils'
import {
  BarChart3,
  Bot,
  Brain,
  Building2,
  Drama,
  FileText,
  FlaskConical,
  Handshake,
  Lightbulb,
  type LucideProps,
  Monitor,
  Package,
  Palette,
  Rocket,
  Search,
  Shield,
  Sparkles,
  Target,
  Waves,
  Wrench,
  Zap,
} from 'lucide-react'
import { type ComponentType, useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { useTranslation } from 'react-i18next'

const EMOJI_LIST = [
  '🤖',
  '🧠',
  '💡',
  '🔧',
  '🎯',
  '🚀',
  '📊',
  '📝',
  '🔍',
  '🛡️',
  '⚡',
  '🌊',
  '🎨',
  '💻',
  '🔮',
  '🤝',
  '📦',
  '🏗️',
  '🧪',
  '🎭',
]

// Icon map for lucide-react icons
const ICON_MAP: Record<string, ComponentType<LucideProps>> = {
  Bot,
  Brain,
  Lightbulb,
  Wrench,
  Target,
  Rocket,
  BarChart3,
  FileText,
  Search,
  Shield,
  Zap,
  Waves,
  Palette,
  Monitor,
  Sparkles,
  Handshake,
  Package,
  Building2,
  FlaskConical,
  Drama,
}

const ICON_LIST = Object.keys(ICON_MAP)

type TabType = 'emoji' | 'icon'

interface EmojiPickerProps {
  value?: string
  onChange?: (value: string) => void
  className?: string
}

/**
 * Renders the icon/emoji display based on value format.
 * - Starts with "icon:" → lucide-react icon
 * - Otherwise → emoji string
 */
function IconDisplay({ value, size = 'md' }: { value: string; size?: 'sm' | 'md' | 'lg' }) {
  const sizeClasses = {
    sm: 'h-4 w-4',
    md: 'h-5 w-5',
    lg: 'h-6 w-6',
  }

  if (value.startsWith('icon:')) {
    const iconName = value.slice(5)
    const IconComponent = ICON_MAP[iconName]
    if (IconComponent) {
      return <IconComponent className={cn(sizeClasses[size], 'text-foreground')} />
    }
    // Fallback to default icon
    return <Bot className={cn(sizeClasses[size], 'text-foreground')} />
  }

  // It's an emoji
  return (
    <span className={size === 'sm' ? 'text-base' : size === 'lg' ? 'text-xl' : 'text-lg'}>
      {value}
    </span>
  )
}

function EmojiPicker({ value = '🤖', onChange, className }: EmojiPickerProps) {
  const { t } = useTranslation()
  const [isOpen, setIsOpen] = useState(false)
  const [activeTab, setActiveTab] = useState<TabType>(() => {
    // Initialize tab based on current value
    return value.startsWith('icon:') ? 'icon' : 'emoji'
  })
  const [position, setPosition] = useState({ top: 0, left: 0 })
  const buttonRef = useRef<HTMLButtonElement>(null)
  const popoverRef = useRef<HTMLDivElement>(null)

  // Handle click outside
  useEffect(() => {
    if (!isOpen) return

    function handleClickOutside(event: MouseEvent) {
      const target = event.target as Node
      if (
        popoverRef.current &&
        !popoverRef.current.contains(target) &&
        buttonRef.current &&
        !buttonRef.current.contains(target)
      ) {
        setIsOpen(false)
      }
    }

    function handleEscape(event: KeyboardEvent) {
      if (event.key === 'Escape') {
        setIsOpen(false)
        buttonRef.current?.focus()
      }
    }

    document.addEventListener('mousedown', handleClickOutside)
    document.addEventListener('keydown', handleEscape)

    return () => {
      document.removeEventListener('mousedown', handleClickOutside)
      document.removeEventListener('keydown', handleEscape)
    }
  }, [isOpen])

  function handleSelect(newValue: string) {
    onChange?.(newValue)
    setIsOpen(false)
    buttonRef.current?.focus()
  }

  function handleToggle() {
    if (!isOpen && buttonRef.current) {
      // 同步计算位置，在打开前就设置好，避免闪烁
      const rect = buttonRef.current.getBoundingClientRect()
      setPosition({
        top: rect.bottom + 8,
        left: rect.left,
      })
    }
    setIsOpen(!isOpen)
  }

  function handleKeyDown(event: React.KeyboardEvent) {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault()
      handleToggle()
    } else if (event.key === 'Escape' && isOpen) {
      setIsOpen(false)
    }
  }

  // Check if current value matches an item
  const isSelected = useMemo(() => {
    return (itemValue: string) => value === itemValue
  }, [value])

  const popoverContent = (
    <div
      ref={popoverRef}
      // biome-ignore lint/a11y/useSemanticElements: a native <dialog> only becomes visible via
      // show()/showModal() and renders in the top layer with its own backdrop, which would break
      // this fixed-position popover's manual anchoring and click-outside handling.
      role="dialog"
      aria-label={t('common.emojiPicker.title')}
      style={{
        position: 'fixed',
        top: position.top,
        left: position.left,
        zIndex: 9999,
      }}
      className="w-72 rounded-lg border border-border bg-card p-3 shadow-lg animate-in fade-in-0 zoom-in-95"
      onKeyDown={(e) => {
        if (e.key === 'Escape') {
          setIsOpen(false)
          buttonRef.current?.focus()
        }
      }}
    >
      {/* Tabs */}
      <div className="flex gap-1 mb-3 p-1 rounded-md bg-muted" role="tablist">
        <button
          type="button"
          role="tab"
          aria-selected={activeTab === 'emoji'}
          onClick={() => setActiveTab('emoji')}
          className={cn(
            'flex-1 px-3 py-1.5 text-xs font-medium rounded-md transition-colors',
            activeTab === 'emoji'
              ? 'bg-background text-foreground shadow-sm'
              : 'text-muted-foreground hover:text-foreground',
          )}
        >
          {t('common.emojiPicker.emojiTab')}
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={activeTab === 'icon'}
          onClick={() => setActiveTab('icon')}
          className={cn(
            'flex-1 px-3 py-1.5 text-xs font-medium rounded-md transition-colors',
            activeTab === 'icon'
              ? 'bg-background text-foreground shadow-sm'
              : 'text-muted-foreground hover:text-foreground',
          )}
        >
          {t('common.emojiPicker.iconTab')}
        </button>
      </div>

      {/* Content */}
      <div className="grid grid-cols-5 gap-1.5" role="tabpanel">
        {activeTab === 'emoji'
          ? EMOJI_LIST.map((emoji) => (
              <button
                key={emoji}
                type="button"
                onClick={() => handleSelect(emoji)}
                className={cn(
                  'flex h-10 w-10 items-center justify-center rounded-md text-lg transition-colors hover:bg-surface-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                  isSelected(emoji) && 'bg-primary/10 ring-2 ring-primary',
                )}
                aria-label={t('common.emojiPicker.selectEmoji', { emoji })}
              >
                {emoji}
              </button>
            ))
          : ICON_LIST.map((iconName) => {
              const IconComponent = ICON_MAP[iconName]
              const iconValue = `icon:${iconName}`
              return (
                <button
                  key={iconName}
                  type="button"
                  onClick={() => handleSelect(iconValue)}
                  className={cn(
                    'flex h-10 w-10 items-center justify-center rounded-md transition-colors hover:bg-surface-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                    isSelected(iconValue) && 'bg-primary/10 ring-2 ring-primary',
                  )}
                  aria-label={t('common.emojiPicker.selectIcon', { icon: iconName })}
                  title={iconName}
                >
                  <IconComponent className="h-5 w-5 text-foreground" />
                </button>
              )
            })}
      </div>
    </div>
  )

  return (
    <div className={cn('inline-block', className)}>
      <button
        ref={buttonRef}
        type="button"
        onClick={handleToggle}
        onKeyDown={handleKeyDown}
        aria-label={t('common.emojiPicker.title')}
        aria-expanded={isOpen}
        aria-haspopup="true"
        className={cn(
          'flex size-14 items-center justify-center rounded-2xl border border-input bg-muted/50 transition-colors hover:bg-surface-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background',
        )}
      >
        <IconDisplay value={value} size="lg" />
      </button>

      {isOpen && createPortal(popoverContent, document.body)}
    </div>
  )
}

export { EmojiPicker, IconDisplay }
