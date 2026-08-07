import { cn } from '@/lib/utils'
import { Tabs as AntTabs } from 'antd'
import { type ReactNode, createContext, useContext, useState } from 'react'

// ─── Context ────────────────────────────────────────────────
interface TabsContextValue {
  value: string
  onValueChange: (v: string) => void
}
const TabsContext = createContext<TabsContextValue>({ value: '', onValueChange: () => {} })

// ─── Root ───────────────────────────────────────────────────
interface TabsProps extends React.HTMLAttributes<HTMLDivElement> {
  value?: string
  defaultValue?: string
  onValueChange?: (value: string) => void
}

function Tabs({
  value: controlledValue,
  defaultValue,
  onValueChange,
  className,
  children,
  ...props
}: TabsProps) {
  const [internalValue, setInternalValue] = useState(defaultValue ?? '')
  const value = controlledValue ?? internalValue
  const handleChange = onValueChange ?? setInternalValue

  return (
    <TabsContext.Provider value={{ value, onValueChange: handleChange }}>
      <div className={cn(className)} {...props}>
        {children}
      </div>
    </TabsContext.Provider>
  )
}

// ─── TabsList ───────────────────────────────────────────────
function TabsList({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      role="tablist"
      className={cn(
        'inline-flex h-9 items-center justify-center rounded-lg bg-muted p-1 text-muted-foreground',
        className,
      )}
      {...props}
    />
  )
}

// ─── TabsTrigger ────────────────────────────────────────────
interface TabsTriggerProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  value: string
}

function TabsTrigger({ value: tabValue, className, ...props }: TabsTriggerProps) {
  const { value, onValueChange } = useContext(TabsContext)
  const isActive = value === tabValue

  return (
    <button
      type="button"
      role="tab"
      aria-selected={isActive}
      data-state={isActive ? 'active' : 'inactive'}
      onClick={() => onValueChange(tabValue)}
      className={cn(
        'inline-flex items-center justify-center whitespace-nowrap rounded-md px-3 py-1 text-sm font-medium ring-offset-background transition-all focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:pointer-events-none disabled:opacity-50',
        isActive && 'bg-background text-foreground shadow',
        className,
      )}
      {...props}
    />
  )
}

// ─── TabsContent ────────────────────────────────────────────
interface TabsContentProps extends React.HTMLAttributes<HTMLDivElement> {
  value: string
}

function TabsContent({ value: tabValue, className, children, ...props }: TabsContentProps) {
  const { value } = useContext(TabsContext)
  if (value !== tabValue) return null

  return (
    <div
      role="tabpanel"
      data-state={value === tabValue ? 'active' : 'inactive'}
      className={cn(
        'mt-2 ring-offset-background focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2',
        className,
      )}
      {...props}
    >
      {children}
    </div>
  )
}

export { Tabs, TabsList, TabsTrigger, TabsContent }
