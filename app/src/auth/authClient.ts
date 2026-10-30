import type { AuthChangeEvent, AuthError, Session } from '@supabase/supabase-js'
import { supabase } from './supabaseClient'

/**
 * Stable, UI-safe error codes. Raw Supabase error objects never leave this
 * module; components only ever render a message derived from these codes.
 */
export type AuthErrorCode =
  | 'network'
  | 'rate-limit'
  | 'invalid-email'
  | 'invalid-link'
  | 'session-expired'
  | 'unknown'

export interface AuthSessionResult {
  readonly session: Session | null
  readonly error: AuthErrorCode | null
}

export interface AuthOperationResult {
  readonly error: AuthErrorCode | null
}

export interface AuthSubscription {
  unsubscribe: () => void
}

export type AuthStateListener = (
  event: AuthChangeEvent,
  session: Session | null,
) => void

/**
 * True only when the public Supabase URL and anon key were valid at startup.
 * When false, no client exists and no auth request may be attempted.
 */
export const isSupabaseConfigured: boolean = supabase !== null

function classifyAuthError(error: AuthError): AuthErrorCode {
  if (error.status === 429 || error.code?.includes('rate_limit')) {
    return 'rate-limit'
  }

  if (
    error.code === 'email_address_invalid' ||
    /invalid.*email|email.*invalid/i.test(error.message)
  ) {
    return 'invalid-email'
  }

  if (
    error.name === 'AuthRetryableFetchError' ||
    error.name === 'TypeError' ||
    /network|fetch|failed to fetch/i.test(error.message)
  ) {
    return 'network'
  }

  return 'unknown'
}

/** Restores the persisted session, refreshing an expired access token if needed. */
export async function getSession(): Promise<AuthSessionResult> {
  if (!supabase) {
    return { session: null, error: null }
  }

  try {
    const { data, error } = await supabase.auth.getSession()
    if (error) {
      return { session: null, error: 'session-expired' }
    }

    return { session: data.session, error: null }
  } catch {
    return { session: null, error: 'network' }
  }
}

/** The only subscription to Supabase auth events in application code. */
export function onAuthStateChange(
  listener: AuthStateListener,
): AuthSubscription {
  if (!supabase) {
    return { unsubscribe: () => undefined }
  }

  const { data } = supabase.auth.onAuthStateChange(listener)
  return { unsubscribe: () => data.subscription.unsubscribe() }
}

export async function signInWithOtp(
  email: string,
  emailRedirectTo: string,
): Promise<AuthOperationResult> {
  if (!supabase) {
    return { error: 'unknown' }
  }

  try {
    const { error } = await supabase.auth.signInWithOtp({
      email,
      options: { emailRedirectTo },
    })

    return { error: error ? classifyAuthError(error) : null }
  } catch {
    return { error: 'network' }
  }
}

/**
 * Establishes a session from the implicit-flow magic-link tokens. The tokens
 * are handed to Supabase once and are never stored or logged by this module.
 */
export async function setSession(
  accessToken: string,
  refreshToken: string,
): Promise<AuthSessionResult> {
  if (!supabase) {
    return { session: null, error: 'invalid-link' }
  }

  try {
    const { data, error } = await supabase.auth.setSession({
      access_token: accessToken,
      refresh_token: refreshToken,
    })

    if (error || !data.session) {
      return { session: null, error: 'invalid-link' }
    }

    return { session: data.session, error: null }
  } catch {
    return { session: null, error: 'invalid-link' }
  }
}

/**
 * Signs out through Supabase. If the server call fails, the local session is
 * still removed with a local-scope sign-out so the app never keeps access the
 * user asked to end.
 */
export async function signOut(): Promise<AuthOperationResult> {
  if (!supabase) {
    return { error: null }
  }

  try {
    const { error } = await supabase.auth.signOut()
    if (!error) {
      return { error: null }
    }

    try {
      await supabase.auth.signOut({ scope: 'local' })
    } catch {
      // The caller still treats the user as signed out locally.
    }

    return { error: 'unknown' }
  } catch {
    try {
      await supabase.auth.signOut({ scope: 'local' })
    } catch {
      // Ignore a second failure; the caller clears local auth state.
    }

    return { error: 'network' }
  }
}
