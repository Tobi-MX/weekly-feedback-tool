import { act, fireEvent, screen, waitFor } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import type { AuthOperationResult, AuthSessionResult } from './authClient'
import { authMock, deferred, makeSession } from '../test/authMock'
import { renderAuthHarness } from '../test/renderApp'

function statusText(): string {
  return screen.getByTestId('auth-status').textContent ?? ''
}

function reasonText(): string {
  return screen.getByTestId('auth-reason').textContent ?? ''
}

describe('AuthProvider', () => {
  it('reports unconfigured without requesting a session or subscribing', () => {
    authMock.isSupabaseConfigured = false

    renderAuthHarness()

    expect(statusText()).toBe('unconfigured')
    expect(authMock.getSession).not.toHaveBeenCalled()
    expect(authMock.onAuthStateChange).not.toHaveBeenCalled()
    expect(authMock.activeListenerCount()).toBe(0)
  })

  it('restores a persisted session and exposes the user', async () => {
    authMock.getSession.mockResolvedValue({
      session: makeSession('dev@example.com'),
      error: null,
    })

    renderAuthHarness()

    expect(statusText()).toBe('loading')
    await waitFor(() => {
      expect(statusText()).toBe('authenticated')
    })
    expect(screen.getByTestId('auth-email')).toHaveTextContent(
      'dev@example.com',
    )
    expect(screen.getByTestId('auth-token')).toHaveTextContent(
      'test-access-token',
    )
    expect(reasonText()).toBe('none')
  })

  it('ends unauthenticated with no notice when no session exists', async () => {
    authMock.getSession.mockResolvedValue({ session: null, error: null })

    renderAuthHarness()

    await waitFor(() => {
      expect(statusText()).toBe('unauthenticated')
    })
    expect(reasonText()).toBe('none')
    expect(screen.getByTestId('auth-email')).toHaveTextContent('none')
  })

  it('ends unauthenticated with an expiry reason when restore fails', async () => {
    authMock.getSession.mockResolvedValue({
      session: null,
      error: 'session-expired',
    })

    renderAuthHarness()

    await waitFor(() => {
      expect(statusText()).toBe('unauthenticated')
    })
    expect(reasonText()).toBe('expired')
  })

  it('does not return to loading after TOKEN_REFRESHED or USER_UPDATED', async () => {
    authMock.getSession.mockResolvedValue({
      session: makeSession('dev@example.com'),
      error: null,
    })

    renderAuthHarness()
    await waitFor(() => {
      expect(statusText()).toBe('authenticated')
    })

    act(() => {
      authMock.emitAuthEvent('TOKEN_REFRESHED', makeSession('dev@example.com'))
    })
    expect(statusText()).toBe('authenticated')

    act(() => {
      authMock.emitAuthEvent('USER_UPDATED', makeSession('dev@example.com'))
    })
    expect(statusText()).toBe('authenticated')
    expect(statusText()).not.toBe('loading')
  })

  it('keeps one listener under StrictMode and unsubscribes on unmount', () => {
    const restore = deferred<AuthSessionResult>()
    authMock.getSession.mockReturnValue(restore.promise)

    const view = renderAuthHarness({ strictMode: true })

    expect(authMock.onAuthStateChange).toHaveBeenCalledTimes(2)
    expect(authMock.activeListenerCount()).toBe(1)

    view.unmount()

    expect(authMock.activeListenerCount()).toBe(0)
  })

  it('builds an absolute callback URL on the current origin', async () => {
    renderAuthHarness()
    await waitFor(() => {
      expect(statusText()).toBe('unauthenticated')
    })

    fireEvent.click(screen.getByRole('button', { name: 'Send link' }))

    await waitFor(() => {
      expect(authMock.signInWithOtp).toHaveBeenCalledTimes(1)
    })

    const [email, redirectTo] = authMock.signInWithOtp.mock.calls[0]
    const callbackUrl = new URL(redirectTo)

    expect(email).toBe('dev@example.com')
    expect(callbackUrl.origin).toBe(window.location.origin)
    expect(callbackUrl.pathname).toBe('/auth/callback')
    expect(callbackUrl.searchParams.get('redirectTo')).toBe('/projects')
  })

  it('clears the expiry reason after a successful magic-link sign-in', async () => {
    authMock.getSession.mockResolvedValue({
      session: null,
      error: 'session-expired',
    })

    renderAuthHarness()
    await waitFor(() => {
      expect(reasonText()).toBe('expired')
    })

    authMock.setSession.mockResolvedValue({
      session: makeSession('dev@example.com'),
      error: null,
    })

    fireEvent.click(screen.getByRole('button', { name: 'Complete magic link' }))

    await waitFor(() => {
      expect(statusText()).toBe('authenticated')
    })
    expect(reasonText()).toBe('none')
    expect(authMock.setSession).toHaveBeenCalledWith(
      'access-token',
      'refresh-token',
    )
  })

  it('deduplicates sign-out calls and ignores late auth events', async () => {
    authMock.getSession.mockResolvedValue({
      session: makeSession('dev@example.com'),
      error: null,
    })

    renderAuthHarness()
    await waitFor(() => {
      expect(statusText()).toBe('authenticated')
    })

    const pending = deferred<AuthOperationResult>()
    authMock.signOut.mockReturnValue(pending.promise)

    fireEvent.click(screen.getByRole('button', { name: 'Sign out' }))
    fireEvent.click(screen.getByRole('button', { name: 'Sign out' }))

    expect(authMock.signOut).toHaveBeenCalledTimes(1)

    act(() => {
      authMock.emitAuthEvent('SIGNED_IN', makeSession('dev@example.com'))
      authMock.emitAuthEvent('TOKEN_REFRESHED', makeSession('dev@example.com'))
    })

    expect(statusText()).toBe('authenticated')

    await act(async () => {
      pending.resolve({ error: null })
    })

    await waitFor(() => {
      expect(statusText()).toBe('unauthenticated')
    })
    expect(reasonText()).toBe('signed-out')
    expect(screen.getByTestId('auth-email')).toHaveTextContent('none')
    expect(screen.getByTestId('auth-token')).toHaveTextContent('none')

    act(() => {
      authMock.emitAuthEvent('SIGNED_IN', makeSession('dev@example.com'))
      authMock.emitAuthEvent('TOKEN_REFRESHED', makeSession('dev@example.com'))
    })

    expect(statusText()).toBe('unauthenticated')
    expect(screen.getByTestId('auth-token')).toHaveTextContent('none')
  })

  it('still clears the local session when sign-out fails', async () => {
    authMock.getSession.mockResolvedValue({
      session: makeSession('dev@example.com'),
      error: null,
    })

    renderAuthHarness()
    await waitFor(() => {
      expect(statusText()).toBe('authenticated')
    })

    authMock.signOut.mockResolvedValue({ error: 'network' })

    fireEvent.click(screen.getByRole('button', { name: 'Sign out' }))

    await waitFor(() => {
      expect(statusText()).toBe('unauthenticated')
    })
    expect(reasonText()).toBe('signed-out')
    expect(screen.getByTestId('auth-email')).toHaveTextContent('none')
    expect(screen.getByTestId('auth-token')).toHaveTextContent('none')
  })
})
