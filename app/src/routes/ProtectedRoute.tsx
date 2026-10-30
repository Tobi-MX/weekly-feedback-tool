import { Navigate, Outlet, useLocation } from 'react-router-dom'
import { useAuth } from '../auth/AuthProvider'
import AuthConfigurationNotice from '../auth/AuthConfigurationNotice'
import AuthLoading from '../auth/AuthLoading'
import { buildLoginPath } from '../auth/redirectPath'

/**
 * The single guard for protected routes. While the session is loading it
 * renders one stable loading view; an unconfigured app shows the
 * configuration notice in place instead of redirecting to a login screen that
 * cannot work.
 */
export function ProtectedRoute() {
  const { status, isSigningOut } = useAuth()
  const location = useLocation()

  if (status === 'unconfigured') {
    return <AuthConfigurationNotice />
  }

  if (status === 'loading') {
    return <AuthLoading />
  }

  if (status === 'unauthenticated') {
    // The sign-out handler owns navigation to /login. While it is completing,
    // the guard must not add its own redirect.
    if (isSigningOut) {
      return <AuthLoading />
    }

    const target = `${location.pathname}${location.search}`
    return <Navigate to={buildLoginPath(target)} replace />
  }

  return <Outlet />
}

export default ProtectedRoute
