import { message } from '@/lib/antd-static'
import { formatApiError } from '@/lib/api-error'
import { KB_BATCH_MAX, type KbBatchItem, type KbBatchResult, runKbBatch } from '@/lib/kb-batch'
import { toUploadEntries } from '@/lib/upload-entries'
import { useCallback, useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'

/** What a batch was made of — fixed when the batch starts, so later UI changes cannot rewrite it. */
export type KbBatchKind = 'url' | 'file'

export interface KbBatchState {
  items: KbBatchItem[]
  kind: KbBatchKind
}

/**
 * Drives one sequential KB batch and owns everything the three call sites used to
 * duplicate: the `KB_BATCH_MAX` guard, the running flag, the stop latch, error formatting,
 * and the file-list unwrap.
 *
 * It also owns **cancellation on unmount**, which no call site can do for itself. The
 * create dialog is `destroyOnHidden`, so closing it mid-batch unmounts the form while
 * `mutateAsync` keeps resolving; without this the loop would run to completion and then
 * call back into a component that no longer exists — in practice firing a stale
 * `useUrlRecord.close()` that replaces the whole query string of whatever page the user
 * had navigated to. Callers get `{ abandoned: true }` and must do nothing with it.
 */
export function useKbBatch() {
  const { t } = useTranslation()
  const [batch, setBatch] = useState<KbBatchState | null>(null)
  const [running, setRunning] = useState(false)
  const stopRef = useRef(false)
  const mountedRef = useRef(true)

  useEffect(() => {
    // Not redundant with the `useRef(true)` initializer: the app renders under
    // StrictMode, whose dev-mode double-invoke runs mount → cleanup → mount, so
    // without this reassignment every batch would see a permanently unmounted ref.
    mountedRef.current = true
    return () => {
      mountedRef.current = false
      // Stops the loop between items; the in-flight request cannot be aborted.
      // `run()` clears it again, so a later batch is not stuck on a stale latch.
      stopRef.current = true
    }
  }, [])

  const run = useCallback(
    async (
      kind: KbBatchKind,
      labels: string[],
      create: (label: string, index: number) => Promise<{ name?: string; id?: string }>,
    ): Promise<KbBatchResult & { abandoned: boolean }> => {
      stopRef.current = false
      setRunning(true)
      setBatch({ items: labels.map((label) => ({ label, status: 'pending' })), kind })
      try {
        const result = await runKbBatch(labels, create, {
          onProgress: (items) => {
            if (mountedRef.current) setBatch({ items, kind })
          },
          formatError: (err) => formatApiError(err, t),
          shouldStop: () => stopRef.current,
        })
        return { ...result, abandoned: !mountedRef.current }
      } finally {
        if (mountedRef.current) setRunning(false)
      }
    },
    [t],
  )

  /**
   * Normalizes a file input's selection and enforces the cap.
   *
   * Rejects the whole selection rather than keeping the first `KB_BATCH_MAX`: the upload
   * flow has no submit button to disable, and a silent truncation reads as "all uploaded".
   */
  const filesFromInput = useCallback(
    (fileList: FileList | null): File[] | null => {
      const files = toUploadEntries(fileList).map((entry) => entry.file)
      if (files.length === 0) return null
      if (files.length > KB_BATCH_MAX) {
        message.warning(t('kbDocuments.filesMaxExceeded', { max: KB_BATCH_MAX }))
        return null
      }
      return files
    },
    [t],
  )

  const stop = useCallback(() => {
    stopRef.current = true
  }, [])

  return { batch, running, run, stop, filesFromInput }
}
