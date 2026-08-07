import { type SQL, eq } from 'drizzle-orm'
import type { SQLiteColumn } from 'drizzle-orm/sqlite-core'
import type { Context } from 'hono'

/**
 * 获取数据隔离过滤条件。
 * admin 返回 undefined（无过滤），普通用户按 userId 过滤。
 */
export function getOwnerFilter(c: Context, userIdColumn: SQLiteColumn): SQL<unknown> | undefined {
  const role = c.get('userRole' as never) as string
  if (role === 'admin') return undefined

  const userId = c.get('userId' as never) as string
  return eq(userIdColumn, userId)
}

/** 获取当前用户 ID */
export function getCurrentUserId(c: Context): string {
  return c.get('userId' as never) as string
}
