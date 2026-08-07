import { cn } from '@/lib/utils'
import { Switch as AntSwitch } from 'antd'
import { forwardRef } from 'react'

interface SwitchProps {
  checked?: boolean
  defaultChecked?: boolean
  onCheckedChange?: (checked: boolean) => void
  disabled?: boolean
  className?: string
  'aria-label'?: string
}

const Switch = forwardRef<HTMLButtonElement, SwitchProps>(
  (
    { checked, defaultChecked, onCheckedChange, disabled, className, 'aria-label': ariaLabel },
    ref,
  ) => (
    <AntSwitch
      ref={ref as React.Ref<HTMLButtonElement>}
      checked={checked}
      defaultChecked={defaultChecked}
      onChange={onCheckedChange}
      disabled={disabled}
      className={cn(
        '[&.ant-switch]:min-w-9 [&.ant-switch]:h-5',
        '[&.ant-switch-checked]:bg-primary',
        '[&:not(.ant-switch-checked)]:bg-input',
        className,
      )}
      aria-label={ariaLabel}
    />
  ),
)
Switch.displayName = 'Switch'

export { Switch }
