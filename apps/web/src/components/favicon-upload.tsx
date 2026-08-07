import { api } from '@/lib/api'
import { Image, Loader2, Upload, X } from 'lucide-react'
import { useCallback, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'

interface FaviconUploadProps {
  value: string
  onChange: (url: string) => void
  /** Invoked by the remove button; falls back to clearing the value when omitted. */
  onRemove?: () => void
}

export function FaviconUpload({ value, onChange, onRemove }: FaviconUploadProps) {
  const { t } = useTranslation()
  const fileInputRef = useRef<HTMLInputElement>(null)
  const [dragOver, setDragOver] = useState(false)
  const [uploading, setUploading] = useState(false)
  const [error, setError] = useState('')

  const uploadFile = useCallback(
    async (file: File) => {
      setError('')
      const ext = file.name.toLowerCase().slice(file.name.lastIndexOf('.'))
      if (!['.svg', '.png', '.ico', '.jpg', '.jpeg', '.webp'].includes(ext)) {
        setError(t('settings.faviconInvalidType'))
        return
      }
      if (file.size > 512 * 1024) {
        setError(t('settings.faviconTooLarge'))
        return
      }

      setUploading(true)
      try {
        const formData = new FormData()
        formData.append('file', file)
        const res = await api.upload<{ url: string }>('/uploads', formData)
        onChange(res.data.url)
      } catch {
        setError(t('settings.faviconUploadFailed'))
      } finally {
        setUploading(false)
      }
    },
    [onChange, t],
  )

  const handleDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault()
      setDragOver(false)
      const file = e.dataTransfer.files[0]
      if (file) uploadFile(file)
    },
    [uploadFile],
  )

  const handleFileChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const file = e.target.files?.[0]
      if (file) uploadFile(file)
      e.target.value = ''
    },
    [uploadFile],
  )

  const hasPreview = value && value.length > 0

  return (
    <div className="w-72 shrink-0 space-y-2">
      <div
        onDrop={handleDrop}
        onDragOver={(e) => {
          e.preventDefault()
          setDragOver(true)
        }}
        onDragLeave={() => setDragOver(false)}
        onClick={() => !uploading && fileInputRef.current?.click()}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault()
            if (!uploading) fileInputRef.current?.click()
          }
        }}
        // biome-ignore lint/a11y/useSemanticElements: the dropzone hosts a nested remove <button>,
        // and nesting a button inside a button is invalid HTML — so this stays a div with
        // role="button" plus its own keyboard handler.
        role="button"
        tabIndex={0}
        aria-label={t('settings.faviconClickToReplace')}
        className={`relative flex items-center justify-center rounded-lg border-2 border-dashed transition-colors ${
          dragOver ? 'border-primary/50 bg-primary/5' : 'border-border/60 hover:border-border'
        } ${uploading ? 'pointer-events-none opacity-60' : 'cursor-pointer'} ${
          hasPreview ? 'h-20 gap-3 px-3' : 'h-20 flex-col gap-1'
        }`}
      >
        {hasPreview ? (
          <>
            <img
              src={value}
              alt="favicon"
              className="h-10 w-10 rounded object-contain bg-muted/30 p-1"
              onError={(e) => {
                ;(e.target as HTMLImageElement).style.display = 'none'
              }}
            />
            <div className="flex-1 min-w-0">
              <p className="text-xs text-muted-foreground truncate">{value}</p>
              <p className="text-2xs text-muted-foreground/60 mt-0.5">
                {t('settings.faviconClickToReplace')}
              </p>
            </div>
            <button
              type="button"
              aria-label={t('settings.faviconRemove')}
              className="absolute top-1.5 right-1.5 rounded-full p-0.5 hover:bg-surface-hover transition-colors"
              onClick={(e) => {
                e.stopPropagation()
                if (onRemove) onRemove()
                else onChange('')
              }}
            >
              <X className="h-3 w-3 text-muted-foreground" />
            </button>
          </>
        ) : (
          <>
            {uploading ? (
              <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
            ) : (
              <Upload className="h-5 w-5 text-muted-foreground" />
            )}
            <span className="text-xs text-muted-foreground">
              {uploading ? t('common.uploading') : t('settings.faviconDropOrClick')}
            </span>
          </>
        )}
      </div>

      <input
        ref={fileInputRef}
        type="file"
        accept=".svg,.png,.ico,.jpg,.jpeg,.webp"
        className="hidden"
        aria-label={t('settings.faviconUpload')}
        onChange={handleFileChange}
      />

      {error && <p className="text-xs text-destructive">{error}</p>}
    </div>
  )
}
