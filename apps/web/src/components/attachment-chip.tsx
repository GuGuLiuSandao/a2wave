import { FileText } from 'lucide-react'
import { useState } from 'react'

/**
 * 会话/运行记录里渲染单个附件的 chip：图片显缩略图，非图片或图片加载失败（历史里
 * 暂存已过 TTL → GET 404）显文件图标 + 文件名。这样「文件还有效就预览、失效就降级」。
 */
export function AttachmentChip({
  name,
  previewUrl,
  className,
}: {
  name: string
  previewUrl?: string
  className?: string
}) {
  const [failed, setFailed] = useState(false)
  const showImage = previewUrl && !failed
  return (
    <div
      className={
        className ??
        'flex items-center gap-1.5 rounded-md border border-border bg-muted/40 px-2 py-1 text-xs'
      }
    >
      {showImage ? (
        <img
          src={previewUrl}
          alt={name}
          className="size-8 rounded object-cover"
          onError={() => setFailed(true)}
        />
      ) : (
        <FileText className="h-4 w-4 text-muted-foreground" aria-hidden="true" />
      )}
      <span className="max-w-32 truncate" title={name}>
        {name}
      </span>
    </div>
  )
}
