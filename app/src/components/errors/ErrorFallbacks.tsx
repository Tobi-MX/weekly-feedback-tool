import { Button } from '@/components/ui/button'

/** Full-page fallback rendered by the root boundary. */
export function RootErrorFallback() {
  return (
    <main className="flex min-h-screen flex-col items-center justify-center gap-4 bg-background px-4 text-center text-foreground">
      <p className="text-sm font-medium text-muted-foreground">
        Weekly Feedback Tool
      </p>
      <h1 className="text-2xl font-semibold tracking-tight">
        Something went wrong
      </h1>
      <p className="max-w-md text-sm text-muted-foreground">
        An unexpected error stopped the app from loading. Reload the page to try
        again.
      </p>
      <Button type="button" onClick={() => window.location.reload()}>
        Reload page
      </Button>
    </main>
  )
}

export interface RouteErrorFallbackProps {
  readonly reset: () => void
}

/** Inline fallback rendered inside the shell's main content area. */
export function RouteErrorFallback({ reset }: RouteErrorFallbackProps) {
  return (
    <div
      role="alert"
      className="rounded-lg border border-destructive/30 bg-destructive/5 p-6"
    >
      <h1 className="text-xl font-semibold tracking-tight">
        Something went wrong
      </h1>
      <p className="mt-2 max-w-prose text-sm text-muted-foreground">
        This screen could not be displayed. Try again, or reload the page. The
        rest of the app is still available.
      </p>
      <div className="mt-4 flex flex-wrap gap-2">
        <Button type="button" onClick={reset}>
          Try again
        </Button>
        <Button
          type="button"
          variant="outline"
          onClick={() => window.location.reload()}
        >
          Reload page
        </Button>
      </div>
    </div>
  )
}
