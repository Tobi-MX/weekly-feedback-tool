/**
 * Shown on public and protected routes when the public Supabase environment
 * values are missing or invalid. It deliberately renders in place of a
 * redirect so an unconfigured app cannot bounce between /login and a
 * protected route.
 */
export function AuthConfigurationNotice() {
  return (
    <section
      aria-labelledby="auth-configuration-heading"
      className="mt-4 space-y-2 rounded-md border border-destructive/30 bg-destructive/5 p-4 text-sm"
    >
      <h2 id="auth-configuration-heading" className="font-semibold">
        Sign-in is not configured
      </h2>
      <p>
        Supabase authentication is not configured, so sign-in is unavailable.
        Copy <code>app/.env.example</code> to <code>app/.env.local</code>, fill
        in the local values, and restart the dev server. See{' '}
        <code>_docs/local-development.md</code> for the full setup steps.
      </p>
    </section>
  )
}

export default AuthConfigurationNotice
