/**
 * Shared message composer: pending-attachment chips, file picker, textarea and
 * send/stop control. Used by both the agent test drawer and the chat app page.
 */
import { Button } from '@/components/ui/button'
import { Textarea } from '@/components/ui/textarea'
import type { PendingAttachment } from '@/hooks/use-agent-chat'
import { cn } from '@/lib/utils'
import { AlertCircle, FileText, Loader2, Paperclip, Send, Square, X } from 'lucide-react'
import { useRef } from 'react'
import { useTranslation } from 'react-i18next'

interface ChatComposerProps {
  value: string
  onChange: (value: string) => void
  onSend: () => void
  /** Abort the in-flight turn. Omit to hide the stop control. */
  onStop?: () => void
  isStreaming: boolean
  canSend: boolean
  disabled?: boolean
  pendingAttachments: PendingAttachment[]
  onFilesSelected: (files: FileList | null) => void
  onRemoveAttachment: (localId: string) => void
  /** Hide the attach control entirely (chat app can disable attachments). */
  allowAttachments?: boolean
  allowedExtensions: string[]
  placeholder?: string
  rows?: number
  className?: string
  autoFocus?: boolean
}

export function ChatComposer({
  value,
  onChange,
  onSend,
  onStop,
  isStreaming,
  canSend,
  disabled = false,
  pendingAttachments,
  onFilesSelected,
  onRemoveAttachment,
  allowAttachments = true,
  allowedExtensions,
  placeholder,
  rows = 2,
  className,
  autoFocus = false,
}: ChatComposerProps) {
  const { t } = useTranslation()
  const fileInputRef = useRef<HTMLInputElement>(null)

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    // isComposing guards IME input: Enter mid-composition commits the candidate,
    // it must not also send the message.
    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault()
      onSend()
    }
  }

  return (
    <div className={cn('border-t border-border p-4 shrink-0 bg-card', className)}>
      {pendingAttachments.length > 0 && (
        <div className="flex flex-wrap gap-2 mb-2">
          {pendingAttachments.map((att) => (
            <div
              key={att.localId}
              className={cn(
                'relative flex items-center gap-1.5 rounded-md border px-2 py-1 text-xs animate-chat-chip-in',
                att.error ? 'border-destructive/40 bg-destructive/5' : 'border-border bg-muted/40',
              )}
            >
              {att.previewUrl ? (
                <img src={att.previewUrl} alt={att.name} className="size-8 rounded object-cover" />
              ) : (
                <FileText className="h-4 w-4 text-muted-foreground" aria-hidden="true" />
              )}
              <span className="max-w-32 truncate" title={att.name}>
                {att.name}
              </span>
              {att.uploading && (
                <Loader2
                  className="h-3 w-3 animate-spin text-muted-foreground"
                  aria-hidden="true"
                />
              )}
              {att.error && (
                <AlertCircle className="h-3 w-3 text-destructive" aria-label={att.error} />
              )}
              <button
                type="button"
                onClick={() => onRemoveAttachment(att.localId)}
                className="ml-0.5 text-muted-foreground hover:text-foreground transition-colors"
                aria-label={t('agentDetail.attachmentRemove')}
              >
                <X className="h-3 w-3" aria-hidden="true" />
              </button>
            </div>
          ))}
        </div>
      )}
      <div className="flex gap-2">
        {allowAttachments && (
          <>
            <input
              ref={fileInputRef}
              type="file"
              multiple
              accept={allowedExtensions.map((e) => `.${e}`).join(',')}
              className="hidden"
              onChange={(e) => {
                onFilesSelected(e.target.files)
                e.target.value = ''
              }}
            />
            <Button
              type="button"
              variant="outline"
              onClick={() => fileInputRef.current?.click()}
              disabled={isStreaming || disabled}
              size="icon"
              className="self-end shrink-0"
              aria-label={t('agentDetail.attachFile')}
            >
              <Paperclip className="h-4 w-4" aria-hidden="true" />
            </Button>
          </>
        )}
        <Textarea
          value={value}
          onChange={(e) => onChange(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder={placeholder ?? t('agentDetail.typeMessage')}
          rows={rows}
          className="resize-none text-sm"
          disabled={isStreaming || disabled}
          aria-label={t('agentDetail.chatMessage')}
          // Opt-in only: the chat app page is a single-purpose conversation surface
          // where focusing the composer is the expected entry action. The test drawer
          // leaves this off.
          autoFocus={autoFocus}
        />
        {isStreaming && onStop ? (
          <Button
            type="button"
            variant="outline"
            onClick={onStop}
            size="icon"
            className="self-end shrink-0"
            aria-label={t('agentDetail.stopGenerating')}
            title={t('agentDetail.stopGenerating')}
          >
            <Square className="h-3.5 w-3.5 fill-current" aria-hidden="true" />
          </Button>
        ) : (
          <Button
            type="button"
            onClick={onSend}
            disabled={!canSend}
            size="icon"
            className="self-end shrink-0"
            aria-label={t('agentDetail.sendMessage')}
          >
            {isStreaming ? (
              <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
            ) : (
              <Send className="h-4 w-4" aria-hidden="true" />
            )}
          </Button>
        )}
      </div>
    </div>
  )
}
