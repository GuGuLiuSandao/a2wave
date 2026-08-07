import { Button } from '@/components/ui/button'
import i18n from '@/i18n'
import { AlertTriangle } from 'lucide-react'
import { Component, type ReactNode } from 'react'

interface Props {
  children: ReactNode
}

interface State {
  hasError: boolean
  error: Error | null
}

export class ErrorBoundary extends Component<Props, State> {
  constructor(props: Props) {
    super(props)
    this.state = { hasError: false, error: null }
  }

  static getDerivedStateFromError(error: Error): State {
    return { hasError: true, error }
  }

  handleRetry = () => {
    this.setState({ hasError: false, error: null })
  }

  render() {
    if (this.state.hasError) {
      const t = (key: string) => i18n.t(key)
      return (
        <div className="flex min-h-screen items-center justify-center bg-background p-4">
          <div className="w-full max-w-md space-y-6 text-center">
            <div className="mx-auto flex h-16 w-16 items-center justify-center rounded-full bg-destructive/10">
              <AlertTriangle className="h-8 w-8 text-destructive" />
            </div>
            <div className="space-y-2">
              <h1 className="text-xl font-semibold text-foreground">{t('errorBoundary.title')}</h1>
              <p className="text-sm text-muted-foreground">{t('errorBoundary.description')}</p>
            </div>
            {this.state.error && (
              <div className="rounded-md border border-border bg-muted/30 px-3 py-2 text-left font-mono text-sm">
                {this.state.error.message}
              </div>
            )}
            <Button onClick={this.handleRetry}>{t('errorBoundary.retry')}</Button>
          </div>
        </div>
      )
    }

    return this.props.children
  }
}
