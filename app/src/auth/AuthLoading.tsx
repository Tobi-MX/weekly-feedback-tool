/**
 * The single loading view used while the auth session is being restored or a
 * magic link is being consumed. It never renders protected content or the
 * login form.
 */
export function AuthLoading() {
  return (
    <p role="status" aria-live="polite">
      Loading…
    </p>
  )
}

export default AuthLoading
