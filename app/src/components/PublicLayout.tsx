import type { ReactNode } from 'react'
import { Link, Outlet } from 'react-router-dom'
import BackendStatus from '@/BackendStatus'

/**
 * The minimal public frame shared by /login, /auth/callback, and the
 * unconfigured-auth notice. It has exactly one main and no signed-in controls.
 */
export function PublicFrame({ children }: { children: ReactNode }) {
  return (
    <div className="flex min-h-screen flex-col bg-background text-foreground">
      <header className="border-b">
        <div className="mx-auto flex h-14 w-full max-w-5xl items-center px-4 sm:px-6">
          <Link
            to="/projects"
            className="min-w-0 truncate text-base font-semibold tracking-tight"
          >
            Weekly Feedback Tool
          </Link>
        </div>
      </header>
      <main className="mx-auto w-full max-w-md flex-1 px-4 py-8 sm:px-6">
        {children}
        <div className="mt-8 border-t pt-6">
          <BackendStatus />
        </div>
      </main>
    </div>
  )
}

export function PublicLayout() {
  return (
    <PublicFrame>
      <Outlet />
    </PublicFrame>
  )
}

export default PublicLayout
