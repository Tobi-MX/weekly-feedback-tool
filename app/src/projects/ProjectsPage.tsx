import { useState } from 'react'
import { useAuth } from '../auth/AuthProvider'

/**
 * Minimal protected placeholder for this task. The real project list and app
 * shell are #6's work; this screen only proves the authenticated route and the
 * sign-out path.
 */
export function ProjectsPage() {
  const { user, signOut, isSigningOut } = useAuth()
  const [pending, setPending] = useState(false)

  const handleSignOut = async () => {
    if (pending) {
      return
    }
    setPending(true)
    await signOut()
  }

  const disabled = pending || isSigningOut

  return (
    <section aria-labelledby="projects-heading">
      <h2 id="projects-heading">Projects</h2>
      <p>Signed in as {user?.email ?? 'unknown user'}.</p>
      <button
        type="button"
        onClick={() => {
          void handleSignOut()
        }}
        disabled={disabled}
      >
        {disabled ? 'Signing out…' : 'Sign out'}
      </button>
    </section>
  )
}

export default ProjectsPage
