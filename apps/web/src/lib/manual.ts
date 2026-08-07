/**
 * 使用手册（Wiki）内容加载器。
 *
 * 章节正文是 `apps/web/src/content/manual/<lang>/NN-slug.md`，由 Vite 在构建时
 * 通过 `import.meta.glob('?raw')` 静态打包进前端 —— 不依赖后端 API，也不需要
 * 把 docs/ 打进运行镜像。文件名前缀 `NN` 决定排序，`slug` 作为路由 `/wiki/:slug`，
 * 标题取 Markdown 的首个 `# ` 一级标题。
 */

export interface ManualSection {
  slug: string
  order: number
  title: string
  content: string
}

const zhModules = import.meta.glob('../content/manual/zh/*.md', {
  query: '?raw',
  import: 'default',
  eager: true,
}) as Record<string, string>

const enModules = import.meta.glob('../content/manual/en/*.md', {
  query: '?raw',
  import: 'default',
  eager: true,
}) as Record<string, string>

function parseSections(modules: Record<string, string>): ManualSection[] {
  return Object.entries(modules)
    .map(([path, raw]) => {
      const fileName = path.split('/').pop()?.replace(/\.md$/, '') ?? ''
      const match = fileName.match(/^(\d+)-(.+)$/)
      // 缺 NN- 前缀的文件排到最后，避免意外顶替落地首章
      const order = match ? Number(match[1]) : Number.MAX_SAFE_INTEGER
      const slug = match ? match[2] : fileName
      const titleMatch = raw.match(/^#\s+(.+)$/m)
      const title = titleMatch?.[1]?.trim() ?? slug
      return { slug, order, title, content: raw }
    })
    .sort((a, b) => a.order - b.order)
}

const sectionsByLang: Record<string, ManualSection[]> = {
  zh: parseSections(zhModules),
  en: parseSections(enModules),
}

/** 返回指定语言的章节；该语言无内容时回退到中文。 */
export function getManualSections(lang: string): ManualSection[] {
  const list = sectionsByLang[lang]
  return list && list.length > 0 ? list : sectionsByLang.zh
}

export function getManualSection(lang: string, slug: string): ManualSection | undefined {
  return getManualSections(lang).find((section) => section.slug === slug)
}
