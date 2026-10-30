import { act, fireEvent, screen, waitFor } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import type { AuthSessionResult } from './authClient'
import { authMock, deferred, makeSession } from '../test/authMock'
import { renderApp } from '../test/renderApp'

const ACCESS_TOKEN = 'secret-access-token-abc123'
const REFRESH_TOKEN = 'secret-refresh-token-def456'

function locationText(): string {
  return screen.getByTestId('location').textContent ?? ''
}

function callbackHash(): string {
  return `#access_token=${ACCESS_TOKEN}&refresh_token=${REFRESH_TOKEN}&type=magiclink`
}

function callbackUrl(redirectTo = '/projects'): string {
  return `/auth/callback?redirectTo=${encodeURIComponent(redirectTo)}${callbackHash()}`
}

function expectNoSecrets(value: string): void {
  expect(value).not.toContain(ACCESS_TOKEN)
  expect(value).not.toContain(REFRESH_TOKEN)
}

describe('AuthCallbackPage', () => {
  it('shows only a loading view while consuming the link', async () => {
    const pending = deferred<AuthSessionResult>()
    authMock.setSession.mockReturnValue(pending.promise)

    renderApp({ initialEntries: [callbackUrl()] })

    await waitFor(() => {
      expect(authMock.setSession).toHaveBeenCalledTimes(1)
    })

    expect(screen.getByText('Loading…')).toBeInTheDocument()
    expect(screen.queryByLabelText('Email')).not.toBeInTheDocument()
    expect(
      screen.queryByRole('heading', { name: 'Projects' }),
    ).not.toBeInTheDocument()

    await act(async () => {
      pending.resolve({ session: makeSession('dev@example.com'), error: null })
    })

    await waitFor(() => {
      expect(locationText()).toBe('/projects')
    })
  })

  it('establishes a session once and lands on the validated target', async () => {
    authMock.setSession.mockResolvedValue({
      session: makeSession('dev@example.com'),
      error: null,
    })
    const navigationLog: string[] = []
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined)
    const errorSpy = vi
      .spyOn(console, 'error')
      .mockImplementation(() => undefined)

    const { container } = renderApp({
      initialEntries: [callbackUrl('/projects/1?tab=members')],
      navigationLog,
    })

    expectNoSecrets(container.textContent ?? '')

    await waitFor(() => {
      expect(locationText()).toBe('/projects/1?tab=members')
    })

    expect(authMock.setSession).toHaveBeenCalledTimes(1)
    expect(authMock.setSession).toHaveBeenCalledWith(
      ACCESS_TOKEN,
      REFRESH_TOKEN,
    )

    expectNoSecrets(container.textContent ?? '')
    expectNoSecrets(document.body.textContent ?? '')
    expectNoSecrets(navigationLog.join(' '))
    expectNoSecrets(
      JSON.stringify([...logSpy.mock.calls, ...errorSpy.mock.calls]),
    )
  })

  it('cleans callback credentials from the URL and history on success', async () => {
    authMock.setSession.mockResolvedValue({
      session: makeSession('dev@example.com'),
      error: null,
    })
    const navigationLog: string[] = []

    renderApp({
      initialEntries: [callbackUrl('/projects')],
      navigationLog,
    })

    await waitFor(() => {
      expect(locationText()).toBe('/projects')
    })

    expect(navigationLog.join(' ')).not.toContain(ACCESS_TOKEN)
    expect(navigationLog.join(' ')).not.toContain(REFRESH_TOKEN)
    expect(navigationLog).toContain('/projects')
  })

  it('lands on /projects without consuming the link when a session exists', async () => {
    authMock.getSession.mockResolvedValue({
      session: makeSession('dev@example.com'),
      error: null,
    })

    renderApp({ initialEntries: [callbackUrl('/projects')] })

    await waitFor(() => {
      expect(locationText()).toBe('/projects')
    })

    expect(authMock.setSession).not.toHaveBeenCalled()
    expect(screen.queryByText(/invalid or has expired/)).not.toBeInTheDocument()
  })

  it('does not consume the link twice on a reload with an existing session', async () => {
    authMock.getSession.mockResolvedValue({ session: null, error: null })
    authMock.setSession.mockResolvedValue({
      session: makeSession('dev@example.com'),
      error: null,
    })

    const first = renderApp({ initialEntries: [callbackUrl('/projects')] })
    await waitFor(() => {
      expect(locationText()).toBe('/projects')
    })
    expect(authMock.setSession).toHaveBeenCalledTimes(1)
    first.unmount()

    authMock.getSession.mockResolvedValue({
      session: makeSession('dev@example.com'),
      error: null,
    })

    renderApp({ initialEntries: [callbackUrl('/projects')] })
    await waitFor(() => {
      expect(locationText()).toBe('/projects')
    })

    expect(authMock.setSession).toHaveBeenCalledTimes(1)
    expect(screen.queryByText(/invalid or has expired/)).not.toBeInTheDocument()
  })

  it('runs setSession and the resulting navigation once under StrictMode', async () => {
    authMock.setSession.mockResolvedValue({
      session: makeSession('dev@example.com'),
      error: null,
    })
    const navigationLog: string[] = []

    renderApp({
      initialEntries: [callbackUrl('/projects')],
      navigationLog,
      strictMode: true,
    })

    await waitFor(() => {
      expect(locationText()).toBe('/projects')
    })

    expect(authMock.setSession).toHaveBeenCalledTimes(1)
    expect(navigationLog.filter((entry) => entry === '/projects')).toHaveLength(
      1,
    )

    act(() => {
      authMock.emitAuthEvent('SIGNED_IN', makeSession('dev@example.com'))
    })

    expect(locationText()).toBe('/projects')
    expect(navigationLog.filter((entry) => entry === '/projects')).toHaveLength(
      1,
    )
  })

  it.each([
    [
      'error parameters in the hash',
      '/auth/callback?redirectTo=%2Fprojects%3Ftab%3Dmembers#error=access_denied&error_code=otp_expired&error_description=Email+link+is+invalid+or+has+expired',
    ],
    [
      'error parameters in the query',
      '/auth/callback?code=code123&error=access_denied&error_code=otp_expired&error_description=Bad+link&redirectTo=%2Fprojects%3Ftab%3Dmembers',
    ],
    [
      'no credentials at all',
      '/auth/callback?redirectTo=%2Fprojects%3Ftab%3Dmembers',
    ],
  ])('shows one invalid-link notice for %s', async (_label, entry) => {
    renderApp({ initialEntries: [entry] })

    await waitFor(() => {
      expect(locationText()).toBe(
        '/login?redirectTo=%2Fprojects%3Ftab%3Dmembers',
      )
    })

    expect(authMock.setSession).not.toHaveBeenCalled()
    const notices = screen.getAllByText(
      /This sign-in link is invalid or has expired/,
    )
    expect(notices).toHaveLength(1)
    expect(screen.getByLabelText('Email')).toBeInTheDocument()
    expect(locationText()).not.toContain('error')
    expect(locationText()).not.toContain('code123')
    expect(document.body.textContent).not.toContain('Bad link')
    expect(document.body.textContent).not.toContain('code123')
  })

  it('shows the same notice for a used or malformed token', async () => {
    authMock.setSession.mockResolvedValue({
      session: null,
      error: 'invalid-link',
    })
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined)
    const errorSpy = vi
      .spyOn(console, 'error')
      .mockImplementation(() => undefined)

    const { container } = renderApp({
      initialEntries: [callbackUrl('/projects')],
    })

    await waitFor(() => {
      expect(locationText()).toBe('/login?redirectTo=%2Fprojects')
    })

    expect(authMock.setSession).toHaveBeenCalledTimes(1)
    expect(
      screen.getAllByText(/This sign-in link is invalid or has expired/),
    ).toHaveLength(1)
    expectNoSecrets(container.textContent ?? '')
    expectNoSecrets(document.body.textContent ?? '')
    expectNoSecrets(
      JSON.stringify([...logSpy.mock.calls, ...errorSpy.mock.calls]),
    )
  })

  it('keeps the intended redirectTo after a failed callback so a new link returns there', async () => {
    authMock.setSession.mockResolvedValue({
      session: null,
      error: 'invalid-link',
    })
    authMock.signInWithOtp.mockResolvedValue({ error: null })

    renderApp({
      initialEntries: [callbackUrl('/projects/1?tab=members')],
    })

    await waitFor(() => {
      expect(locationText()).toBe(
        '/login?redirectTo=%2Fprojects%2F1%3Ftab%3Dmembers',
      )
    })

    fireEvent.change(screen.getByLabelText('Email'), {
      target: { value: 'dev@example.com' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Send sign-in link' }))

    await waitFor(() => {
      expect(authMock.signInWithOtp).toHaveBeenCalledTimes(1)
    })

    const [, emailRedirectTo] = authMock.signInWithOtp.mock.calls[0]
    expect(new URL(emailRedirectTo).searchParams.get('redirectTo')).toBe(
      '/projects/1?tab=members',
    )
  })

  it.each([
    ['/projects', '/projects'],
    ['/projects?tab=members', '/projects?tab=members'],
    ['/projects/1?tab=members', '/projects/1?tab=members'],
    ['https://evil.example', '/projects'],
    ['//evil.example', '/projects'],
    ['/\\evil.example', '/projects'],
    ['javascript:alert(1)', '/projects'],
    ['data:text/html,<h1>owned</h1>', '/projects'],
    ['projects', '/projects'],
    ['', '/projects'],
    ['/login', '/projects'],
    ['/auth/callback', '/projects'],
    ['%2F%2Fevil.example', '/projects'],
    ['https%3A%2F%2Fevil.example', '/projects'],
  ])('navigates safely for redirectTo %j', async (redirectTo, expected) => {
    authMock.setSession.mockResolvedValue({
      session: makeSession('dev@example.com'),
      error: null,
    })

    renderApp({
      initialEntries: [
        `/auth/callback?redirectTo=${encodeURIComponent(redirectTo)}${callbackHash()}`,
      ],
    })

    await waitFor(() => {
      expect(locationText()).toBe(expected)
    })
  })

  it('accepts implicit-flow tokens from the query string as well', async () => {
    authMock.setSession.mockResolvedValue({
      session: makeSession('dev@example.com'),
      error: null,
    })

    renderApp({
      initialEntries: [
        `/auth/callback?access_token=${ACCESS_TOKEN}&refresh_token=${REFRESH_TOKEN}&redirectTo=%2Fprojects`,
      ],
    })

    await waitFor(() => {
      expect(locationText()).toBe('/projects')
    })

    expect(authMock.setSession).toHaveBeenCalledWith(
      ACCESS_TOKEN,
      REFRESH_TOKEN,
    )
  })
})
