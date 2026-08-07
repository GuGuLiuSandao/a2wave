import { randomBytes } from 'node:crypto'

/** 生成前缀 ID，例如 agt_abc123... */
export function createId(prefix?: string): string {
  const id = randomBytes(12).toString('base64url')
  return prefix ? `${prefix}_${id}` : id
}
