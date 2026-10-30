import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react'
import type { ReactNode } from 'react'
import { useLocation, useNavigate } from 'react-router-dom'
import type { AuthChangeEvent, Session, User } from '@supabase/supabase-js'
import {
  getSession,
  isSupabaseConfigured,
  onAuthStateChange,
  setSession as setSupabaseSession,
  signInWithOtp,
  signOut as supabaseSignOut,
} from './authClient'
import type { AuthErrorCode } from './authClient'
import { safeRedirectPath } from './redirectPath'

export type AuthStatus =
  'loading' | 'authenticated' | 'unauthenticated' | 'unconfigured'

export type SignedOutReason = 'signed-out' | 'expired' | null

export interface AuthActionResult {
  readonly ok: boolean
  readonly error: AuthErrorCode | null
}

export interface AuthContextValue {
  readonly status: AuthStatus
  readonly user: User | null
  readonly session: Session | null
  readonly signedOutReason: SignedOutReason
  readonly isSigningOut: boolean
  readonly signInWithMagicLink: (
    email: string,
    redirectTo?: string,
  ) => Promise<AuthActionResult>
  readonly signOut: () => Promise<AuthActionResult>
  readonly completeMagicLink: (
    accessToken: string,
    refreshToken: string,
  ) => Promise<AuthActionResult>
}

const AuthContext = createContext<AuthContextValue | null>(null)

function emailRedirectUrl(redirectTo?: string): string {
  const callbackUrl = new URL('/auth/callback', window.location.origin)
  if (redirectTo !== undefined) {
    callbackUrl.searchParams.set('redirectTo', safeRedirectPath(redirectTo))
  }
  return callbackUrl.toString()
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const navigate = useNavigate()
  const location = useLocation()
  const [status, setStatus] = useState<AuthStatus>(() =>
    isSupabaseConfigured ? 'loading' : 'unconfigured',
  )
  const [session, setSession] = useState<Session | null>(null)
  const [signedOutReason, setSignedOutReason] = useState<SignedOutReason>(null)
  const [isSigningOut, setIsSigningOut] = useState(false)

  // A sign-out was explicitly requested. Events that arrive afterwards (for
  // example a late SIGNED_IN or TOKEN_REFRESHED) must not restore the user.
  const explicitSignOutRef = useRef(false)
  // The initial session check has settled (through getSession or an event).
  const settledRef = useRef(false)
  const signOutPromiseRef = useRef<Promise<AuthActionResult> | null>(null)

  useEffect(() => {
    if (!isSupabaseConfigured) {
      return
    }

    let active = true

    const applySession = (nextSession: Session) => {
      settledRef.current = true
      setSession(nextSession)
      setStatus('authenticated')
      setSignedOutReason(null)
    }

    const handleEvent = (
      event: AuthChangeEvent,
      nextSession: Session | null,
    ) => {
      if (!active || explicitSignOutRef.current) {
        return
      }

      if (nextSession) {
        applySession(nextSession)
        return
      }

      // A null session on SIGNED_OUT means the stored session is gone. During
      // initial restore this is how Supabase reports a refresh-token failure.
      if (event === 'SIGNED_OUT') {
        settledRef.current = true
        setSession(null)
        setStatus('unauthenticated')
        setSignedOutReason('expired')
      }
    }

    const subscription = onAuthStateChange(handleEvent)

    const restore = async () => {
      try {
        const result = await getSession()
        if (!active || settledRef.current) {
          return
        }

        settledRef.current = true

        if (result.session) {
          setSession(result.session)
          setStatus('authenticated')
          setSignedOutReason(null)
        } else {
          setSession(null)
          setStatus('unauthenticated')
          setSignedOutReason(result.error ? 'expired' : null)
        }
      } catch {
        if (!active || settledRef.current) {
          return
        }

        settledRef.current = true
        setSession(null)
        setStatus('unauthenticated')
        setSignedOutReason('expired')
      }
    }

    void restore()

    return () => {
      active = false
      subscription.unsubscribe()
    }
  }, [])

  // The explicit sign-out handler owns navigation to /login. Keep the guard
  // suppressed until that navigation has actually rendered, because router
  // navigation runs in a transition and may land after the auth state update.
  useEffect(() => {
    if (isSigningOut && location.pathname === '/login') {
      // Router navigation runs in a transition, so this flag cannot be cleared
      // when signOut resolves: the guard would redirect before /login renders.
      // Clear it only once the router has actually committed the new location.
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setIsSigningOut(false)
    }
  }, [isSigningOut, location.pathname])

  const signInWithMagicLink = useCallback(
    async (email: string, redirectTo?: string): Promise<AuthActionResult> => {
      if (!isSupabaseConfigured) {
        return { ok: false, error: 'unknown' }
      }

      try {
        const result = await signInWithOtp(
          email.trim(),
          emailRedirectUrl(redirectTo),
        )

        return { ok: result.error === null, error: result.error }
      } catch {
        return { ok: false, error: 'unknown' }
      }
    },
    [],
  )

  const completeMagicLink = useCallback(
    async (
      accessToken: string,
      refreshToken: string,
    ): Promise<AuthActionResult> => {
      try {
        const result = await setSupabaseSession(accessToken, refreshToken)

        if (result.error || !result.session) {
          return { ok: false, error: result.error ?? 'invalid-link' }
        }

        // A completed magic link is a new sign-in, so late events from an
        // earlier explicit sign-out are no longer suppressed.
        explicitSignOutRef.current = false
        settledRef.current = true
        setSession(result.session)
        setStatus('authenticated')
        setSignedOutReason(null)
        setIsSigningOut(false)

        return { ok: true, error: null }
      } catch {
        return { ok: false, error: 'invalid-link' }
      }
    },
    [],
  )

  const signOut = useCallback((): Promise<AuthActionResult> => {
    if (signOutPromiseRef.current) {
      return signOutPromiseRef.current
    }

    const run = (async (): Promise<AuthActionResult> => {
      explicitSignOutRef.current = true
      settledRef.current = true
      setIsSigningOut(true)

      let error: AuthErrorCode | null
      try {
        const result = await supabaseSignOut()
        error = result.error
      } catch {
        error = 'unknown'
      }

      // The local session is cleared even when the server request failed.
      setSession(null)
      setStatus('unauthenticated')
      setSignedOutReason('signed-out')
      // This is the only navigation for an explicit sign-out. The guard stays
      // suppressed until /login has rendered (see the effect above).
      navigate('/login', { replace: true })

      return { ok: error === null, error }
    })()

    signOutPromiseRef.current = run
    void run.then(
      () => {
        signOutPromiseRef.current = null
      },
      () => {
        signOutPromiseRef.current = null
      },
    )

    return run
  }, [navigate])

  const value = useMemo<AuthContextValue>(
    () => ({
      status,
      user: session?.user ?? null,
      session,
      signedOutReason,
      isSigningOut,
      signInWithMagicLink,
      signOut,
      completeMagicLink,
    }),
    [
      status,
      session,
      signedOutReason,
      isSigningOut,
      signInWithMagicLink,
      signOut,
      completeMagicLink,
    ],
  )

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>
}

/** The only way components read auth state. */
export function useAuth(): AuthContextValue {
  const value = useContext(AuthContext)
  if (!value) {
    throw new Error('useAuth must be used within an AuthProvider')
  }
  return value
}
