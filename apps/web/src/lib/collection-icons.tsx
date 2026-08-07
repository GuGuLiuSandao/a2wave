import {
  BarChart3,
  Bot,
  Brain,
  Building2,
  Drama,
  FileText,
  FlaskConical,
  Folder,
  Handshake,
  Lightbulb,
  type LucideIcon,
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

export type CollectionIconName =
  | 'bot'
  | 'brain'
  | 'lightbulb'
  | 'wrench'
  | 'target'
  | 'rocket'
  | 'chart'
  | 'file'
  | 'search'
  | 'shield'
  | 'zap'
  | 'waves'
  | 'palette'
  | 'monitor'
  | 'sparkles'
  | 'handshake'
  | 'package'
  | 'building'
  | 'flask'
  | 'drama'

export const DEFAULT_COLLECTION_ICON: CollectionIconName = 'package'

export const COLLECTION_ICON_OPTIONS: Array<{ name: CollectionIconName; icon: LucideIcon }> = [
  { name: 'bot', icon: Bot },
  { name: 'brain', icon: Brain },
  { name: 'lightbulb', icon: Lightbulb },
  { name: 'wrench', icon: Wrench },
  { name: 'target', icon: Target },
  { name: 'rocket', icon: Rocket },
  { name: 'chart', icon: BarChart3 },
  { name: 'file', icon: FileText },
  { name: 'search', icon: Search },
  { name: 'shield', icon: Shield },
  { name: 'zap', icon: Zap },
  { name: 'waves', icon: Waves },
  { name: 'palette', icon: Palette },
  { name: 'monitor', icon: Monitor },
  { name: 'sparkles', icon: Sparkles },
  { name: 'handshake', icon: Handshake },
  { name: 'package', icon: Package },
  { name: 'building', icon: Building2 },
  { name: 'flask', icon: FlaskConical },
  { name: 'drama', icon: Drama },
]

const ICON_MAP: Record<string, LucideIcon> = Object.fromEntries(
  COLLECTION_ICON_OPTIONS.map((o) => [o.name, o.icon]),
)

/** 解析任意存储值为合法的 lucide 图标组件。识别不出的（老数据 emoji / 自定义字符串）回退到 Folder。 */
export function resolveCollectionIcon(raw: string | null | undefined): LucideIcon {
  if (raw && ICON_MAP[raw]) return ICON_MAP[raw]
  // legacy emoji 或未知值：用 Folder 作为「集合」的语义兜底
  return Folder
}

interface IconProps {
  name: string | null | undefined
  className?: string
  'aria-hidden'?: boolean
}

export function CollectionIcon({ name, className, ...rest }: IconProps) {
  const Icon = resolveCollectionIcon(name)
  return <Icon className={className} aria-hidden={rest['aria-hidden'] ?? true} />
}
