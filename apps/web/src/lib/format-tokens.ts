/** Abbreviate token counts with K/M/B suffixes; render missing values as an em dash. */
export function formatTokens(n: number | null | undefined): string {
  if (n == null) return '—'
  if (n < 1000) return String(n)
  const k = n / 1000
  if (k < 999.95) return `${k.toFixed(1)}K`
  const m = n / 1_000_000
  // Promote before toFixed(1) would render a misleading 1000.0M.
  if (m < 999.95) return `${m.toFixed(1)}M`
  return `${(n / 1_000_000_000).toFixed(1)}B`
}

export function sumTokenUsage(usage: {
  input?: number | null
  output?: number | null
  reasoning?: number | null
  cacheRead?: number | null
  cacheWrite?: number | null
}): number {
  return (
    (usage.input ?? 0) +
    (usage.output ?? 0) +
    (usage.reasoning ?? 0) +
    (usage.cacheRead ?? 0) +
    (usage.cacheWrite ?? 0)
  )
}
