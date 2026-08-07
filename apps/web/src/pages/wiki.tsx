import { MarkdownContent } from '@/components/markdown-content'
import { Button } from '@/components/ui/button'
import { getManualSections } from '@/lib/manual'
import { cn } from '@/lib/utils'
import { useQuery } from '@tanstack/react-query'
import { BookText, ChevronLeft, ChevronRight, History } from 'lucide-react'
import { useLayoutEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Link, Navigate, useParams } from 'react-router-dom'

/** 仅在使用手册页展示的「更新记录」入口：按钮 + 版本号。 */
function ChangelogLink() {
  const { t } = useTranslation()
  const { data: health } = useQuery<{ version?: string }>({
    queryKey: ['health'],
    queryFn: () => fetch('/api/health').then((r) => r.json()),
    staleTime: Number.POSITIVE_INFINITY,
  })
  return (
    <div className="flex shrink-0 items-center gap-2 pt-0.5">
      {health?.version && (
        <span className="hidden text-[11px] font-mono text-muted-foreground/40 select-none sm:inline">
          {health.version}
        </span>
      )}
      <Button
        variant="ghost"
        size="sm"
        className="h-7 gap-1.5 px-2 text-xs text-muted-foreground hover:text-foreground"
        asChild
      >
        <Link to="/changelog">
          <History className="h-3.5 w-3.5" aria-hidden="true" />
          {t('common.changelog')}
        </Link>
      </Button>
    </div>
  )
}

function PageHeader({ title, desc }: { title: string; desc: string }) {
  return (
    <div>
      <h2 className="text-2xl font-semibold tracking-tight text-foreground">{title}</h2>
      <p className="text-sm text-muted-foreground mt-1.5">{desc}</p>
    </div>
  )
}

export function WikiPage() {
  const { t, i18n } = useTranslation()
  const { slug } = useParams<{ slug: string }>()
  const sections = getManualSections(i18n.language)
  const articleRef = useRef<HTMLDivElement>(null)
  const [outline, setOutline] = useState<Array<{ id: string; text: string }>>([])
  // 当前展示的章节 slug（无 slug 时为第一章）；作为大纲重算依赖
  const activeSlug = sections.find((s) => s.slug === slug)?.slug ?? sections[0]?.slug

  // 「本页大纲」单一真相源：直接读渲染后 DOM 里的 h2[id]，不再单独实现一套 id 解析，
  // 从而彻底消除「解析规则与渲染漂移导致锚点失效」的隐患（含内联语法/setext/~~~ 围栏）。
  // biome-ignore lint/correctness/useExhaustiveDependencies: activeSlug 仅作章节切换触发，effect 体内只读渲染后 DOM
  useLayoutEffect(() => {
    const root = articleRef.current
    if (!root) {
      setOutline([])
      return
    }
    const items = Array.from(root.querySelectorAll<HTMLHeadingElement>('h2[id]')).map((h) => ({
      id: h.id,
      text: Array.from(h.childNodes)
        .filter((n) => !(n.nodeType === 1 && (n as HTMLElement).tagName === 'A'))
        .map((n) => n.textContent ?? '')
        .join('')
        .trim(),
    }))
    setOutline(items)
  }, [activeSlug])

  if (sections.length === 0) {
    return (
      <div className="space-y-6">
        <PageHeader title={t('wiki.title')} desc={t('wiki.desc')} />
        <div className="rounded-xl border border-border bg-card p-12 text-center shadow-sm">
          <BookText className="mx-auto h-8 w-8 text-muted-foreground/40" aria-hidden="true" />
          <p className="mt-3 text-sm text-muted-foreground">{t('wiki.empty')}</p>
        </div>
      </div>
    )
  }

  // 无 slug：直接展示第一章（URL 保持 /wiki，便于侧栏导航高亮与 E2E）。
  // 有 slug 但不存在：回退到 /wiki，丢弃无效深链。
  if (slug && !sections.some((section) => section.slug === slug)) {
    return <Navigate to="/wiki" replace />
  }
  const currentIndex = Math.max(
    0,
    sections.findIndex((section) => section.slug === slug),
  )
  const current = sections[currentIndex]
  const prev = sections[currentIndex - 1]
  const next = sections[currentIndex + 1]

  return (
    <div className="space-y-6">
      <div className="flex items-start justify-between gap-4">
        <PageHeader title={t('wiki.title')} desc={t('wiki.desc')} />
        <ChangelogLink />
      </div>
      <div className="flex items-start gap-6">
        <nav
          className="w-56 shrink-0 sticky top-0 max-h-[calc(100dvh-7rem)] overflow-y-auto pb-4"
          aria-label={t('wiki.tocTitle')}
        >
          <div className="px-3 mb-2 text-2xs font-medium uppercase tracking-wide text-muted-foreground/60">
            {t('wiki.tocTitle')}
          </div>
          <div className="space-y-0.5">
            {sections.map((section) => {
              const active = section.slug === current.slug
              return (
                <Link
                  key={section.slug}
                  to={`/wiki/${section.slug}`}
                  aria-current={active ? 'page' : undefined}
                  className={cn(
                    'block rounded-lg px-3 py-[7px] text-sm transition-colors duration-150',
                    active
                      ? 'bg-warm-100 font-semibold text-foreground'
                      : 'font-medium text-muted-foreground hover:bg-surface-hover hover:text-foreground',
                  )}
                >
                  {section.title}
                </Link>
              )
            })}
          </div>
        </nav>

        <div className="min-w-0 flex-1 space-y-4">
          <article
            key={current.slug}
            className="animate-fade-in rounded-xl border border-border bg-card shadow-sm"
          >
            <div className="px-8 py-7">
              <div ref={articleRef} className="mx-auto max-w-3xl">
                {outline.length >= 3 && (
                  <nav
                    className="mb-5 rounded-lg border border-border bg-warm-50/60 px-4 py-3"
                    aria-label={t('wiki.onThisPage')}
                  >
                    <div className="mb-1.5 text-2xs font-medium uppercase tracking-wide text-muted-foreground/60">
                      {t('wiki.onThisPage')}
                    </div>
                    <div className="flex flex-wrap gap-x-4 gap-y-1">
                      {outline.map((h) => (
                        <a
                          key={h.id}
                          href={`#${h.id}`}
                          className="text-xs text-muted-foreground transition-colors hover:text-interactive-foreground"
                        >
                          {h.text}
                        </a>
                      ))}
                    </div>
                  </nav>
                )}
                <MarkdownContent content={current.content} wiki />
              </div>
            </div>
          </article>

          {(prev || next) && (
            <nav className="flex items-stretch gap-3" aria-label={t('wiki.chapterNav')}>
              {prev ? (
                <Link
                  to={`/wiki/${prev.slug}`}
                  className="group flex flex-1 items-center gap-2 rounded-xl border border-border bg-card px-4 py-3 text-left transition-all hover:border-primary/40 hover:shadow-sm"
                >
                  <ChevronLeft className="h-4 w-4 shrink-0 text-muted-foreground/50 transition-colors group-hover:text-interactive-foreground" />
                  <span className="min-w-0">
                    <span className="block text-2xs uppercase tracking-wide text-muted-foreground/60">
                      {t('wiki.prev')}
                    </span>
                    <span className="block truncate text-sm font-medium text-foreground">
                      {prev.title}
                    </span>
                  </span>
                </Link>
              ) : (
                <span className="flex-1" />
              )}
              {next ? (
                <Link
                  to={`/wiki/${next.slug}`}
                  className="group flex flex-1 items-center justify-end gap-2 rounded-xl border border-border bg-card px-4 py-3 text-right transition-all hover:border-primary/40 hover:shadow-sm"
                >
                  <span className="min-w-0">
                    <span className="block text-2xs uppercase tracking-wide text-muted-foreground/60">
                      {t('wiki.next')}
                    </span>
                    <span className="block truncate text-sm font-medium text-foreground">
                      {next.title}
                    </span>
                  </span>
                  <ChevronRight className="h-4 w-4 shrink-0 text-muted-foreground/50 transition-colors group-hover:text-interactive-foreground" />
                </Link>
              ) : (
                <span className="flex-1" />
              )}
            </nav>
          )}
        </div>
      </div>
    </div>
  )
}
