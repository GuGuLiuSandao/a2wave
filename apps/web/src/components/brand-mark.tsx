import { useSettings } from '@/hooks/use-settings'
import { cn } from '@/lib/utils'
import { Waves } from 'lucide-react'
import { useState } from 'react'

interface BrandMarkProps {
  /** Tailwind size classes for the outer square, e.g. "size-8" */
  className?: string
  /** Tailwind size classes for the fallback Waves glyph, e.g. "h-4 w-4" */
  iconClassName?: string
}

export function BrandMarkFallback({ className, iconClassName }: BrandMarkProps) {
  return (
    <div
      data-testid="brand-mark-fallback"
      className={cn(
        'flex items-center justify-center rounded-lg bg-brand-gradient text-primary-foreground shadow-sm shrink-0',
        className,
      )}
    >
      <Waves className={iconClassName} aria-hidden="true" />
    </div>
  )
}

/**
 * 品牌 mark（左上角标题图标）。
 * 渲染 branding.faviconUrl（系统默认即 /brand-icons/default.svg — 原始波浪+紫渐变），
 * 与浏览器标签页保持一致；仅当 settings 尚未加载（faviconUrl 为空）时，
 * 回退到品牌渐变方块 + Waves 作为占位，避免首屏闪烁。
 *
 * 旧版本曾提供一批预设品牌图标，其公开路径（如 /brand-icons/aurora.svg）会被
 * 持久化到 settings.branding.faviconUrl；这些资源现已删除。若图片加载失败
 * （存量配置指向已删除的预设），同样回退到渐变占位而不是显示 broken image。
 */
export function BrandMark({ className, iconClassName }: BrandMarkProps) {
  const { data: settings } = useSettings()
  const favicon = settings?.branding?.faviconUrl
  // Track the *URL* that failed rather than a boolean, so switching to a
  // different (valid) icon re-attempts the load instead of staying stuck on the
  // fallback — no reset effect needed.
  const [brokenUrl, setBrokenUrl] = useState<string | undefined>(undefined)

  if (favicon && favicon !== brokenUrl) {
    return (
      <div
        className={cn(
          'flex items-center justify-center rounded-lg overflow-hidden shrink-0',
          className,
        )}
      >
        <img
          src={favicon}
          alt=""
          className="h-full w-full object-contain"
          onError={() => setBrokenUrl(favicon)}
        />
      </div>
    )
  }

  return <BrandMarkFallback className={className} iconClassName={iconClassName} />
}
