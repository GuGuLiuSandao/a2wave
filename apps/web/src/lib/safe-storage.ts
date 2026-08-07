/**
 * localStorage 写入兜底：配额超限（QuotaExceededError）或隐私模式 / 存储被禁用时，
 * setItem 会抛异常。这些写入多发生在 interval / beforeunload / cleanup 等回调里，
 * 未捕获会让回调（乃至页面卸载流程）中断。草稿丢一次无伤大雅，故吞掉异常即可。
 */
export function safeSetItem(key: string, value: string): void {
  try {
    localStorage.setItem(key, value)
  } catch {
    // ignore: quota exceeded / storage disabled (private mode)
  }
}
