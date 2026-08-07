import { cn } from '@/lib/utils'
import type { LabelHTMLAttributes, ReactNode } from 'react'

interface LabelProps extends LabelHTMLAttributes<HTMLLabelElement> {
  /**
   * 必填标注：为 true 时在标题末尾追加红色 `*`。
   * 全站表单标注规范：必填加 `*`，可选不加任何标记（也不写「（可选）」）。
   */
  required?: boolean
  children?: ReactNode
}

function Label({ className, required, children, ...props }: LabelProps) {
  return (
    // biome-ignore lint/a11y/noLabelWithoutControl: generic wrapper — its control lives at the call site, which passes `htmlFor` (or nests the input) through `...props`; this component cannot own that association.
    <label
      className={cn(
        // inline-block so vertical margins apply: a bare <label> is display:inline,
        // where margin-top/bottom are inert — that silently collapsed the spacing
        // whenever a Label sat as a heading inside a space-y stack.
        'inline-block text-sm font-medium leading-none peer-disabled:cursor-not-allowed peer-disabled:opacity-70',
        className,
      )}
      {...props}
    >
      {children}
      {required && (
        <span className="ml-0.5 text-destructive" aria-hidden="true">
          *
        </span>
      )}
    </label>
  )
}

export { Label }
