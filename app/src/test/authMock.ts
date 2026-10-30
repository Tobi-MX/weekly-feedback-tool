import { vi } from 'vitest'
import type { AuthChangeEvent, Session, User } from '@supabase/supabase-js'
import type {
  AuthOperationResult,
  AuthSessionResult,
  AuthStateListener,
  AuthSubscription,
} from '../auth/authClient'

const listeners = new Set<AuthStateListener>()

/**
 * Shared mock for `src/auth/authClient.ts`. Every auth test uses this single
 * controller so listener handling, emitted events, and reset behaviour are not
 * duplicated between test files.
 */
export const authMock = {
  isSupabaseConfigured: true as boolean,

  getSession: vi.fn<() => Promise<AuthSessionResult>>(),

  onAuthStateChange: vi.fn<(listener: AuthStateListener) => AuthSubscription>(
    (listener) => {
      listeners.add(listener)
      return {
        unsubscribe: () => {
          listeners.delete(listener)
        },
      }
    },
  ),

  signInWithOtp:
    vi.fn<
      (email: string, emailRedirectTo: string) => Promise<AuthOperationResult>
    >(),

  signOut: vi.fn<() => Promise<AuthOperationResult>>(),

  setSession:
    vi.fn<
      (accessToken: string, refreshToken: string) => Promise<AuthSessionResult>
    >(),

  emitAuthEvent(event: AuthChangeEvent, session: Session | null = null): void {
    for (const listener of [...listeners]) {
      listener(event, session)
    }
  },

  activeListenerCount(): number {
    return listeners.size
  },

  resetAuthMock(): void {
    listeners.clear()
    authMock.isSupabaseConfigured = true

    authMock.getSession
      .mockReset()
      .mockResolvedValue({ session: null, error: null })
    authMock.onAuthStateChange.mockClear()
    authMock.signInWithOtp.mockReset().mockResolvedValue({ error: null })
    authMock.signOut.mockReset().mockResolvedValue({ error: null })
    authMock.setSession
      .mockReset()
      .mockResolvedValue({ session: null, error: 'invalid-link' })
  },
}

/** Resets the shared mock and its listeners between tests. */
export function resetAuthMock(): void {
  authMock.resetAuthMock()
}

export function makeUser(email = 'dev@example.com', id = 'user-1'): User {
  return {
    id,
    email,
    aud: 'authenticated',
    role: 'authenticated',
    app_metadata: {},
    user_metadata: {},
    created_at: '2026-01-01T00:00:00.000Z',
  }
}

export function makeSession(
  email = 'dev@example.com',
  overrides: Partial<Session> = {},
): Session {
  return {
    access_token: 'test-access-token',
    refresh_token: 'test-refresh-token',
    expires_in: 3600,
    expires_at: Math.floor(Date.now() / 1000) + 3600,
    token_type: 'bearer',
    user: makeUser(email),
    ...overrides,
  }
}

/** Configures the mock so the next app render restores the given user. */
export function mockRestoredSession(
  email = 'dev@example.com',
  id = 'user-1',
): Session {
  const session = makeSession(email, { user: makeUser(email, id) })
  authMock.getSession.mockResolvedValue({ session, error: null })
  return session
}

/** Configures the mock so the next app render has no persisted session. */
export function mockEmptySession(): void {
  authMock.getSession.mockResolvedValue({ session: null, error: null })
}

export interface Deferred<T> {
  readonly promise: Promise<T>
  resolve: (value: T) => void
  reject: (reason?: unknown) => void
}

/** A promise the test resolves explicitly, used to assert loading states. */
export function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  return { promise, resolve, reject }
}
