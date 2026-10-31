import { useCallback, useEffect, useRef, useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { isInviteToken, isMembersErrorCode } from './membersErrors'
import { useJoinProject } from './useMembers'

type JoinState = 'joining' | 'invalid' | 'expired' | 'error'

const INVALID_COPY =
  'This invite link is not valid. Ask the project owner for a new link.'
const EXPIRED_COPY =
  'This invite link has expired. Ask the project owner for a new link.'

export function JoinProjectPage() {
  const { token = '' } = useParams<{ token: string }>()
  const navigate = useNavigate()
  const { mutateAsync: join } = useJoinProject()
  const isWellFormed = isInviteToken(token)
  const [state, setState] = useState<JoinState>(
    isWellFormed ? 'joining' : 'invalid',
  )
  // StrictMode runs mount effects twice; the ref keeps it to one request, one
  // toast, and one navigation. The server is idempotent either way.
  const startedRef = useRef(false)

  const runJoin = useCallback(async () => {
    try {
      const result = await join(token)
      toast.success(
        result.alreadyMember
          ? `You're already a member of ${result.projectName}.`
          : `You joined ${result.projectName}.`,
      )
      // Replace so the invite token does not stay in browser history.
      void navigate(`/projects/${result.projectId}`, { replace: true })
    } catch (error) {
      if (isMembersErrorCode(error, 'invite_expired')) {
        setState('expired')
      } else if (isMembersErrorCode(error, 'invite_invalid')) {
        setState('invalid')
      } else {
        setState('error')
      }
    }
  }, [join, navigate, token])

  useEffect(() => {
    if (!isWellFormed || startedRef.current) {
      return
    }
    startedRef.current = true
    void runJoin()
  }, [isWellFormed, runJoin])

  return (
    <section className="space-y-4">
      {state === 'joining' ? (
        <p role="status" className="text-sm text-muted-foreground">
          Joining project…
        </p>
      ) : null}

      {state === 'invalid' || state === 'expired' ? (
        <div
          role="alert"
          className="space-y-3 rounded-lg border border-destructive/30 bg-card p-4 text-card-foreground"
        >
          <p className="text-sm">
            {state === 'expired' ? EXPIRED_COPY : INVALID_COPY}
          </p>
          <Link
            to="/projects"
            className="text-sm font-medium underline underline-offset-4"
          >
            Go to projects
          </Link>
        </div>
      ) : null}

      {state === 'error' ? (
        <div
          role="alert"
          className="space-y-3 rounded-lg border border-destructive/30 bg-card p-4 text-card-foreground"
        >
          <p className="text-sm">Could not join the project.</p>
          <Button
            type="button"
            variant="outline"
            onClick={() => {
              setState('joining')
              void runJoin()
            }}
          >
            Retry
          </Button>
        </div>
      ) : null}
    </section>
  )
}

export default JoinProjectPage
