import { BrandMark } from '@/components/brand-mark'
import { OnboardingTour } from '@/components/onboarding/onboarding-tour'
import { UserMenu } from '@/components/user-menu'
import { useCurrentUser } from '@/hooks/use-auth'
import { useSettings } from '@/hooks/use-settings'
import { DEFAULT_BRAND_ICON_URL } from '@/lib/brand-presets'
import { cn } from '@/lib/utils'
import { Tooltip } from 'antd'
import {
  Activity,
  Blocks,
  BookOpen,
  Bot,
  Cable,
  FolderGit2,
  Home,
  PanelLeftClose,
  PanelLeftOpen,
  ScrollText,
  Settings,
  Users,
  Zap,
} from 'lucide-react'
import type { ReactNode } from 'react'
import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Link, useLocation } from 'react-router-dom'

const navGroups = [
  {
    items: [{ href: '/', labelKey: 'nav.dashboard', icon: Home }],
  },
  {
    items: [
      { href: '/agents', labelKey: 'nav.agents', icon: Bot },
      { href: '/providers', labelKey: 'nav.providers', icon: Blocks },
    ],
  },
  {
    items: [
      { href: '/mcp-servers', labelKey: 'nav.mcpServers', icon: Cable },
      { href: '/skills', labelKey: 'nav.skills', icon: Zap },
    ],
  },
  {
    items: [
      { href: '/scm-sources', labelKey: 'nav.scmSources', icon: FolderGit2 },
      { href: '/kb-documents', labelKey: 'nav.kbDocuments', icon: BookOpen },
    ],
  },
  {
    items: [{ href: '/runs', labelKey: 'nav.runs', icon: Activity }],
  },
]

/**
 * Pages reachable from the user menu rather than the sidebar. They still need a
 * nav label so the browser title resolves for them.
 */
const offNavItems = [{ href: '/wiki', labelKey: 'nav.wiki' }]

const adminNavGroup = {
  items: [
    { href: '/users', labelKey: 'nav.users', icon: Users },
    { href: '/audit-logs', labelKey: 'nav.auditLogs', icon: ScrollText },
    { href: '/settings', labelKey: 'nav.settings', icon: Settings },
  ],
}

/**
 * Resolve the nav labelKey of the page a path belongs to (used to compose the
 * browser title). Uses longest-prefix matching so detail pages (e.g. /agents/:id)
 * resolve to their section (Agents); returns null when no nav matches (public
 * pages / 404).
 */
function resolvePageLabelKey(pathname: string): string | null {
  const items = [...navGroups.flatMap((g) => g.items), ...adminNavGroup.items, ...offNavItems]
  let best: { labelKey: string; length: number } | null = null
  for (const item of items) {
    const matches = item.href === '/' ? pathname === '/' : pathname.startsWith(item.href)
    if (matches && (!best || item.href.length > best.length)) {
      best = { labelKey: item.labelKey, length: item.href.length }
    }
  }
  return best?.labelKey ?? null
}

const SIDEBAR_COLLAPSED_KEY = 'a2wave.sidebar.collapsed'
const SIDEBAR_WIDTH = { expanded: 220, collapsed: 64 } as const
const COMPACT_VIEWPORT_MAX_WIDTH = 639

/** Sidebar collapse state, persisted so the choice survives reloads. */
function useSidebarCollapsed() {
  const [collapsed, setCollapsed] = useState(
    () => localStorage.getItem(SIDEBAR_COLLAPSED_KEY) === '1',
  )

  useEffect(() => {
    localStorage.setItem(SIDEBAR_COLLAPSED_KEY, collapsed ? '1' : '0')
  }, [collapsed])

  return [collapsed, setCollapsed] as const
}

/**
 * Narrow screens always use the icon-only rail. This is deliberately separate
 * from the persisted desktop preference: visiting on mobile must not collapse
 * the next desktop session.
 */
function useCompactViewport() {
  const [compact, setCompact] = useState(
    () => typeof window !== 'undefined' && window.innerWidth <= COMPACT_VIEWPORT_MAX_WIDTH,
  )

  useEffect(() => {
    const update = () => setCompact(window.innerWidth <= COMPACT_VIEWPORT_MAX_WIDTH)
    window.addEventListener('resize', update)
    return () => window.removeEventListener('resize', update)
  }, [])

  return compact
}

function isEditableShortcutTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false
  const tagName = target.tagName
  return (
    target.isContentEditable ||
    tagName === 'INPUT' ||
    tagName === 'TEXTAREA' ||
    tagName === 'SELECT' ||
    !!target.closest('[contenteditable="true"], .cm-editor')
  )
}

export function Layout({ children }: { children: ReactNode }) {
  const { t } = useTranslation()
  const location = useLocation()
  const { data: user } = useCurrentUser()
  const { data: settings } = useSettings()
  const [collapsed, setCollapsed] = useSidebarCollapsed()
  const compactViewport = useCompactViewport()
  const sidebarCollapsed = compactViewport || collapsed

  const scrollRef = useRef<HTMLDivElement>(null)
  // 路由路径变化时把内容区滚回顶部（切换 wiki 章节/页面后不会停在上一页底部）；
  // 仅依赖 pathname，故 wiki 正文内的 #锚点跳转（只改 hash）不受影响。
  // biome-ignore lint/correctness/useExhaustiveDependencies: pathname 仅作路由变化触发器，刻意不在 effect 体内引用
  useEffect(() => {
    scrollRef.current?.scrollTo({ top: 0 })
  }, [location.pathname])

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (!event.metaKey || (event.key !== 'ArrowUp' && event.key !== 'ArrowDown')) return
      if (event.altKey || event.ctrlKey || event.shiftKey) return
      if (isEditableShortcutTarget(event.target)) return

      const scrollRoot = scrollRef.current
      if (!scrollRoot) return

      event.preventDefault()
      scrollRoot.scrollTo({
        top: event.key === 'ArrowUp' ? 0 : scrollRoot.scrollHeight,
        behavior: 'smooth',
      })
    }

    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [])

  const brandingSubtitle = settings?.branding?.subtitle
  const brandingFavicon = settings?.branding?.faviconUrl

  useEffect(() => {
    if (!brandingFavicon) return
    const link = document.querySelector<HTMLLinkElement>('link[rel="icon"]')
    if (!link) return
    // A persisted faviconUrl may point at a removed brand preset (older
    // installs stored /brand-icons/<preset>.svg). Probe the image first and
    // fall back to the default icon on error, so the browser tab never shows a
    // broken favicon after upgrade.
    const probe = new Image()
    probe.onload = () => {
      link.href = brandingFavicon
    }
    probe.onerror = () => {
      link.href = DEFAULT_BRAND_ICON_URL
    }
    probe.src = brandingFavicon
    return () => {
      probe.onload = null
      probe.onerror = null
    }
  }, [brandingFavicon])

  useEffect(() => {
    // Browser title: {current page} - {subtitle} - A2WAVE; pages that don't match a nav omit the page segment.
    const subtitle = brandingSubtitle || t('app.subtitle')
    const pageLabelKey = resolvePageLabelKey(location.pathname)
    const pageName = pageLabelKey ? t(pageLabelKey) : null
    document.title = [pageName, subtitle, t('app.name')].filter(Boolean).join(' - ')
  }, [brandingSubtitle, location.pathname, t])

  const allNavGroups = user?.role === 'admin' ? [...navGroups, adminNavGroup] : navGroups

  return (
    <div className="flex h-dvh w-full max-w-full overflow-hidden">
      <a
        href="#main-content"
        className="sr-only focus:not-sr-only focus:absolute focus:top-4 focus:left-4 focus:z-50 focus:rounded-md focus:bg-primary focus:px-4 focus:py-2 focus:text-primary-foreground"
      >
        {t('common.skipToContent')}
      </a>

      {/* Sidebar — fixed height, never scrolls */}
      <aside
        className="fixed inset-y-0 left-0 z-30 border-r border-sidebar-border bg-sidebar flex flex-col transition-[width] duration-200"
        style={{
          width: sidebarCollapsed ? SIDEBAR_WIDTH.collapsed : SIDEBAR_WIDTH.expanded,
        }}
      >
        {/* Brand + collapse toggle */}
        <div
          className={cn(
            'shrink-0 flex items-center py-4 border-b border-sidebar-border',
            sidebarCollapsed ? 'flex-col gap-2 px-2' : 'gap-2 px-4',
          )}
        >
          <Link to="/" className="flex items-center gap-2.5 min-w-0 flex-1" title={t('app.name')}>
            <BrandMark className="size-8" iconClassName="h-4 w-4" />
            {!sidebarCollapsed && (
              <div className="min-w-0">
                <h1 className="text-base font-semibold tracking-tight text-foreground truncate">
                  {t('app.name')}
                </h1>
                <p className="text-2xs text-muted-foreground/60 leading-none mt-0.5 tracking-wide uppercase truncate">
                  {brandingSubtitle || t('app.subtitle')}
                </p>
              </div>
            )}
          </Link>
          {!compactViewport && (
            <Tooltip
              title={collapsed ? t('common.expandSidebar') : t('common.collapseSidebar')}
              placement="right"
            >
              <button
                type="button"
                onClick={() => setCollapsed(!collapsed)}
                aria-label={collapsed ? t('common.expandSidebar') : t('common.collapseSidebar')}
                aria-expanded={!collapsed}
                className="shrink-0 flex size-7 items-center justify-center rounded-lg text-muted-foreground hover:bg-surface-hover hover:text-foreground transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                {collapsed ? (
                  <PanelLeftOpen className="h-4 w-4" aria-hidden="true" />
                ) : (
                  <PanelLeftClose className="h-4 w-4" aria-hidden="true" />
                )}
              </button>
            </Tooltip>
          )}
        </div>

        {/* Navigation */}
        <nav
          className={cn(
            'flex-1 min-h-0 overflow-y-auto py-3',
            sidebarCollapsed ? 'px-2' : 'px-2.5',
          )}
          aria-label={t('common.mainNav')}
        >
          {allNavGroups.map((group, gi) => (
            <div key={group.items[0]?.href ?? `group-${gi}`}>
              {gi > 0 && (
                <div className={cn('h-px bg-border my-2', sidebarCollapsed ? 'mx-2' : 'mx-3')} />
              )}
              <div className="space-y-0.5">
                {group.items.map((item) => {
                  const isActive =
                    item.href === '/'
                      ? location.pathname === '/'
                      : location.pathname.startsWith(item.href)
                  const label = t(item.labelKey)
                  const link = (
                    <Link
                      key={item.href}
                      to={item.href}
                      data-tour={item.href === '/agents' ? 'nav-agents' : undefined}
                      aria-label={sidebarCollapsed ? label : undefined}
                      className={cn(
                        'flex items-center rounded-lg border py-[7px] text-sm font-medium transition-all duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                        sidebarCollapsed ? 'justify-center px-0' : 'gap-2.5 px-3',
                        isActive
                          ? 'border-sidebar-active-border bg-sidebar-active-background text-sidebar-active-foreground shadow-xs'
                          : 'border-transparent text-sidebar-foreground hover:bg-sidebar-muted hover:text-sidebar-foreground-hover',
                      )}
                    >
                      <item.icon className="h-[15px] w-[15px] shrink-0" aria-hidden="true" />
                      {!sidebarCollapsed && label}
                    </Link>
                  )
                  return sidebarCollapsed ? (
                    <Tooltip key={item.href} title={label} placement="right">
                      {link}
                    </Tooltip>
                  ) : (
                    link
                  )
                })}
              </div>
            </div>
          ))}
        </nav>

        {/* Footer — User menu */}
        <div
          className={cn(
            'shrink-0 py-2.5 border-t border-sidebar-border',
            sidebarCollapsed ? 'px-2' : 'px-2.5',
          )}
        >
          <UserMenu collapsed={sidebarCollapsed} />
        </div>
      </aside>

      {/* Main content — offset by sidebar width */}
      <main
        id="main-content"
        className="flex-1 min-h-0 min-w-0 flex flex-col overflow-hidden bg-background transition-[margin] duration-200"
        style={{
          marginLeft: sidebarCollapsed ? SIDEBAR_WIDTH.collapsed : SIDEBAR_WIDTH.expanded,
        }}
      >
        <div ref={scrollRef} className="flex-1 min-h-0 overflow-auto">
          <div className="w-full max-w-content mx-auto flex flex-col px-4 py-5 sm:px-6 sm:py-6 lg:px-10 lg:py-8 animate-fade-in">
            {children}
          </div>
        </div>
      </main>

      {/* 新手引导（FTUE）总编排器：单实例、跨路由常挂、按应用状态推导步骤 */}
      <OnboardingTour />
    </div>
  )
}
