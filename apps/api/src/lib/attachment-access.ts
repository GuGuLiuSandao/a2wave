/**
 * 附件取回鉴权（GET /api/attachments/:token 的 owner 绑定）。
 *
 * 允许取回的情形：
 *   1. 调用者是上传者本人（meta.uploaderId）——覆盖测试抽屉「自己传自己看历史」。
 *   2. 调用者是 admin。
 *   3. 调用者对「引用了该 token 的 run 所属 Agent」至少有 read 权限——覆盖共享 Agent 的
 *      成员（含 viewer）在历史里看别的成员传的图。
 * 否则拒绝（token 96-bit 不可猜是纵深防御，不是唯一屏障）。
 */
import { eq, inArray } from 'drizzle-orm'
import type { Context } from 'hono'
import { db } from '../db/client.js'
import { attachmentRefs, runs } from '../db/schema.js'
import { loadAgentWithPerm } from './agent-access.js'
import type { StagedAttachmentMeta } from './attachment-storage.js'
import { getCurrentUserId } from './owner-filter.js'

/**
 * 返回仍被非终态 run（pending/queued/running）引用的 token 集合。TTL sweeper 用它 pin 这些
 * token，避免排队超 TTL 的附件被提前删（token 还在、文件没了 → run 退化纯文本，review [P1]）。
 *
 * 两个来源都要看（缺一不可）：
 *   ① attachment_refs — 已 materialize 的 run（出队成功后才写此表）；
 *   ② runs.executionMetadata.attachments — **queued 阶段**的 token，此时 attachment_refs 还
 *      没写，只有排队 run 行里有。queued 恰恰是唯一需要 pin 的场景（等待可能超 TTL），漏了
 *      ② 会导致 pin 对 queued 完全失效——review [P1] 指出的正是这个断裂。
 * 从 executionMetadata 抽 token 不涉及授予读取权限（GET 鉴权仍走 attachment_refs），只用于 pin。
 */
export async function getPinnedAttachmentTokens(): Promise<Set<string>> {
  const pinned = new Set<string>()

  // ① 已 materialize：attachment_refs JOIN 未完成的 runs。
  const refRows = await db
    .select({ token: attachmentRefs.token })
    .from(attachmentRefs)
    .innerJoin(runs, eq(attachmentRefs.runId, runs.id))
    .where(inArray(runs.status, ['pending', 'queued', 'running']))
  for (const r of refRows) pinned.add(r.token)

  // ② queued（尚未 materialize）：从非终态 run 的 executionMetadata.attachments 抽 token。
  const metaRows = await db
    .select({ executionMetadata: runs.executionMetadata })
    .from(runs)
    .where(inArray(runs.status, ['pending', 'queued', 'running']))
  for (const row of metaRows) {
    for (const a of row.executionMetadata?.attachments ?? []) {
      if (typeof a.token === 'string' && a.token) pinned.add(a.token)
    }
  }

  return pinned
}

/**
 * 登记 token → runId 反查（供 GET 取回时成员鉴权按 token 精确查）。传入**实际解析用到的**
 * token 列表（由 materializeForRun 汇总，含 A2A uri→staging token）。同一 token 复用到多个
 * run 会各存一行（复合 PK），冲突忽略。空/无 token → no-op。
 */
export async function recordAttachmentRefs(
  runId: string,
  tokens: string[] | undefined,
): Promise<void> {
  if (!tokens || tokens.length === 0) return
  const unique = [...new Set(tokens.filter((t) => typeof t === 'string' && t.length > 0))]
  if (unique.length === 0) return
  await db
    .insert(attachmentRefs)
    .values(unique.map((token) => ({ token, runId })))
    .onConflictDoNothing()
}

/**
 * 判断当前调用者能否取回该 token 的附件。返回 true 放行，false 拒绝。
 * meta 由 resolveStagedAttachment 提供（含 uploaderId）。
 */
export async function canAccessAttachment(
  c: Context,
  token: string,
  meta: StagedAttachmentMeta,
): Promise<boolean> {
  const me = getCurrentUserId(c)
  const role = c.get('userRole' as never) as string | undefined

  // 1 + 2：上传者本人 / admin。
  if (role === 'admin') return true
  if (meta.uploaderId && meta.uploaderId === me) return true

  // 3：token 可能被多个 run 引用——只要调用者是**任一**引用 run 所属 Agent 的成员即放行。
  const refs = await db
    .select({ runId: attachmentRefs.runId })
    .from(attachmentRefs)
    .where(eq(attachmentRefs.token, token))
  if (refs.length === 0) return false

  for (const ref of refs) {
    const run = (
      await db
        .select({ agentId: runs.initiatorAgentId })
        .from(runs)
        .where(eq(runs.id, ref.runId))
        .limit(1)
    )[0]
    if (run?.agentId && (await loadAgentWithPerm(c, run.agentId)) !== null) return true
  }
  return false
}
