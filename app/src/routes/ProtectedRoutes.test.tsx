import { act, fireEvent, screen, waitFor, within } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import type { AuthOperationResult, AuthSessionResult } from '../auth/authClient'
import { queryClient } from '../lib/queryClient'
import { profileQueryKey } from '../profile/useProfile'
import {
  authMock,
  deferred,
  makeSession,
  mockEmptySession,
  mockRestoredSession,
} from '../test/authMock'
import { profileMock } from '../test/profileMock'
import { renderApp } from '../test/renderApp'

function locationText(): string {
  return screen.getByTestId('location').textContent ?? ''
}

async function waitForLocation(path: string): Promise<void> {
  await waitFor(() => {
    expect(locationText()).toBe(path)
  })
}

function openUserMenu(): HTMLElement {
  const trigger = screen.getByRole('button', { name: /Account menu for/ })
  fireEvent.pointerDown(trigger, { button: 0, ctrlKey: false })
  return trigger
}

function signOutItem(): HTMLElement {
  return screen.getByRole('menuitem', { name: /^Sign out$/ })
}

async function clickSignOut(): Promise<void> {
  openUserMenu()
  fireEvent.click(await screen.findByRole('menuitem', { name: /^Sign out$/ }))
}

describe('protected routes', () => {
  it('shows one stable loading view without protected or login content', () => {
    const restore = deferred<AuthSessionResult>()
    authMock.getSession.mockReturnValue(restore.promise)

    renderApp({ initialEntries: ['/projects'] })

    expect(screen.getByRole('main')).toBeInTheDocument()
    expect(screen.getAllByText('Loading…')).toHaveLength(1)
    expect(screen.getByText('Loading…')).toHaveAttribute('role', 'status')
    expect(screen.queryByRole('banner')).not.toBeInTheDocument()
    expect(
      screen.queryByRole('navigation', { name: 'Primary' }),
    ).not.toBeInTheDocument()
    expect(
      screen.queryByRole('heading', { name: 'Projects' }),
    ).not.toBeInTheDocument()
    expect(screen.queryByLabelText('Email')).not.toBeInTheDocument()
    expect(profileMock.fetchProfileDisplayName).not.toHaveBeenCalled()
  })

  it('keeps the loading view until a deferred session resolves', async () => {
    const restore = deferred<AuthSessionResult>()
    authMock.getSession.mockReturnValue(restore.promise)

    renderApp({ initialEntries: ['/projects'] })

    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 25))
    })

    expect(screen.getByText('Loading…')).toBeInTheDocument()
    expect(screen.queryByLabelText('Email')).not.toBeInTheDocument()
    expect(screen.queryByRole('banner')).not.toBeInTheDocument()

    await act(async () => {
      restore.resolve({ session: makeSession('dev@example.com'), error: null })
    })

    expect(
      await screen.findByRole('heading', { name: 'Projects' }),
    ).toBeInTheDocument()
    expect(screen.queryByText('Loading…')).not.toBeInTheDocument()
  })

  it('redirects a signed-out visitor and preserves path and query exactly once', async () => {
    mockEmptySession()
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
    await waitFor(() => {
      expect(navigationLog).toContain(
        '/login?redirectTo=%2Fprojects%3Ftab%3Dmembers',
      )
      expect(
        navigationLog.filter((entry) => entry.startsWith('/login')),
      ).toHaveLength(1)
    })
  })

  it('renders a protected route directly for a signed-in user', async () => {
    mockRestoredSession()
    profileMock.fetchProfileDisplayName.mockResolvedValue('Dev User')
    const navigationLog: string[] = []

    renderApp({ initialEntries: ['/projects'], navigationLog })

    expect(
      await screen.findByRole('heading', { name: 'Projects' }),
    ).toBeInTheDocument()
    expect(screen.getAllByRole('banner')).toHaveLength(1)
    expect(screen.getAllByRole('main')).toHaveLength(1)
    expect(
      screen.getByRole('navigation', { name: 'Primary' }),
    ).toBeInTheDocument()
    expect(
      screen.getByRole('link', { name: 'Weekly Feedback Tool' }),
    ).toHaveAttribute('href', '/projects')
    expect(
      await screen.findByRole('button', { name: /Account menu for Dev User/ }),
    ).toBeInTheDocument()
    expect(
      within(screen.getByRole('main')).queryByRole('button', {
        name: /sign out/i,
      }),
    ).not.toBeInTheDocument()
    expect(screen.queryByLabelText('Email')).not.toBeInTheDocument()
    expect(screen.queryByText(/Backend status:/)).not.toBeInTheDocument()
    expect(profileMock.fetchProfileDisplayName).toHaveBeenCalledWith('user-1')
    await waitFor(() => {
      expect(navigationLog).toContain('/projects')
    })
    expect(navigationLog).not.toContain('/login')
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
    await waitFor(() => {
      expect(navigationLog).toContain('/projects')
    })
    expect(
      navigationLog.filter((entry) => entry.startsWith('/login')),
    ).toHaveLength(0)
  })

  it('shows the configuration notice in the public layout when unconfigured', async () => {
    authMock.isSupabaseConfigured = false
    const navigationLog: string[] = []

    renderApp({ initialEntries: ['/projects'], navigationLog })

    expect(
      screen.getByRole('heading', { name: 'Sign-in is not configured' }),
    ).toBeInTheDocument()
    expect(screen.getByText(/_docs\/local-development\.md/)).toBeInTheDocument()
    expect(
      screen.getByRole('link', { name: 'Weekly Feedback Tool' }),
    ).toBeInTheDocument()
    expect(screen.getAllByRole('main')).toHaveLength(1)
    expect(screen.queryByRole('navigation')).not.toBeInTheDocument()
    expect(
      screen.queryByRole('button', { name: /Account menu/ }),
    ).not.toBeInTheDocument()
    expect(locationText()).toBe('/projects')
    await waitFor(() => {
      expect(navigationLog).toContain('/projects')
    })
    expect(navigationLog).not.toContain('/login')
    expect(authMock.getSession).not.toHaveBeenCalled()
    expect(profileMock.fetchProfileDisplayName).not.toHaveBeenCalled()
    expect(screen.queryByLabelText('Email')).not.toBeInTheDocument()
    expect(screen.getByText(/Backend status:/)).toBeInTheDocument()
  })

  it('redirects / to /projects and then through the guard', async () => {
    mockEmptySession()
    const navigationLog: string[] = []

    renderApp({ initialEntries: ['/'], navigationLog })

    await waitForLocation('/login?redirectTo=%2Fprojects')
    await waitFor(() => {
      expect(navigationLog).toContain('/login?redirectTo=%2Fprojects')
      expect(
        navigationLog.filter((value) => value.startsWith('/login')),
      ).toHaveLength(1)
    })
  })

  it('sends a signed-out unmatched path back to itself after sign-in', async () => {
    mockEmptySession()
    const navigationLog: string[] = []

    renderApp({ initialEntries: ['/unknown/place?tab=old'], navigationLog })

    await waitForLocation('/login?redirectTo=%2Funknown%2Fplace%3Ftab%3Dold')

    act(() => {
      authMock.emitAuthEvent('SIGNED_IN', makeSession('dev@example.com'))
    })

    expect(
      await screen.findByRole('heading', { name: 'Page not found' }),
    ).toBeInTheDocument()
    expect(locationText()).toBe('/unknown/place?tab=old')
    expect(screen.queryByLabelText('Email')).not.toBeInTheDocument()
  })

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
    await waitFor(() => {
      expect(navigationLog).toContain(
        '/login?redirectTo=%2Fprojects%3Ftab%3Dmembers',
      )
      expect(
        navigationLog.filter((entry) => entry.startsWith('/login')),
      ).toHaveLength(1)
    })

    await act(async () => {
      await Promise.resolve()
    })

    expect(locationText()).toBe('/login?redirectTo=%2Fprojects%3Ftab%3Dmembers')
    expect(screen.queryByText('Loading…')).not.toBeInTheDocument()
  })

  it('signs out from the user menu, clears protected content, and shows one confirmation', async () => {
    mockRestoredSession()
    profileMock.fetchProfileDisplayName.mockResolvedValue('Dev User')
    authMock.signOut.mockResolvedValue({ error: null })
    const navigationLog: string[] = []

    renderApp({ initialEntries: ['/projects'], navigationLog })

    await screen.findByRole('heading', { name: 'Projects' })
    await waitFor(() => {
      expect(
        queryClient.getQueryCache().find({
          queryKey: profileQueryKey('user-1'),
        }),
      ).toBeDefined()
    })

    openUserMenu()

    const menu = await screen.findByRole('menu')
    expect(within(menu).getByText('Dev User')).toBeInTheDocument()
    expect(within(menu).getByText('dev@example.com')).toBeInTheDocument()
    expect(within(menu).getAllByRole('menuitem')).toHaveLength(1)
    expect(signOutItem()).toHaveTextContent('Sign out')

    fireEvent.click(signOutItem())

    await screen.findByRole('heading', { name: 'Sign in' })

    expect(authMock.signOut).toHaveBeenCalledTimes(1)
    expect(locationText()).toBe('/login')
    expect(screen.getAllByText('You have been signed out.')).toHaveLength(1)
    expect(await screen.findByText('Signed out', { exact: true })).toBeVisible()
    expect(
      screen.queryByRole('heading', { name: 'Projects' }),
    ).not.toBeInTheDocument()
    expect(
      screen.queryByRole('navigation', { name: 'Primary' }),
    ).not.toBeInTheDocument()
    await waitFor(() => {
      expect(
        queryClient.getQueryCache().find({
          queryKey: profileQueryKey('user-1'),
        }),
      ).toBeUndefined()
    })
    await waitFor(() => {
      expect(navigationLog.filter((entry) => entry === '/login')).toHaveLength(
        1,
      )
      expect(navigationLog).not.toContain('/login?redirectTo=%2Fprojects')
    })
  })

  it('disables Sign out and sends one request when activated twice', async () => {
    mockRestoredSession()
    const pending = deferred<AuthOperationResult>()
    authMock.signOut.mockReturnValue(pending.promise)
    const navigationLog: string[] = []

    renderApp({ initialEntries: ['/projects'], navigationLog })
    await screen.findByRole('heading', { name: 'Projects' })

    openUserMenu()
    const item = await screen.findByRole('menuitem', { name: /^Sign out$/ })
    fireEvent.click(item)

    const pendingItem = await screen.findByRole('menuitem', {
      name: 'Signing out…',
    })
    expect(pendingItem).toHaveAttribute('aria-disabled', 'true')
    fireEvent.click(pendingItem)

    expect(authMock.signOut).toHaveBeenCalledTimes(1)
    // AuthProvider keeps the restored session until signOut resolves, so the
    // shell stays put while the request is in flight; the menu item is the
    // only control that reflects the pending state.
    expect(locationText()).toBe('/projects')
    expect(
      screen.queryByRole('heading', { name: 'Sign in' }),
    ).not.toBeInTheDocument()

    await act(async () => {
      pending.resolve({ error: null })
    })

    await screen.findByRole('heading', { name: 'Sign in' })
    expect(authMock.signOut).toHaveBeenCalledTimes(1)
    expect(
      screen.queryByRole('heading', { name: 'Projects' }),
    ).not.toBeInTheDocument()
    await waitFor(() => {
      expect(navigationLog.filter((entry) => entry === '/login')).toHaveLength(
        1,
      )
    })
  })

  it('still signs out locally and lands on /login when the request fails', async () => {
    mockRestoredSession()
    authMock.signOut.mockResolvedValue({ error: 'network' })

    renderApp({ initialEntries: ['/projects'] })

    await screen.findByRole('heading', { name: 'Projects' })
    await clickSignOut()

    await screen.findByRole('heading', { name: 'Sign in' })

    expect(locationText()).toBe('/login')
    expect(screen.getAllByText('You have been signed out.')).toHaveLength(1)
    expect(await screen.findByText('Signed out', { exact: true })).toBeVisible()
    expect(
      screen.queryByRole('heading', { name: 'Projects' }),
    ).not.toBeInTheDocument()
  })

  it('ignores late auth events after an explicit sign-out', async () => {
    mockRestoredSession()
    const pending = deferred<AuthOperationResult>()
    authMock.signOut.mockReturnValue(pending.promise)

    renderApp({ initialEntries: ['/projects'] })
    await screen.findByRole('heading', { name: 'Projects' })

    openUserMenu()
    fireEvent.click(await screen.findByRole('menuitem', { name: /^Sign out$/ }))

    await screen.findByRole('menuitem', { name: 'Signing out…' })
    expect(authMock.signOut).toHaveBeenCalledTimes(1)

    act(() => {
      authMock.emitAuthEvent('SIGNED_IN', makeSession('dev@example.com'))
      authMock.emitAuthEvent('TOKEN_REFRESHED', makeSession('dev@example.com'))
    })

    // The in-flight explicit sign-out wins over late auth events.
    expect(locationText()).toBe('/projects')
    expect(
      screen.queryByRole('heading', { name: 'Sign in' }),
    ).not.toBeInTheDocument()

    await act(async () => {
      pending.resolve({ error: null })
    })

    await screen.findByRole('heading', { name: 'Sign in' })
    expect(
      screen.queryByRole('heading', { name: 'Projects' }),
    ).not.toBeInTheDocument()

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
    mockRestoredSession()
    authMock.signOut.mockResolvedValue({ error: null })

    const first = renderApp({ initialEntries: ['/projects'] })
    await screen.findByRole('heading', { name: 'Projects' })
    await clickSignOut()
    await screen.findByRole('heading', { name: 'Sign in' })
    first.unmount()

    mockEmptySession()

    renderApp({ initialEntries: ['/projects'] })

    await waitForLocation('/login?redirectTo=%2Fprojects')
    expect(
      screen.queryByRole('heading', { name: 'Projects' }),
    ).not.toBeInTheDocument()
  })
})
