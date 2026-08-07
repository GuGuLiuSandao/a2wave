import i18n from '@/i18n'
import { cn } from '@/lib/utils'
import { Modal } from 'antd'
import { X } from 'lucide-react'
import type { ReactNode } from 'react'

interface AlertDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  children: ReactNode
}

function AlertDialog({ open, onOpenChange, children }: AlertDialogProps) {
  let content: ReactNode = null
  const rest: ReactNode[] = []

  const childArray = Array.isArray(children) ? children : [children]
  for (const child of childArray) {
    if (child && typeof child === 'object' && 'type' in child) {
      if (child.type === AlertDialogContent) {
        content = child
      } else {
        rest.push(child)
      }
    } else {
      rest.push(child)
    }
  }

  return (
    <>
      {rest}
      {content && (
        <Modal
          open={open}
          onCancel={() => onOpenChange(false)}
          footer={null}
          closable={false}
          destroyOnHidden
          centered
          width={448}
          styles={{
            body: {
              padding: 0,
            },
            root: {
              borderRadius: 'var(--radius-lg)',
              border: '1px solid var(--color-border)',
              boxShadow: 'var(--shadow-xl)',
              overflow: 'hidden',
              padding: 0,
            },
            mask: {
              backgroundColor: 'var(--color-overlay)',
            },
          }}
        >
          <div className="relative p-3">
            {(content as React.ReactElement<{ children?: ReactNode }>).props.children}
            <button
              type="button"
              onClick={() => onOpenChange(false)}
              className="absolute right-3 top-3 rounded-sm opacity-50 ring-offset-background transition-opacity hover:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
              aria-label={i18n.t('common.close')}
            >
              <X className="h-4 w-4" aria-hidden="true" />
            </button>
          </div>
        </Modal>
      )}
    </>
  )
}

function AlertDialogContent({ className, children }: { className?: string; children: ReactNode }) {
  return <div className={cn(className)}>{children}</div>
}

function AlertDialogTitle({ className, ...props }: React.HTMLAttributes<HTMLHeadingElement>) {
  return <h2 className={cn('text-base font-semibold text-foreground', className)} {...props} />
}

function AlertDialogDescription({
  className,
  ...props
}: React.HTMLAttributes<HTMLParagraphElement>) {
  return <p className={cn('text-sm text-muted-foreground mt-2', className)} {...props} />
}

function AlertDialogFooter({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return <div className={cn('mt-5 flex justify-end gap-2', className)} {...props} />
}

export {
  AlertDialog,
  AlertDialogContent,
  AlertDialogTitle,
  AlertDialogDescription,
  AlertDialogFooter,
}
