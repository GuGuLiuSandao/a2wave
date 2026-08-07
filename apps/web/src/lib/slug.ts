/** 把标题文本转成可作为 DOM id / 锚点的 slug；保留中文，空白转连字符，去除标点。 */
export function slugify(text: string): string {
  return text
    .trim()
    .toLowerCase()
    .replace(/\s+/g, '-')
    .replace(/[^\p{L}\p{N}_-]/gu, '')
}

/**
 * 生成同一渲染范围内「唯一」的标题 id：首次出现用 slug，重复出现追加 -2 / -3 …。
 * 渲染器（h2/h3）与「本页大纲」必须用同一个计数器实例并以相同顺序喂入标题，
 * 才能保证锚点 id 一致。
 */
export function makeSlugCounter(): (text: string) => string {
  const counts = new Map<string, number>()
  return (text: string): string => {
    const base = slugify(text)
    const n = (counts.get(base) ?? 0) + 1
    counts.set(base, n)
    return n === 1 ? base : `${base}-${n}`
  }
}
