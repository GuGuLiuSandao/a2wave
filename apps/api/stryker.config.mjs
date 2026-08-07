// @ts-check
/**
 * Stryker mutation testing config.
 *
 * 范围聚焦在核心执行链路：
 *   - 引擎抽象 + 路由：base-engine、registry、prompt-builder、
 *     template-renderer、model-fallback、kb-sync
 *   - Agent 装配：agent-helpers（buildAgentConfig 是全平台 hot path）
 *   - 运行生命周期：run-lifecycle
 *   - Lifecycle Hook pipeline：emit + commands plugin / registry / def
 *     （Step 6 cutover 引入的执行生命周期；不放进来 mutation 会漏过 hook
 *      fan-out 和命令路由的逻辑变更）
 *   - 安全/凭据：auth、jwt-signer、auth-cookie
 *   - 数据导入导出：agent-export
 *
 * 故意排除：
 *   - 直接走 better-sqlite3 / 飞书 SDK / fs IO 的大文件，单 mutant 跑测试
 *     的代价不划算（feishu-service.ts 718 LF、agent-import.ts 的
 *     importAgentFromZip 等）
 *   - 与 process / setTimeout 强耦合的调度器
 *   - 纯 type / barrel re-export（pipeline/types.ts, pipeline/commands/index.ts,
 *     pipeline/commands/types.ts），没有运行时分支可 mutate
 *
 * Run from apps/api:
 *   pnpm test:mutation         # 全量增量跑
 *   pnpm test:mutation:smoke   # 单线程冒烟
 */
/** @type {import('@stryker-mutator/api/core').PartialStrykerOptions} */
export default {
  packageManager: 'pnpm',
  testRunner: 'vitest',
  // pnpm 的 hoisted node_modules 布局不会被 Stryker 自动扫到，要显式声明插件。
  plugins: ['@stryker-mutator/vitest-runner'],
  vitest: {
    // Use a Stryker-specific vitest config that runs with pool='forks' so the
    // few tests calling process.chdir() (uploads, jwks-publisher) still work.
    configFile: 'vitest.stryker.config.ts',
  },
  reporters: ['html', 'progress', 'clear-text'],
  htmlReporter: { fileName: 'reports/mutation/mutation.html' },
  mutate: [
    // --- engine 核心抽象 ---
    'src/engine/base-engine.ts',
    'src/engine/registry.ts',
    'src/engine/prompt-builder.ts',
    'src/engine/template-renderer.ts',
    'src/engine/model-fallback.ts',
    'src/engine/kb-sync.ts',
    // --- agent 装配（buildAgentConfig 是热路径）---
    'src/lib/agent-helpers.ts',
    'src/lib/agent-export.ts',
    // --- 运行生命周期 ---
    'src/lib/run-lifecycle.ts',
    // --- Lifecycle Hook pipeline (Step 6 cutover) ---
    'src/lib/pipeline/emit.ts',
    'src/lib/pipeline/commands/dispatch-plugin.ts',
    'src/lib/pipeline/commands/factory.ts',
    'src/lib/pipeline/commands/prefix-matcher.ts',
    'src/lib/pipeline/commands/defs/new.ts',
    // --- 安全 / 凭据 ---
    'src/lib/auth.ts',
    'src/lib/auth-cookie.ts',
    'src/lib/jwt-signer.ts',
    'src/lib/owner-filter.ts',
    '!**/__tests__/**',
  ],
  concurrency: 2,
  timeoutMS: 20000,
  thresholds: {
    high: 80,
    low: 60,
    break: null, // 起步阶段不 fail CI；摸到稳态后再设 break 阈值
  },
  // 加快冷启动：vitest 自带 TS 转译，不再额外做类型检查。
  checkers: [],
  // 增量模式：缓存上次结果，只重跑变化的文件。
  incremental: true,
  incrementalFile: 'reports/mutation/stryker-incremental.json',
  ignorePatterns: ['coverage', 'dist', 'data', 'reports', 'node_modules'],
  ignoreStatic: true,
}
