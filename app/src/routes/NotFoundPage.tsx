import { Link } from 'react-router-dom'
import { Button } from '@/components/ui/button'

/** Shown inside the shell for any unmatched signed-in URL. */
export function NotFoundPage() {
  return (
    <section className="mx-auto max-w-lg py-10 text-center">
      <h1 className="text-2xl font-semibold tracking-tight">Page not found</h1>
      <p className="mt-2 text-sm text-muted-foreground">
        The page you requested does not exist or may have moved.
      </p>
      <Button asChild className="mt-6">
        <Link to="/projects">Back to projects</Link>
      </Button>
    </section>
  )
}

export default NotFoundPage
