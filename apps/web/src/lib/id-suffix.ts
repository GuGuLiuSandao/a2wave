/**
 * 取 id 中第一个 '_' 之后的完整随机段，作为显示后缀。
 *
 * 后端 `defaultWorkspacesPath`（apps/api/src/lib/git-workspace.ts）也用同样的算法：
 * `createId` 基于 base64url，其字母表含 '_'，因此 `split('_').pop()` 会丢失前段熵，
 * 导致两个不同 id 渲染出相同的默认路径占位符。
 */
export function idSuffix(id: string | null | undefined): string {
  if (!id) return ''
  const i = id.indexOf('_')
  return i >= 0 ? id.slice(i + 1) || id : id
}
