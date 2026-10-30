import { act, fireEvent, screen, waitFor } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import type { AuthOperationResult, AuthSessionResult } from '../auth/authClient'
import { authMock, deferred, makeSession } from '../test/authMock'
import { renderApp } from '../test/renderApp'

function locationText(): string {
  return screen.getByTestId('location').textContent ?? ''
}

async function waitForLocation(path: string): Promise<void> {
  await waitFor(() => {
    expect(locationText()).toBe(path)
  })
}

describe('protected routes', () => {
  it('shows one stable loading view without protected or login content', () => {
    const restore = deferred<AuthSessionResult>()
    authMock.getSession.mockReturnValue(restore.promise)

    renderApp({ initialEntries: ['/projects'] })

    expect(screen.getAllByText('Loading…')).toHaveLength(1)
    expect(
      screen.queryByRole('heading', { name: 'Projects' }),
    ).not.toBeInTheDocument()
    expect(screen.queryByLabelText('Email')).not.toBeInTheDocument()
  })

  it('redirects a signed-out visitor and preserves path and query exactly once', async () => {
    authMock.getSession.mockResolvedValue({ session: null, error: null })
    const navigationLog: string[] = []

    renderApp({
      initialEntries: ['/projects?tab=members'],
      navigationLog,
    })

    expect(screen.getByText('Loading…')).toBeInTheDocument()

    await waitForLocation('/login?redirectTo=%2Fprojects%3Ftab%3Dmembers')

    expect(
      screen.queryByRole('heading', { name: 'Projects' }),
    ).not.toBeInTheDocument()
    expect(screen.getByLabelText('Email')).toBeInTheDocument()
    expect(
      navigationLog.filter((entry) => entry.startsWith('/login')),
    ).toHaveLength(1)
  })

  it('renders a protected route directly for a signed-in user', async () => {
    authMock.getSession.mockResolvedValue({
      session: makeSession('dev@example.com'),
      error: null,
    })
    const navigationLog: string[] = []

    renderApp({ initialEntries: ['/projects'], navigationLog })

    expect(
      await screen.findByRole('heading', { name: 'Projects' }),
    ).toBeInTheDocument()
    expect(screen.getByText(/dev@example.com/)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Sign out' })).toBeEnabled()
    expect(screen.queryByLabelText('Email')).not.toBeInTheDocument()
    expect(navigationLog).not.toContain('/login')
    expect(screen.getByText(/Backend status:/)).toBeInTheDocument()
  })

  it('restores a session with an expired access token without a login flash', async () => {
    authMock.getSession.mockResolvedValue({
      session: makeSession('dev@example.com', {
        expires_at: Math.floor(Date.now() / 1000) - 10,
      }),
      error: null,
    })
    const navigationLog: string[] = []

    renderApp({ initialEntries: ['/projects'], navigationLog })

    expect(
      await screen.findByRole('heading', { name: 'Projects' }),
    ).toBeInTheDocument()
    expect(
      navigationLog.filter((entry) => entry.startsWith('/login')),
    ).toHaveLength(0)
  })

  it('shows the configuration notice instead of redirecting when unconfigured', () => {
    authMock.isSupabaseConfigured = false
    const navigationLog: string[] = []

    renderApp({ initialEntries: ['/projects'], navigationLog })

    expect(
      screen.getByRole('heading', { name: 'Sign-in is not configured' }),
    ).toBeInTheDocument()
    expect(screen.getByText(/_docs\/local-development\.md/)).toBeInTheDocument()
    expect(locationText()).toBe('/projects')
    expect(navigationLog).not.toContain('/login')
    expect(authMock.getSession).not.toHaveBeenCalled()
    expect(screen.queryByLabelText('Email')).not.toBeInTheDocument()
    expect(screen.getByText(/Backend status:/)).toBeInTheDocument()
  })

  it.each(['/', '/unknown/place'])(
    'redirects %s to /projects and then through the guard',
    async (entry) => {
      authMock.getSession.mockResolvedValue({ session: null, error: null })
      const navigationLog: string[] = []

      renderApp({ initialEntries: [entry], navigationLog })

      await waitForLocation('/login?redirectTo=%2Fprojects')
      expect(
        navigationLog.filter((value) => value.startsWith('/login')),
      ).toHaveLength(1)
    },
  )

  it('shows one expiry notice on /login and settles there', async () => {
    authMock.getSession.mockResolvedValue({
      session: null,
      error: 'session-expired',
    })
    const navigationLog: string[] = []

    renderApp({
      initialEntries: ['/projects?tab=members'],
      navigationLog,
    })

    await waitForLocation('/login?redirectTo=%2Fprojects%3Ftab%3Dmembers')

    expect(
      screen.getAllByText('Your session expired. Sign in again.'),
    ).toHaveLength(1)
    expect(
      screen.queryByText('You have been signed out.'),
    ).not.toBeInTheDocument()
    expect(
      screen.queryByRole('heading', { name: 'Projects' }),
    ).not.toBeInTheDocument()
    expect(screen.queryByText('Loading…')).not.toBeInTheDocument()
    expect(
      navigationLog.filter((entry) => entry.startsWith('/login')),
    ).toHaveLength(1)

    await act(async () => {
      await Promise.resolve()
    })

    expect(locationText()).toBe('/login?redirectTo=%2Fprojects%3Ftab%3Dmembers')
    expect(screen.queryByText('Loading…')).not.toBeInTheDocument()
  })

  it('signs out, clears protected content, and shows one confirmation', async () => {
    authMock.getSession.mockResolvedValue({
      session: makeSession('dev@example.com'),
      error: null,
    })
    authMock.signOut.mockResolvedValue({ error: null })
    const navigationLog: string[] = []

    renderApp({ initialEntries: ['/projects'], navigationLog })

    await screen.findByRole('heading', { name: 'Projects' })
    fireEvent.click(screen.getByRole('button', { name: 'Sign out' }))

    await screen.findByRole('heading', { name: 'Sign in' })

    expect(authMock.signOut).toHaveBeenCalledTimes(1)
    expect(locationText()).toBe('/login')
    expect(screen.getAllByText('You have been signed out.')).toHaveLength(1)
    expect(
      screen.queryByRole('heading', { name: 'Projects' }),
    ).not.toBeInTheDocument()
    await waitFor(() => {
      expect(navigationLog.filter((entry) => entry === '/login')).toHaveLength(
        1,
      )
    })
    expect(navigationLog).not.toContain('/login?redirectTo=%2Fprojects')
  })

  it('disables Sign out and sends one request when clicked twice', async () => {
    authMock.getSession.mockResolvedValue({
      session: makeSession('dev@example.com'),
      error: null,
    })
    const pending = deferred<AuthOperationResult>()
    authMock.signOut.mockReturnValue(pending.promise)
    const navigationLog: string[] = []

    renderApp({ initialEntries: ['/projects'], navigationLog })
    await screen.findByRole('heading', { name: 'Projects' })

    fireEvent.click(screen.getByRole('button', { name: 'Sign out' }))

    const pendingButton = screen.getByRole('button', {
      name: 'Signing out…',
    })
    expect(pendingButton).toBeDisabled()
    fireEvent.click(pendingButton)

    expect(authMock.signOut).toHaveBeenCalledTimes(1)

    await act(async () => {
      pending.resolve({ error: null })
    })

    await screen.findByRole('heading', { name: 'Sign in' })
    expect(authMock.signOut).toHaveBeenCalledTimes(1)
    await waitFor(() => {
      expect(navigationLog.filter((entry) => entry === '/login')).toHaveLength(
        1,
      )
    })
  })

  it('still signs out locally and lands on /login when the request fails', async () => {
    authMock.getSession.mockResolvedValue({
      session: makeSession('dev@example.com'),
      error: null,
    })
    authMock.signOut.mockResolvedValue({ error: 'network' })

    renderApp({ initialEntries: ['/projects'] })

    await screen.findByRole('heading', { name: 'Projects' })
    fireEvent.click(screen.getByRole('button', { name: 'Sign out' }))

    await screen.findByRole('heading', { name: 'Sign in' })

    expect(locationText()).toBe('/login')
    expect(screen.getAllByText('You have been signed out.')).toHaveLength(1)
    expect(
      screen.queryByRole('heading', { name: 'Projects' }),
    ).not.toBeInTheDocument()
  })

  it('ignores late auth events after an explicit sign-out', async () => {
    authMock.getSession.mockResolvedValue({
      session: makeSession('dev@example.com'),
      error: null,
    })
    const pending = deferred<AuthOperationResult>()
    authMock.signOut.mockReturnValue(pending.promise)

    renderApp({ initialEntries: ['/projects'] })
    await screen.findByRole('heading', { name: 'Projects' })

    fireEvent.click(screen.getByRole('button', { name: 'Sign out' }))

    act(() => {
      authMock.emitAuthEvent('SIGNED_IN', makeSession('dev@example.com'))
      authMock.emitAuthEvent('TOKEN_REFRESHED', makeSession('dev@example.com'))
    })

    expect(screen.getByRole('button', { name: 'Signing out…' })).toBeDisabled()

    await act(async () => {
      pending.resolve({ error: null })
    })

    await screen.findByRole('heading', { name: 'Sign in' })

    act(() => {
      authMock.emitAuthEvent('SIGNED_IN', makeSession('dev@example.com'))
      authMock.emitAuthEvent('TOKEN_REFRESHED', makeSession('dev@example.com'))
    })

    expect(locationText()).toBe('/login')
    expect(
      screen.queryByRole('heading', { name: 'Projects' }),
    ).not.toBeInTheDocument()
  })

  it('sends a signed-out hard reload of /projects back to /login', async () => {
    authMock.getSession.mockResolvedValue({
      session: makeSession('dev@example.com'),
      error: null,
    })
    authMock.signOut.mockResolvedValue({ error: null })

    const first = renderApp({ initialEntries: ['/projects'] })
    await screen.findByRole('heading', { name: 'Projects' })
    fireEvent.click(screen.getByRole('button', { name: 'Sign out' }))
    await screen.findByRole('heading', { name: 'Sign in' })
    first.unmount()

    authMock.getSession.mockResolvedValue({ session: null, error: null })

    renderApp({ initialEntries: ['/projects'] })

    await waitForLocation('/login?redirectTo=%2Fprojects')
    expect(
      screen.queryByRole('heading', { name: 'Projects' }),
    ).not.toBeInTheDocument()
  })
})
