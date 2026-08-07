import { safeSetItem } from '@/lib/safe-storage'
import { useCallback, useEffect, useRef } from 'react'
import type { FieldValues, UseFormReturn } from 'react-hook-form'

export function useFormDraft<T extends FieldValues>(
  key: string,
  form: UseFormReturn<T>,
  options?: { omit?: (keyof T)[] },
) {
  const storageKey = `draft:${key}`
  const restoredRef = useRef(false)
  // clearDraft 后置位：阻止 interval/cleanup/beforeunload 再把表单写回 localStorage。
  // 创建成功会先 clearDraft() 再 navigate()，导致组件卸载触发 cleanup save，若不门控会把刚清掉的草稿复写回来。
  const disabledRef = useRef(false)
  const formRef = useRef(form)
  const storageKeyRef = useRef(storageKey)
  // 凭证类字段不落本地（localStorage 明文有 XSS 暴露风险）；序列化时剔除。
  const omitRef = useRef(options?.omit ?? [])
  omitRef.current = options?.omit ?? []
  formRef.current = form
  storageKeyRef.current = storageKey

  const serialize = useCallback(() => {
    const values = { ...formRef.current.getValues() } as Record<string, unknown>
    // 凭证置空而非删除：删除会在 form.reset(草稿) 恢复时变成 undefined，破坏 z.string() 校验
    // 导致表单静默无法提交。置空既不持久化真实凭证，又保持字段为合法空串。
    for (const k of omitRef.current) {
      if (k in values) values[k as string] = ''
    }
    return JSON.stringify(values)
  }, [])

  useEffect(() => {
    if (restoredRef.current) return
    const saved = localStorage.getItem(storageKey)
    if (!saved) return
    try {
      const data = JSON.parse(saved) as Partial<T>
      // 合并到当前默认值之上：草稿缺失的字段（含被剔除的凭证、旧版本草稿少的字段）回退到
      // 合法默认值，避免 reset 成 undefined 破坏校验导致表单无法提交。
      form.reset({ ...form.getValues(), ...data }, { keepDirtyValues: false })
    } catch {
      localStorage.removeItem(storageKey)
    }
    restoredRef.current = true
  }, [storageKey, form])

  useEffect(() => {
    const timer = form.formState.isDirty
      ? setInterval(() => {
          if (!disabledRef.current) safeSetItem(storageKeyRef.current, serialize())
        }, 10_000)
      : null
    return () => {
      if (timer) clearInterval(timer)
      if (!disabledRef.current) safeSetItem(storageKeyRef.current, serialize())
    }
  }, [form.formState.isDirty, serialize])

  // 刷新/关闭页面不会触发 React cleanup，会丢掉未到 10s 间隔的编辑；用 beforeunload 兜底立即保存。
  useEffect(() => {
    const save = () => {
      if (!disabledRef.current && formRef.current.formState.isDirty) {
        safeSetItem(storageKeyRef.current, serialize())
      }
    }
    window.addEventListener('beforeunload', save)
    return () => window.removeEventListener('beforeunload', save)
  }, [serialize])

  const clearDraft = useCallback(() => {
    disabledRef.current = true
    localStorage.removeItem(storageKeyRef.current)
  }, [])

  return { clearDraft }
}
