import { useRef, useState } from 'react'
import type { FormEvent } from 'react'
import { Navigate, useLocation } from 'react-router-dom'
import { useAuth } from './AuthProvider'
import type { AuthErrorCode } from './authClient'
import AuthConfigurationNotice from './AuthConfigurationNotice'
import AuthLoading from './AuthLoading'
import { safeRedirectPath } from './redirectPath'

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

const SIGN_IN_ERROR_MESSAGES: Record<AuthErrorCode, string> = {
  network:
    'Could not send the sign-in link. Check your connection and try again.',
  'rate-limit':
    'Too many sign-in emails were requested. Wait about an hour, then try again.',
  'invalid-email': 'That email address was rejected. Check it and try again.',
  'invalid-link':
    'That sign-in link is invalid or has expired. Request a new link.',
  'session-expired': 'Your session expired. Sign in again.',
  unknown: 'Could not send the sign-in link. Please try again.',
}

function hasInvalidLinkState(state: unknown): boolean {
  if (typeof state !== 'object' || state === null) {
    return false
  }
  return (state as Record<string, unknown>).authError === 'invalid-link'
}

export function LoginPage() {
  const { status, signedOutReason, signInWithMagicLink } = useAuth()
  const location = useLocation()
  const redirectToParam = new URLSearchParams(location.search).get('redirectTo')
  const redirectTarget = safeRedirectPath(redirectToParam)

  const [email, setEmail] = useState('')
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [success, setSuccess] = useState<string | null>(null)
  const [invalidLinkAcknowledged, setInvalidLinkAcknowledged] = useState(false)
  const pendingRef = useRef(false)

  const invalidLink =
    hasInvalidLinkState(location.state) && !invalidLinkAcknowledged

  if (status === 'loading') {
    return <AuthLoading />
  }

  if (status === 'authenticated') {
    return <Navigate to={redirectTarget} replace />
  }

  const statusMessage = pending
    ? 'Sending sign-in link…'
    : (success ??
      (error || invalidLink
        ? ''
        : signedOutReason === 'expired'
          ? 'Your session expired. Sign in again.'
          : signedOutReason === 'signed-out'
            ? 'You have been signed out.'
            : ''))

  const alertMessage =
    error ??
    (invalidLink
      ? 'This sign-in link is invalid or has expired. Request a new link below.'
      : '')

  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()

    if (pendingRef.current || status === 'unconfigured') {
      return
    }

    const trimmedEmail = email.trim()
    if (!EMAIL_PATTERN.test(trimmedEmail)) {
      setError('Enter a valid email address.')
      setSuccess(null)
      return
    }

    pendingRef.current = true
    setPending(true)
    setError(null)
    setSuccess(null)
    setInvalidLinkAcknowledged(true)

    try {
      const result = await signInWithMagicLink(
        trimmedEmail,
        redirectToParam ?? undefined,
      )

      if (result.ok) {
        setSuccess('Check your email for a sign-in link.')
      } else {
        setError(SIGN_IN_ERROR_MESSAGES[result.error ?? 'unknown'])
      }
    } catch {
      setError(SIGN_IN_ERROR_MESSAGES.unknown)
    } finally {
      pendingRef.current = false
      setPending(false)
    }
  }

  return (
    <section aria-labelledby="login-heading">
      <h2 id="login-heading">Sign in</h2>

      {status === 'unconfigured' && <AuthConfigurationNotice />}

      <form onSubmit={handleSubmit} noValidate>
        <label htmlFor="login-email">Email</label>
        <input
          id="login-email"
          name="email"
          type="email"
          autoComplete="email"
          value={email}
          aria-invalid={error !== null}
          aria-describedby={error ? 'login-error' : undefined}
          onChange={(event) => {
            setEmail(event.target.value)
            if (error) {
              setError(null)
            }
          }}
        />
        <button type="submit" disabled={pending || status === 'unconfigured'}>
          {pending ? 'Sending…' : 'Send sign-in link'}
        </button>
      </form>

      <p id="login-status" role="status" aria-live="polite">
        {statusMessage}
      </p>
      <p id="login-error" role="alert">
        {alertMessage}
      </p>
    </section>
  )
}

export default LoginPage
