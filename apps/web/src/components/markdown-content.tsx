import { makeSlugCounter } from '@/lib/slug'
import { AlertTriangle, Info, Lightbulb, ShieldAlert, Star } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import ReactMarkdown from 'react-markdown'
import { Link } from 'react-router-dom'
import remarkGfm from 'remark-gfm'

interface MarkdownContentProps {
  content: string
  className?: string
  /**
   * 仅 wiki 使用手册启用增强渲染：站内链接原地跳转(SPA Link)、提示卡片(callout)、标题锚点。
   * 默认 false —— 其余复用点(changelog / run·test 抽屉的 agent 输出)保持普通 `<a target=_blank>`、
   * 不渲染 callout/锚点，避免 agent 输出里的内部链接把用户原地带离页面。
   */
  wiki?: boolean
}

type MdNode = {
  type: string
  value?: string
  depth?: number
  children?: MdNode[]
  data?: Record<string, unknown>
}

// ── GFM 风格提示卡片（callout）：把 `> [!NOTE]` 形式的 blockquote 转成带样式的 div ──
const CALLOUT_RE = /^\[!(note|tip|important|warning|caution)\]/i

function remarkCallout() {
  return (tree: MdNode) => {
    for (const node of tree.children ?? []) {
      if (node.type !== 'blockquote') continue
      const para = node.children?.[0]
      if (!para || para.type !== 'paragraph') continue
      const textNode = para.children?.[0]
      if (!textNode || textNode.type !== 'text' || !textNode.value) continue
      const match = textNode.value.match(CALLOUT_RE)
      if (!match) continue
      const kind = match[1].toLowerCase()
      textNode.value = textNode.value.slice(match[0].length).replace(/^[^\S\n]*\n?/, '')
      if (textNode.value === '') {
        para.children?.shift()
        if (para.children?.[0]?.type === 'break') para.children.shift()
      }
      if (para.children && para.children.length === 0) node.children?.shift()
      node.data = {
        ...(node.data ?? {}),
        hName: 'div',
        hProperties: { className: `md-callout md-callout-${kind}` },
      }
    }
  }
}

// 递归取节点纯文本（含 inlineCode），用于生成标题 slug
function mdastText(node: MdNode): string {
  if (typeof node.value === 'string') return node.value
  return (node.children ?? []).map(mdastText).join('')
}

// ── 给 h2/h3 在 AST 层分配唯一 id（在解析阶段去重，避免在 React 渲染期改可变状态）──
// 这是标题 id 的唯一来源；wiki「本页大纲」直接读渲染后 DOM 的 h2[id]，不再另解析，避免漂移。
function remarkHeadingIds() {
  return (tree: MdNode) => {
    const nextId = makeSlugCounter()
    for (const node of tree.children ?? []) {
      if (node.type !== 'heading' || (node.depth !== 2 && node.depth !== 3)) continue
      const id = nextId(mdastText(node))
      const data = (node.data ?? {}) as { hProperties?: Record<string, unknown> }
      node.data = { ...data, hProperties: { ...(data.hProperties ?? {}), id } }
    }
  }
}

const CALLOUTS: Record<
  string,
  { box: string; icon: typeof Info; iconColor: string; labelKey: string }
> = {
  note: {
    box: 'border-primary/25 bg-primary-subtle/60',
    icon: Info,
    iconColor: 'text-interactive-foreground',
    labelKey: 'wiki.calloutNote',
  },
  tip: {
    box: 'border-success/25 bg-success-subtle',
    icon: Lightbulb,
    iconColor: 'text-success',
    labelKey: 'wiki.calloutTip',
  },
  important: {
    box: 'border-primary/20 bg-primary/[0.06]',
    icon: Star,
    iconColor: 'text-interactive-foreground',
    labelKey: 'wiki.calloutImportant',
  },
  warning: {
    box: 'border-warning/30 bg-warning-subtle',
    icon: AlertTriangle,
    iconColor: 'text-warning',
    labelKey: 'wiki.calloutWarning',
  },
  caution: {
    box: 'border-destructive/30 bg-destructive-subtle',
    icon: ShieldAlert,
    iconColor: 'text-destructive',
    labelKey: 'wiki.calloutCaution',
  },
}

function HeadingAnchor({ id }: { id: string }) {
  const { t } = useTranslation()
  return (
    <a
      href={`#${id}`}
      aria-label={t('wiki.headingAnchor')}
      tabIndex={-1}
      className="ml-1.5 text-muted-foreground/30 no-underline opacity-0 transition-opacity hover:text-interactive-foreground group-hover:opacity-100"
    >
      #
    </a>
  )
}

export function MarkdownContent({ content, className = '', wiki = false }: MarkdownContentProps) {
  const { t } = useTranslation()
  // wiki=true 才启用 callout / 标题锚点插件；其余复用点仅用 GFM，保持原始渲染。
  const remarkPlugins = wiki ? [remarkGfm, remarkCallout, remarkHeadingIds] : [remarkGfm]
  return (
    <div className={`markdown-body text-sm break-words ${className}`}>
      <ReactMarkdown
        remarkPlugins={remarkPlugins}
        components={{
          h1: ({ children }) => (
            <h1 className="text-lg font-bold mt-4 mb-2 first:mt-0">{children}</h1>
          ),
          h2: ({ children, id }) =>
            wiki ? (
              <h2 id={id} className="group scroll-mt-4 text-base font-bold mt-5 mb-2">
                {children}
                {id && <HeadingAnchor id={id} />}
              </h2>
            ) : (
              <h2 className="text-base font-bold mt-3 mb-1.5">{children}</h2>
            ),
          h3: ({ children, id }) =>
            wiki ? (
              <h3 id={id} className="group scroll-mt-4 text-sm font-bold mt-3 mb-1">
                {children}
                {id && <HeadingAnchor id={id} />}
              </h3>
            ) : (
              <h3 className="text-sm font-bold mt-2.5 mb-1">{children}</h3>
            ),
          p: ({ children }) => <p className="mb-2 last:mb-0 leading-relaxed">{children}</p>,
          ul: ({ children }) => <ul className="list-disc pl-5 mb-2 space-y-0.5">{children}</ul>,
          ol: ({ children }) => <ol className="list-decimal pl-5 mb-2 space-y-0.5">{children}</ol>,
          li: ({ children }) => <li className="leading-relaxed">{children}</li>,
          code: ({ className: codeClassName, children, ...props }) => {
            const isInline = !codeClassName
            if (isInline) {
              return (
                <code
                  className="border border-code-border bg-code-background px-1 py-0.5 rounded text-code-foreground text-[0.85em] font-mono"
                  {...props}
                >
                  {children}
                </code>
              )
            }
            return (
              <code
                className={`block border border-code-border bg-code-background p-3 rounded-lg text-code-foreground text-[0.85em] font-mono overflow-x-auto my-2 ${codeClassName ?? ''}`}
                {...props}
              >
                {children}
              </code>
            )
          },
          pre: ({ children }) => <pre className="my-2 overflow-x-auto">{children}</pre>,
          table: ({ children }) => (
            <div className="overflow-x-auto my-2 rounded-lg border border-border">
              <table className="min-w-full text-xs border-collapse">{children}</table>
            </div>
          ),
          thead: ({ children }) => <thead className="bg-muted/50">{children}</thead>,
          th: ({ children }) => (
            <th className="border-b border-border px-2.5 py-1.5 text-left font-semibold">
              {children}
            </th>
          ),
          td: ({ children }) => (
            <td className="border-b border-border/60 px-2.5 py-1.5 align-top">{children}</td>
          ),
          blockquote: ({ children }) => (
            <blockquote className="border-l-2 border-primary/30 pl-3 my-2 text-muted-foreground italic">
              {children}
            </blockquote>
          ),
          strong: ({ children }) => <strong className="font-semibold">{children}</strong>,
          a: ({ href, children }) => {
            const linkClass =
              'text-interactive-foreground underline underline-offset-2 hover:decoration-2'
            // 仅 wiki：站内 SPA 路由（/ 开头、非 /api/）走 Link 原地跳转。其余复用点
            // （changelog / agent 输出）一律普通 <a target=_blank>，避免 agent 输出里的
            // /logout、/users 等把正在看 run 的用户原地带离页面；/api/* 也不劫持成 404。
            if (
              wiki &&
              typeof href === 'string' &&
              href.startsWith('/') &&
              !href.startsWith('/api/')
            ) {
              return (
                <Link to={href} className={linkClass}>
                  {children}
                </Link>
              )
            }
            return (
              <a href={href} target="_blank" rel="noopener noreferrer" className={linkClass}>
                {children}
              </a>
            )
          },
          hr: () => <hr className="my-3 border-border" />,
          div: ({ className: divClass, children }) => {
            const cls = Array.isArray(divClass) ? divClass.join(' ') : (divClass ?? '')
            const match = cls.match(/md-callout-(\w+)/)
            if (!match) return <div className={divClass}>{children}</div>
            const c = CALLOUTS[match[1]] ?? CALLOUTS.note
            const Icon = c.icon
            return (
              <div className={`my-3 rounded-lg border px-4 py-3 ${c.box}`}>
                <div
                  className={`mb-1 flex items-center gap-1.5 text-xs font-semibold ${c.iconColor}`}
                >
                  <Icon className="h-3.5 w-3.5" aria-hidden="true" />
                  {t(c.labelKey)}
                </div>
                <div className="text-foreground/90 [&_p]:mb-1 [&_p:last-child]:mb-0">
                  {children}
                </div>
              </div>
            )
          },
        }}
      >
        {content}
      </ReactMarkdown>
    </div>
  )
}
