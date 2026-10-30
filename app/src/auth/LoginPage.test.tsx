import { act, fireEvent, screen, waitFor } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import type {
  AuthErrorCode,
  AuthOperationResult,
  AuthSessionResult,
} from './authClient'
import { authMock, deferred, makeSession } from '../test/authMock'
import { renderApp } from '../test/renderApp'

async function renderLogin(path = '/login'): Promise<HTMLInputElement> {
  renderApp({ initialEntries: [path] })
  return screen.findByLabelText<HTMLInputElement>('Email')
}

function submitButton(): HTMLElement {
  return screen.getByRole('button', { name: /Send sign-in link|Sending/ })
}

function loginStatus(): HTMLElement {
  return document.getElementById('login-status') as HTMLElement
}

function loginAlert(): HTMLElement {
  return document.getElementById('login-error') as HTMLElement
}

describe('LoginPage', () => {
  it('shows the configuration notice and disables submit when unconfigured', async () => {
    authMock.isSupabaseConfigured = false

    renderApp({ initialEntries: ['/login'] })

    expect(
      await screen.findByRole('heading', { name: 'Sign-in is not configured' }),
    ).toBeInTheDocument()
    expect(screen.getByText(/_docs\/local-development\.md/)).toBeInTheDocument()
    expect(submitButton()).toBeDisabled()
    expect(authMock.getSession).not.toHaveBeenCalled()
    expect(authMock.signInWithOtp).not.toHaveBeenCalled()
  })

  it.each(['', '   ', 'not-an-email', 'a@'])(
    'shows an inline error and sends nothing for %j',
    async (value) => {
      const input = await renderLogin()

      fireEvent.change(input, { target: { value } })
      fireEvent.click(submitButton())

      // Browsers sanitize an email input, so a whitespace-only value is stored
      // as an empty string; any other typed value is preserved.
      expect(input).toHaveValue(value.trim() ? value : '')
      expect(input).toHaveAttribute('aria-invalid', 'true')
      expect(input).toHaveAttribute('aria-describedby', 'login-error')
      expect(loginAlert()).toHaveTextContent('Enter a valid email address.')
      expect(authMock.signInWithOtp).not.toHaveBeenCalled()
    },
  )

  it('trims a valid email and sends one absolute callback redirect', async () => {
    authMock.signInWithOtp.mockResolvedValue({ error: null })
    const input = await renderLogin()

    fireEvent.change(input, { target: { value: '  dev@example.com  ' } })
    fireEvent.click(submitButton())

    await waitFor(() => {
      expect(authMock.signInWithOtp).toHaveBeenCalledTimes(1)
    })

    const [email, emailRedirectTo] = authMock.signInWithOtp.mock.calls[0]
    const callbackUrl = new URL(emailRedirectTo)

    expect(email).toBe('dev@example.com')
    expect(callbackUrl.origin).toBe(window.location.origin)
    expect(callbackUrl.pathname).toBe('/auth/callback')
    expect(callbackUrl.searchParams.get('redirectTo')).toBeNull()

    await waitFor(() => {
      expect(loginStatus()).toHaveTextContent(
        'Check your email for a sign-in link.',
      )
    })
    expect(loginStatus()).toHaveAttribute('role', 'status')
  })

  it('carries a validated redirectTo into the email link', async () => {
    authMock.signInWithOtp.mockResolvedValue({ error: null })
    const input = await renderLogin(
      '/login?redirectTo=%2Fprojects%3Ftab%3Dmembers',
    )

    fireEvent.change(input, { target: { value: 'dev@example.com' } })
    fireEvent.click(submitButton())

    await waitFor(() => {
      expect(authMock.signInWithOtp).toHaveBeenCalledTimes(1)
    })

    const [, emailRedirectTo] = authMock.signInWithOtp.mock.calls[0]
    const callbackUrl = new URL(emailRedirectTo)

    expect(callbackUrl.searchParams.get('redirectTo')).toBe(
      '/projects?tab=members',
    )
    expect(screen.getByTestId('location')).toHaveTextContent(
      '/login?redirectTo=%2Fprojects%3Ftab%3Dmembers',
    )
  })

  it('falls back to /projects for an unsafe redirectTo', async () => {
    authMock.signInWithOtp.mockResolvedValue({ error: null })
    const input = await renderLogin(
      '/login?redirectTo=https%3A%2F%2Fevil.example',
    )

    fireEvent.change(input, { target: { value: 'dev@example.com' } })
    fireEvent.click(submitButton())

    await waitFor(() => {
      expect(authMock.signInWithOtp).toHaveBeenCalledTimes(1)
    })

    const [, emailRedirectTo] = authMock.signInWithOtp.mock.calls[0]
    expect(new URL(emailRedirectTo).searchParams.get('redirectTo')).toBe(
      '/projects',
    )
  })

  it('disables submit while pending and sends at most one request', async () => {
    const pending = deferred<AuthOperationResult>()
    authMock.signInWithOtp.mockReturnValue(pending.promise)
    const input = await renderLogin()

    fireEvent.change(input, { target: { value: 'dev@example.com' } })
    fireEvent.click(submitButton())

    const form = submitButton().closest('form') as HTMLFormElement
    fireEvent.submit(form)
    fireEvent.click(submitButton())

    expect(authMock.signInWithOtp).toHaveBeenCalledTimes(1)
    expect(submitButton()).toBeDisabled()
    expect(submitButton()).toHaveTextContent('Sending…')
    expect(loginStatus()).toHaveTextContent('Sending sign-in link…')
    expect(loginStatus()).toHaveAttribute('role', 'status')

    await act(async () => {
      pending.resolve({ error: null })
    })

    await waitFor(() => {
      expect(submitButton()).toBeEnabled()
    })
    expect(loginStatus()).toHaveTextContent(
      'Check your email for a sign-in link.',
    )
  })

  it('shows the same success message for known and unknown addresses', async () => {
    authMock.signInWithOtp.mockResolvedValue({ error: null })
    const input = await renderLogin()

    fireEvent.change(input, { target: { value: 'known@example.com' } })
    fireEvent.click(submitButton())
    await waitFor(() => {
      expect(loginStatus()).toHaveTextContent(
        'Check your email for a sign-in link.',
      )
    })
    const firstMessage = loginStatus().textContent

    fireEvent.change(input, { target: { value: 'unknown@example.com' } })
    fireEvent.click(submitButton())
    await waitFor(() => {
      expect(authMock.signInWithOtp).toHaveBeenCalledTimes(2)
    })
    expect(loginStatus().textContent).toBe(firstMessage)
  })

  it.each<[AuthErrorCode, RegExp]>([
    ['network', /Could not send the sign-in link/],
    ['rate-limit', /Too many sign-in emails/],
    ['invalid-email', /That email address was rejected/],
    ['unknown', /Could not send the sign-in link/],
  ])(
    'shows a readable message for a %s failure and keeps the email',
    async (error, message) => {
      authMock.signInWithOtp.mockResolvedValue({ error })
      const input = await renderLogin()

      fireEvent.change(input, { target: { value: 'dev@example.com' } })
      fireEvent.click(submitButton())

      await waitFor(() => {
        expect(loginAlert()).toHaveTextContent(message)
      })

      expect(loginAlert()).toHaveAttribute('role', 'alert')
      expect(loginAlert().textContent).not.toContain('{')
      expect(loginAlert().textContent).not.toContain('[object Object]')
      expect(input).toHaveValue('dev@example.com')
      expect(submitButton()).toBeEnabled()
      expect(loginStatus()).toHaveTextContent('')
    },
  )

  it('shows a readable message when the request throws', async () => {
    authMock.signInWithOtp.mockRejectedValue(new Error('boom'))
    const input = await renderLogin()

    fireEvent.change(input, { target: { value: 'dev@example.com' } })
    fireEvent.click(submitButton())

    await waitFor(() => {
      expect(loginAlert()).toHaveTextContent(
        'Could not send the sign-in link. Please try again.',
      )
    })
    expect(loginAlert()).not.toHaveTextContent('boom')
    expect(submitButton()).toBeEnabled()
  })

  it('keeps redirectTo through validation, failure, and success', async () => {
    const path = '/login?redirectTo=%2Fprojects%3Ftab%3Dmembers'
    const input = await renderLogin(path)

    fireEvent.change(input, { target: { value: 'not-an-email' } })
    fireEvent.click(submitButton())
    expect(screen.getByTestId('location')).toHaveTextContent(path)

    authMock.signInWithOtp.mockResolvedValue({ error: 'network' })
    fireEvent.change(input, { target: { value: 'dev@example.com' } })
    fireEvent.click(submitButton())
    await waitFor(() => {
      expect(loginAlert()).toHaveTextContent(/Could not send/)
    })
    expect(screen.getByTestId('location')).toHaveTextContent(path)
    expect(authMock.signInWithOtp).toHaveBeenCalledTimes(1)

    authMock.signInWithOtp.mockResolvedValue({ error: null })
    fireEvent.click(submitButton())
    await waitFor(() => {
      expect(loginStatus()).toHaveTextContent(
        'Check your email for a sign-in link.',
      )
    })
    expect(screen.getByTestId('location')).toHaveTextContent(path)
  })

  it('shows the loading view for a signed-in visitor and never the form', async () => {
    const restore = deferred<AuthSessionResult>()
    authMock.getSession.mockReturnValue(restore.promise)

    renderApp({ initialEntries: ['/login'] })

    expect(screen.getByText('Loading…')).toBeInTheDocument()
    expect(screen.queryByLabelText('Email')).not.toBeInTheDocument()

    await act(async () => {
      restore.resolve({ session: makeSession('dev@example.com'), error: null })
    })

    await waitFor(() => {
      expect(
        screen.getByRole('heading', { name: 'Projects' }),
      ).toBeInTheDocument()
    })
    expect(screen.getByTestId('location')).toHaveTextContent('/projects')
    expect(screen.queryByLabelText('Email')).not.toBeInTheDocument()
  })

  it('keeps the backend status visible on the login screen', async () => {
    await renderLogin()

    expect(screen.getByText(/Backend status:/)).toBeInTheDocument()
  })
})
