import { useCallback, useSyncExternalStore } from 'react'
import { useCurrentUser, useUpdateOnboarding } from './use-auth'

/**
 * 新手引导（FTUE）状态。
 *
 * - `done` 完成/不再提示：**持久化到后端**（user.onboarding[guide]），跨设备一致；
 *   存为 JSON 便于以后扩展更多引导（按 guide id 区分）。
 * - `active` 引导进行中：本地（localStorage）+ **模块级共享 store**。是跨组件信号：仪表盘欢迎
 *   弹窗 start() 后，根部的 OnboardingTour 必须立刻看到 active=true。若用各自的 useState 则不共享，
 *   故用 useSyncExternalStore 让所有消费者订阅同一份状态。
 */
const ACTIVE_KEY = 'a2wave:onboarding:active'

function readActive(): boolean {
  try {
    return localStorage.getItem(ACTIVE_KEY) === '1'
  } catch {
    return false
  }
}

// ── 模块级共享 store（active 跨组件同步）──────────────────────────────
const activeListeners = new Set<() => void>()
let activeSnapshot = readActive()

function getActiveSnapshot(): boolean {
  return activeSnapshot
}

function subscribeActive(cb: () => void): () => void {
  activeListeners.add(cb)
  return () => {
    activeListeners.delete(cb)
  }
}

function writeActive(value: boolean): void {
  try {
    if (value) localStorage.setItem(ACTIVE_KEY, '1')
    else localStorage.removeItem(ACTIVE_KEY)
  } catch {
    // ignore (private mode / storage disabled)
  }
  if (activeSnapshot !== value) {
    activeSnapshot = value
    for (const cb of activeListeners) cb()
  }
}

export function useOnboarding(guide = 'newbie') {
  const { data: user, isLoading } = useCurrentUser()
  const updateOnboarding = useUpdateOnboarding()
  const active = useSyncExternalStore(subscribeActive, getActiveSnapshot, getActiveSnapshot)

  const status = user?.onboarding?.[guide]
  // done = 已完成或已选择不再提示；二者都不再自动提示。
  const done = status === 'completed' || status === 'dismissed'

  const setActive = useCallback((value: boolean) => writeActive(value), [])
  /** 开始（或重新开始）引导：仅置 active，不改后端完成态。 */
  const start = useCallback(() => writeActive(true), [])
  /** 暂停：关闭当前引导但不标记完成（下次仍会提示）。 */
  const pause = useCallback(() => writeActive(false), [])

  /** 走完引导：后端标记 completed，并结束 active。 */
  const complete = useCallback(() => {
    writeActive(false)
    updateOnboarding.mutate({ guide, status: 'completed' })
  }, [guide, updateOnboarding])

  /** 不再提示：后端标记 dismissed，并结束 active。 */
  const dismiss = useCallback(() => {
    writeActive(false)
    updateOnboarding.mutate({ guide, status: 'dismissed' })
  }, [guide, updateOnboarding])

  /** 重置：清除后端该引导状态（恢复未决定，便于重新触发/测试）。 */
  const reset = useCallback(() => {
    writeActive(false)
    updateOnboarding.mutate({ guide, status: 'reset' })
  }, [guide, updateOnboarding])

  return { done, status, active, isLoading, start, pause, complete, dismiss, reset, setActive }
}
