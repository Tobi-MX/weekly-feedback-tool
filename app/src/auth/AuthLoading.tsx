/**
 * The single loading view used while the auth session is being restored or a
 * magic link is being consumed. It never renders protected content or the
 * login form.
 */
export function AuthLoading() {
  return (
    <p
      role="status"
      aria-live="polite"
      className="text-sm text-muted-foreground"
    >
      Loading…
    </p>
  )
}

/**
 * Full-screen variant for places that are not already inside a layout's main
 * (session restore and sign-out). The public layout supplies its own main.
 */
export function AuthLoadingScreen() {
  return (
    <main className="flex min-h-screen items-center justify-center bg-background px-4 text-foreground">
      <AuthLoading />
    </main>
  )
}

export default AuthLoading
