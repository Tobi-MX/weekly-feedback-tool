import { render } from '@testing-library/react'
import { StrictMode, useEffect } from 'react'
import { MemoryRouter, useLocation } from 'react-router-dom'
import App from '../App'
import { AuthProvider, useAuth } from '../auth/AuthProvider'

const SENSITIVE_PARAMS = [
  'access_token',
  'refresh_token',
  'code',
  'error',
  'error_code',
  'error_description',
]

function sanitizeLocation(pathname: string, search: string): string {
  const params = new URLSearchParams(search)
  for (const key of SENSITIVE_PARAMS) {
    params.delete(key)
  }
  const cleanSearch = params.toString()
  return cleanSearch ? `${pathname}?${cleanSearch}` : pathname
}

function LocationProbe({ log }: { log?: string[] }) {
  const location = useLocation()
  const value = sanitizeLocation(location.pathname, location.search)

  useEffect(() => {
    if (!log) {
      return
    }
    if (log[log.length - 1] !== value) {
      log.push(value)
    }
  }, [log, value])

  return <output data-testid="location">{value}</output>
}

export interface RenderAppOptions {
  readonly initialEntries?: string[]
  readonly strictMode?: boolean
  readonly navigationLog?: string[]
}

/** Renders the real routed app inside a MemoryRouter for tests. */
export function renderApp(options: RenderAppOptions = {}) {
  const initialEntries = options.initialEntries ?? ['/']
  const tree = (
    <MemoryRouter initialEntries={initialEntries}>
      <App />
      <LocationProbe log={options.navigationLog} />
    </MemoryRouter>
  )

  return render(options.strictMode ? <StrictMode>{tree}</StrictMode> : tree)
}

function AuthHarness() {
  const {
    status,
    user,
    session,
    signedOutReason,
    isSigningOut,
    signInWithMagicLink,
    signOut,
    completeMagicLink,
  } = useAuth()

  return (
    <div>
      <p data-testid="auth-status">{status}</p>
      <p data-testid="auth-reason">{signedOutReason ?? 'none'}</p>
      <p data-testid="auth-email">{user?.email ?? 'none'}</p>
      <p data-testid="auth-token">{session?.access_token ?? 'none'}</p>
      <p data-testid="auth-signing-out">{String(isSigningOut)}</p>
      <button
        type="button"
        onClick={() => {
          void completeMagicLink('access-token', 'refresh-token')
        }}
      >
        Complete magic link
      </button>
      <button
        type="button"
        onClick={() => {
          void signOut()
        }}
      >
        Sign out
      </button>
      <button
        type="button"
        onClick={() => {
          void signInWithMagicLink('dev@example.com', '/projects')
        }}
      >
        Send link
      </button>
    </div>
  )
}

export interface RenderAuthHarnessOptions {
  readonly strictMode?: boolean
}

/** Renders AuthProvider directly so provider behaviour can be asserted. */
export function renderAuthHarness(options: RenderAuthHarnessOptions = {}) {
  const tree = (
    <MemoryRouter>
      <AuthProvider>
        <AuthHarness />
      </AuthProvider>
    </MemoryRouter>
  )

  return render(options.strictMode ? <StrictMode>{tree}</StrictMode> : tree)
}
