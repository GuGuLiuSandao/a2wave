/**
 * In-process keyed async mutex.
 *
 * a2wave deploys as a single process against a single SQLite file with no external
 * coordinator, so serialising concurrent writes to one resource with an in-process
 * lock is enough. Each key holds a promise chain: a new task waits for the previous
 * one to settle, so critical sections under the same key never interleave.
 *
 * Typical use: reupload / replace for one skillId serialises the whole
 * "swap temp directory + update DB" sequence, avoiding the cross-await race where
 * disk holds B's content while the DB still holds A's metadata.
 */
const tails = new Map<string, Promise<unknown>>()

export function withKeyedLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const prev = tails.get(key) ?? Promise.resolve()
  // 等上一个任务彻底 settle 后再跑 fn（prev 是吞掉异常的尾巴，永不 reject）。
  const result = prev.then(() => fn())
  // 下一个等待者挂在本任务之后，无论成功失败都放行，故吞掉异常。
  const tail = result.then(
    () => {},
    () => {},
  )
  tails.set(key, tail)
  // 链尾清理：当本任务是该 key 的最后一个时，删除 map 项避免无界增长。
  tail.then(() => {
    if (tails.get(key) === tail) tails.delete(key)
  })
  return result
}
