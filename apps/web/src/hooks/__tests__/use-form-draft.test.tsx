import { act, renderHook } from '@testing-library/react'
import { useForm } from 'react-hook-form'
import { beforeEach, describe, expect, it } from 'vitest'

import { useFormDraft } from '../use-form-draft'

type Values = { name: string; apiKey: string }

const KEY = 'draft:unit'

/** 组合 useForm + useFormDraft，返回二者句柄供测试驱动。 */
function useSetup(omit?: (keyof Values)[]) {
  const form = useForm<Values>({ defaultValues: { name: '', apiKey: '' } })
  const draft = useFormDraft('unit', form, omit ? { omit } : undefined)
  return { form, draft }
}

function dirty(result: { current: ReturnType<typeof useSetup> }, v: Partial<Values>) {
  act(() => {
    for (const [k, val] of Object.entries(v)) {
      result.current.form.setValue(k as keyof Values, val as string, { shouldDirty: true })
    }
  })
}

describe('useFormDraft', () => {
  beforeEach(() => localStorage.clear())

  it('restores a saved draft onto the form on mount', () => {
    localStorage.setItem(KEY, JSON.stringify({ name: 'restored', apiKey: 'x' }))
    const { result } = renderHook(() => useSetup())
    expect(result.current.form.getValues().name).toBe('restored')
  })

  it('blanks omitted credential fields instead of persisting them', () => {
    const { result, unmount } = renderHook(() => useSetup(['apiKey']))
    dirty(result, { name: 'agent', apiKey: 'sk-secret' })
    unmount() // cleanup 保存
    const saved = JSON.parse(localStorage.getItem(KEY) ?? '{}')
    expect(saved.name).toBe('agent')
    expect(saved.apiKey).toBe('') // 凭证置空，不落本地
  })

  it('persists dirty values on unmount (baseline behaviour)', () => {
    const { result, unmount } = renderHook(() => useSetup())
    dirty(result, { name: 'agent' })
    unmount()
    expect(JSON.parse(localStorage.getItem(KEY) ?? '{}').name).toBe('agent')
  })

  // 回归：创建成功会先 clearDraft() 再 navigate() → 组件卸载触发 cleanup save。
  // clearDraft 后必须门控，否则刚清掉的草稿被复写回来，污染下一次创建。
  it('does NOT rewrite the draft on unmount after clearDraft()', () => {
    const { result, unmount } = renderHook(() => useSetup())
    dirty(result, { name: 'agent' })
    act(() => result.current.draft.clearDraft())
    expect(localStorage.getItem(KEY)).toBeNull()
    unmount()
    expect(localStorage.getItem(KEY)).toBeNull() // cleanup 未复写
  })

  it('does NOT rewrite the draft on beforeunload after clearDraft()', () => {
    const { result } = renderHook(() => useSetup())
    dirty(result, { name: 'agent' })
    act(() => result.current.draft.clearDraft())
    act(() => window.dispatchEvent(new Event('beforeunload')))
    expect(localStorage.getItem(KEY)).toBeNull()
  })
})
