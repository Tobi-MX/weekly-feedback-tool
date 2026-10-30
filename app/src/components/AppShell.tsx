import { Link, NavLink, Outlet, useLocation } from 'react-router-dom'
import { cn } from '@/lib/utils'
import { useProfileDisplay } from '@/profile/useProfile'
import { AppErrorBoundary } from './errors/AppErrorBoundary'
import { RouteErrorFallback } from './errors/ErrorFallbacks'
import MobileNavMenu from './MobileNavMenu'
import UserMenu from './UserMenu'

export function desktopNavLinkClass(isActive: boolean): string {
  return cn(
    'inline-flex h-9 items-center rounded-md px-3 text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2',
    isActive
      ? 'bg-secondary text-secondary-foreground'
      : 'text-muted-foreground hover:bg-accent hover:text-accent-foreground',
  )
}

/**
 * The single signed-in layout. Every protected route renders through its
 * `<Outlet />`, so there is exactly one banner header, one primary nav, and one
 * main in the document.
 */
export function AppShell() {
  const location = useLocation()
  const profile = useProfileDisplay()

  return (
    <div className="flex min-h-screen flex-col bg-background text-foreground">
      <header className="sticky top-0 z-40 border-b bg-background">
        <div className="mx-auto flex h-14 w-full max-w-6xl items-center gap-2 px-4 sm:px-6">
          <Link
            to="/projects"
            className="min-w-0 truncate text-base font-semibold tracking-tight"
          >
            Weekly Feedback Tool
          </Link>
          <div className="ml-auto flex shrink-0 items-center gap-1">
            <nav aria-label="Primary" className="flex items-center">
              <ul className="hidden items-center gap-1 md:flex">
                <li>
                  <NavLink
                    to="/projects"
                    className={({ isActive }) => desktopNavLinkClass(isActive)}
                  >
                    Projects
                  </NavLink>
                </li>
              </ul>
              <MobileNavMenu />
            </nav>
            <UserMenu label={profile.label} email={profile.email} />
          </div>
        </div>
      </header>
      <main className="mx-auto w-full max-w-5xl flex-1 px-4 py-6 sm:px-6 lg:px-8">
        <AppErrorBoundary
          key={`${location.pathname}${location.search}`}
          fallback={({ reset }) => <RouteErrorFallback reset={reset} />}
        >
          <Outlet />
        </AppErrorBoundary>
      </main>
    </div>
  )
}

export default AppShell
