/**
 * Latency benchmark for finishRunSuccess.
 *
 * Seeds the dev SQLite with synthetic agent + run + step rows per iteration so
 * finishRunSuccess hits the production code path end-to-end (UPDATE runSteps /
 * UPDATE runs / INSERT chatMessages / scanAndRegisterArtifacts loop).
 * Reports p50 / p95 / p99 per fixture as JSON to stdout. Used by Step 4b PR
 * description to lock the latency threshold for the await change.
 *
 * 跑法：
 *   cd apps/api
 *   NODE_ENV=development pnpm exec tsx scripts/bench-finish-run-success.ts
 *
 * 或 alias: pnpm bench:finish-run
 *
 * 环境变量：
 *   BENCH_ITERS  每个 fixture 跑多少轮（默认 30）
 *
 * 数据残留：bench 在 dev DB 留下 runs / runSteps / chatMessages 行（agentId 用
 * 唯一前缀以便 grep 清理）。生产 DB 千万别跑这个脚本。
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { performance } from 'node:perf_hooks'
import { db } from '../src/db/client.js'
import { agents, runSteps, runs } from '../src/db/schema.js'
import { createId } from '../src/lib/id.js'
import { finishRunSuccess } from '../src/lib/run-lifecycle.js'

interface Fixture {
  label: string
  artifactCount: number
  outputSize: 'small' | 'medium' | 'large'
}

const FIXTURES: Fixture[] = [
  { label: '0-artifacts-small', artifactCount: 0, outputSize: 'small' },
  { label: '3-artifacts-small', artifactCount: 3, outputSize: 'small' },
  { label: '10-artifacts-medium', artifactCount: 10, outputSize: 'medium' },
  { label: '50-artifacts-medium', artifactCount: 50, outputSize: 'medium' },
  { label: '100-artifacts-large', artifactCount: 100, outputSize: 'large' },
]

const SIZE_MAP = {
  small: 1024,
  medium: 16 * 1024,
  large: 256 * 1024,
} as const

/**
 * 一次性种一个 agent。`onConflictDoNothing` 让脚本可重入。
 * 其它必填字段在 schema 上都有 default，所以这里只填 id + name。
 */
function seedAgent(): { agentId: string } {
  const agentId = `agt_bench_${createId()}`
  db.insert(agents).values({ id: agentId, name: 'bench-finish-run' }).onConflictDoNothing().run()
  return { agentId }
}

/**
 * 每轮 fresh runs + runSteps 行，避免 stale-row UPDATE 测的是无变化的写。
 *
 * 注意 schema 名（schema.ts:420 / :501）：
 *   - runs.intent 是 notNull 无 default
 *   - runs 表上没有 agentId / taskId / startedAt 列；FK 字段叫 initiatorAgentId
 *   - runSteps.order 是 notNull 无 default
 *   - runSteps 没有 startedAt 列
 */
function seedRun(agentId: string): { taskId: string; runId: string; stepId: string } {
  const taskId = createId('tsk')
  const runId = createId('run')
  const stepId = createId('stp')
  db.insert(runs)
    .values({
      id: runId,
      intent: 'bench-finish-run-success',
      status: 'running',
      initiatorAgentId: agentId,
      triggerSource: 'api',
    })
    .run()
  db.insert(runSteps)
    .values({
      id: stepId,
      runId,
      agentId,
      order: 1,
      status: 'running',
    })
    .run()
  return { taskId, runId, stepId }
}

/** 在临时目录里造 N 个小文件，模拟 scanAndRegisterArtifacts 的工作量。 */
function setupWorkDir(artifactCount: number): string {
  const dir = mkdtempSync(join(tmpdir(), 'bench-frs-'))
  for (let i = 0; i < artifactCount; i += 1) {
    writeFileSync(join(dir, `artifact-${i}.bin`), Buffer.alloc(2 * 1024))
  }
  return dir
}

function pct(arr: number[], p: number): number {
  const sorted = [...arr].sort((a, b) => a - b)
  const idx = Math.floor((p / 100) * (sorted.length - 1))
  return sorted[idx] ?? 0
}

async function measure(
  fx: Fixture,
  iters: number,
  agentId: string,
): Promise<{ p50: number; p95: number; p99: number; n: number }> {
  const samples: number[] = []
  for (let i = 0; i < iters; i += 1) {
    const { taskId, runId, stepId } = seedRun(agentId)
    const workDir = setupWorkDir(fx.artifactCount)
    const output = 'x'.repeat(SIZE_MAP[fx.outputSize])
    const t0 = performance.now()
    try {
      await finishRunSuccess(
        {
          taskId,
          runId,
          stepId,
          agentId,
          startTime: Date.now(),
          workDir,
          logs: [],
          retries: [],
        },
        { success: true, output, chatId: 'c_bench' } as never,
      ).catch(() => undefined)
      samples.push(performance.now() - t0)
    } finally {
      // 不在 finally 外 rm：throw 路径也要清；不然 iters × FIXTURES.length 个 tmpdir
      // 会堆在 os.tmpdir()（artifacts 已被 scan & copy 进 a2wave 持久化目录，本地 dir 可丢）。
      rmSync(workDir, { recursive: true, force: true })
    }
  }
  return {
    p50: pct(samples, 50),
    p95: pct(samples, 95),
    p99: pct(samples, 99),
    n: samples.length,
  }
}

async function main(): Promise<void> {
  const iters = Number(process.env.BENCH_ITERS ?? '30')
  const { agentId } = seedAgent()
  const results: Array<{ label: string; p50: number; p95: number; p99: number; n: number }> = []
  // 顺序跑：并发种 SQLite 行在 WAL 模式下会触发 busy_timeout 重试，掺杂噪声。
  for (const fx of FIXTURES) {
    const r = await measure(fx, iters, agentId)
    results.push({ label: fx.label, ...r })
  }
  console.log(JSON.stringify({ iters, agentId, results }, null, 2))
}

if (import.meta.url === `file://${process.argv[1]}`) {
  void main()
}
