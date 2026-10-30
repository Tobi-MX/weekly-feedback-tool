import { act, screen, waitFor } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import type { AuthSessionResult } from '../auth/authClient'
import { authMock, deferred, mockEmptySession } from '../test/authMock'
import { renderApp } from '../test/renderApp'

describe('PublicLayout', () => {
  it('wraps /login in one main with the product name and no signed-in controls', async () => {
    mockEmptySession()

    renderApp({ initialEntries: ['/login'] })

    expect(await screen.findByLabelText('Email')).toBeInTheDocument()
    expect(screen.getAllByRole('banner')).toHaveLength(1)
    expect(screen.getAllByRole('main')).toHaveLength(1)
    expect(
      screen.getByRole('link', { name: 'Weekly Feedback Tool' }),
    ).toHaveAttribute('href', '/projects')
    expect(
      screen.queryByRole('navigation', { name: 'Primary' }),
    ).not.toBeInTheDocument()
    expect(
      screen.queryByRole('button', { name: /Account menu/ }),
    ).not.toBeInTheDocument()
    expect(
      screen.queryByRole('button', { name: /sign out/i }),
    ).not.toBeInTheDocument()
    expect(screen.getByText(/Backend status:/)).toBeInTheDocument()
    expect(
      screen.queryByRole('heading', { name: 'Projects' }),
    ).not.toBeInTheDocument()
  })

  it('wraps /auth/callback in the same public layout while the link is consumed', async () => {
    mockEmptySession()
    const pending = deferred<AuthSessionResult>()
    authMock.setSession.mockReturnValue(pending.promise)

    renderApp({
      initialEntries: [
        '/auth/callback?access_token=test-access-token&refresh_token=test-refresh-token',
      ],
    })

    await waitFor(() => {
      expect(authMock.setSession).toHaveBeenCalledTimes(1)
    })

    expect(screen.getByText('Loading…')).toHaveAttribute('role', 'status')
    expect(screen.getAllByRole('main')).toHaveLength(1)
    expect(screen.getAllByRole('banner')).toHaveLength(1)
    expect(
      screen.getByRole('link', { name: 'Weekly Feedback Tool' }),
    ).toBeInTheDocument()
    expect(
      screen.queryByRole('navigation', { name: 'Primary' }),
    ).not.toBeInTheDocument()
    expect(
      screen.queryByRole('button', { name: /Account menu/ }),
    ).not.toBeInTheDocument()
    expect(screen.getByText(/Backend status:/)).toBeInTheDocument()
    expect(document.body.textContent).not.toContain('test-access-token')
    expect(document.body.textContent).not.toContain('test-refresh-token')

    await act(async () => {
      pending.resolve({ session: null, error: 'invalid-link' })
    })
    await screen.findByLabelText('Email')
  })
})
