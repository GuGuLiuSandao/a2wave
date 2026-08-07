/**
 * CLI version utilities — comparison basis for Provider minimum-version
 * requirements (minVersion).
 *
 * Agent CLIs format `--version` output differently (e.g. `1.0.48`,
 * `trae-cli version 0.120.42`, `2.1.212 (Claude Code)`): first extract the
 * version token with extractVersionToken, then compare numeric segments with
 * isVersionAtLeast.
 */

/**
 * Extract the first version-shaped token from CLI output (e.g. `1.2` / `1.2.3`
 * / `2026.03.30`).
 *
 * A multi-segment token (`\d+(\.\d+)+`) is preferred. When none is present, a
 * single-segment major is accepted ONLY when it is clearly a version — either
 * `v`-prefixed (`v2`) or preceded by the word "version" (`trae version 2`) —
 * so a bare number in unrelated output (an exit code like `exit 137`, a count)
 * is not misread as a version and silently bypasses the minimum-version gate.
 */
export function extractVersionToken(raw: string): string | null {
  const multi = raw.match(/\d+(?:\.\d+)+/)
  if (multi) return multi[0]
  // Single-segment fallback: `v2`, or `... version 2 ...` (case-insensitive).
  const prefixed = raw.match(/\bv(\d+)\b/i) ?? raw.match(/\bversion\s+v?(\d+)\b/i)
  return prefixed ? prefixed[1] : null
}

/**
 * Version comparison: numeric comparison of `.`-separated segments, treating
 * missing segments as 0 (`1.0` equals `1.0.0`).
 * Returns null when either side lacks a valid version token (undecidable;
 * callers should treat this as "skip the check").
 */
export function isVersionAtLeast(version: string, minVersion: string): boolean | null {
  const v = extractVersionToken(version)
  const min = extractVersionToken(minVersion)
  if (!v || !min) return null
  const vParts = v.split('.').map(Number)
  const minParts = min.split('.').map(Number)
  const len = Math.max(vParts.length, minParts.length)
  for (let i = 0; i < len; i++) {
    const a = vParts[i] ?? 0
    const b = minParts[i] ?? 0
    if (a !== b) return a > b
  }
  return true
}
