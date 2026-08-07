import { cn } from '@/lib/utils'
import { type VariantProps, cva } from 'class-variance-authority'
import { Loader2 } from 'lucide-react'
import {
  type ButtonHTMLAttributes,
  type ReactElement,
  cloneElement,
  forwardRef,
  isValidElement,
} from 'react'

const buttonVariants = cva(
  'inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-md text-sm font-medium transition-all duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background disabled:pointer-events-none disabled:opacity-50 cursor-pointer',
  {
    variants: {
      variant: {
        default:
          'bg-primary text-primary-foreground shadow-sm hover:bg-primary/90 active:scale-[0.98]',
        destructive:
          'bg-destructive text-destructive-foreground shadow-sm hover:bg-destructive/90 active:scale-[0.98]',
        outline:
          'border border-border/80 bg-card text-foreground shadow-xs hover:bg-surface-hover hover:text-foreground hover:border-border active:scale-[0.98]',
        secondary:
          'bg-secondary text-secondary-foreground shadow-xs hover:bg-secondary/80 active:scale-[0.98]',
        ghost: 'hover:bg-surface-hover hover:text-foreground',
        link: 'text-interactive-foreground underline-offset-4 hover:underline',
      },
      size: {
        default: 'h-9 px-4 py-2',
        sm: 'h-8 rounded-md px-3 text-xs',
        lg: 'h-10 rounded-md px-6',
        icon: 'h-9 w-9',
      },
    },
    defaultVariants: {
      variant: 'default',
      size: 'default',
    },
  },
)

export interface ButtonProps
  extends ButtonHTMLAttributes<HTMLButtonElement>,
    VariantProps<typeof buttonVariants> {
  asChild?: boolean
  loading?: boolean
}

/**
 * Minimal Slot replacement — merges parent props onto a single ReactElement child.
 * Covers the same use-case as @radix-ui/react-slot without the dependency.
 */
function SlotButton(
  {
    children,
    className,
    ...rest
  }: ButtonHTMLAttributes<HTMLButtonElement> & { children?: React.ReactNode },
  ref: React.Ref<HTMLButtonElement>,
) {
  if (isValidElement(children)) {
    return cloneElement(children as ReactElement<Record<string, unknown>>, {
      ...rest,
      className: cn(className, (children.props as { className?: string }).className),
      ref,
    })
  }
  return (
    <button ref={ref} className={className} {...rest}>
      {children}
    </button>
  )
}

const SlotButtonForwarded = forwardRef(SlotButton)

const Button = forwardRef<HTMLButtonElement, ButtonProps>(
  (
    {
      className,
      variant,
      size,
      asChild = false,
      loading = false,
      disabled,
      children,
      type,
      ...props
    },
    ref,
  ) => {
    const classes = cn(buttonVariants({ variant, size, className }))
    if (asChild) {
      // No type default here: asChild renders whatever element was passed in
      // (often an <a>), where a type attribute would be meaningless.
      return (
        <SlotButtonForwarded ref={ref} className={classes} type={type} {...props}>
          {children}
        </SlotButtonForwarded>
      )
    }
    // Default to "button", not the HTML default of "submit". Pages here wrap
    // their whole body in one <form>, so an untyped button deep inside — a
    // dialog trigger, a row action — would otherwise save the entire page.
    // Submitting is opt-in via an explicit type="submit".
    return (
      <button
        ref={ref}
        type={type ?? 'button'}
        className={classes}
        disabled={disabled || loading}
        {...props}
      >
        {loading && <Loader2 className="h-4 w-4 animate-spin" />}
        {children}
      </button>
    )
  },
)
Button.displayName = 'Button'

export { Button }
