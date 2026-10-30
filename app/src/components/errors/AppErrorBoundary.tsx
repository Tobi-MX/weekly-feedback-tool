import { Component } from 'react'
import type { ErrorInfo, ReactNode } from 'react'

export interface ErrorBoundaryFallbackProps {
  readonly reset: () => void
}

interface AppErrorBoundaryProps {
  readonly children: ReactNode
  readonly fallback: (props: ErrorBoundaryFallbackProps) => ReactNode
}

interface AppErrorBoundaryState {
  readonly error: Error | null
}

/**
 * The only data sent to the log sink. It deliberately excludes auth state,
 * query data, form values, and the URL so a boundary can never leak them.
 */
export function logBoundaryError(
  error: Error,
  componentStack: string | null | undefined,
): void {
  console.error('[app-error-boundary]', error, componentStack ?? '')
}

/**
 * React class boundary shared by the root fallback and the in-shell route
 * fallback. `react-error-boundary` is intentionally not a dependency.
 */
export class AppErrorBoundary extends Component<
  AppErrorBoundaryProps,
  AppErrorBoundaryState
> {
  state: AppErrorBoundaryState = { error: null }

  static getDerivedStateFromError(error: Error): AppErrorBoundaryState {
    return { error }
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    logBoundaryError(error, info.componentStack)
  }

  reset = (): void => {
    this.setState({ error: null })
  }

  render(): ReactNode {
    if (this.state.error) {
      return this.props.fallback({ reset: this.reset })
    }

    return this.props.children
  }
}

export default AppErrorBoundary
