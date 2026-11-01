import { useEffect, useId } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { useAuth } from '@/auth/AuthProvider'
import { Button } from '@/components/ui/button'
import { projectQueryKey } from '@/projects/useProjects'
import type { CycleSubmissionStatus } from './cyclesApi'
import { cyclesErrorCodeOf } from './cyclesErrors'
import {
  cycleStatusQueryKey,
  projectCyclesQueryKey,
  useCycleStatusQuery,
} from './useCycles'

const wrapText = 'min-w-0 break-words [overflow-wrap:anywhere]'

function cardsPhrase(n: number): string {
  return n === 1 ? '1 card' : `${n} cards`
}

/** "<S> of <M> members", singular when the project has one member. */
function membersPhrase(submitted: number, members: number): string {
  return `${submitted} of ${members} ${members === 1 ? 'member' : 'members'}`
}

/**
 * The block's lines. They are built only from the aggregate counts, so every
 * member, the facilitator included, sees the same text apart from their own
 * line.
 */
function statusLines(status: CycleSubmissionStatus): {
  readonly team: readonly string[]
  readonly mine: string
} {
  const members = membersPhrase(status.submittedMemberCount, status.memberCount)

  if (status.isRevealed) {
    const total =
      status.cardCount === null
        ? ''
        : `, ${cardsPhrase(status.cardCount)} in total`
    return {
      team: [
        `Feedback collection has ended. ${members} added feedback${total}.`,
      ],
      mine: `You added ${cardsPhrase(status.myCardCount)}.`,
    }
  }

  const verb = status.memberCount === 1 ? 'has' : 'have'
  const team = [`${members} ${verb} added feedback.`]
  if (status.submittedMemberCount === 0) {
    team.push('No one has added feedback yet.')
  }
  return {
    team,
    mine:
      status.myCardCount === 0
        ? 'You have not added feedback yet.'
        : `You have added ${cardsPhrase(status.myCardCount)}.`,
  }
}

interface SubmissionStatusProps {
  readonly projectId: string
  readonly cycleId: string
}

/**
 * The open cycle's "Submission status" block: aggregate counts only, never
 * names, per-member data, times, or card content, and no card total before
 * reveal. It is not live; it re-reads on mount, focus, reconnect, and Retry.
 */
export function SubmissionStatus({
  projectId,
  cycleId,
}: SubmissionStatusProps) {
  const { user } = useAuth()
  const userId = user?.id ?? null
  const queryClient = useQueryClient()
  const headingId = useId()
  const statusQuery = useCycleStatusQuery(cycleId)
  const lostAccess =
    cyclesErrorCodeOf(statusQuery.error) === 'not_project_member'

  // TanStack re-reads on visibilitychange; also re-read when the window
  // itself regains focus. An in-flight read is reused, not restarted.
  useEffect(() => {
    if (lostAccess) {
      return
    }
    const onFocus = () => {
      void queryClient.refetchQueries(
        { queryKey: cycleStatusQueryKey(userId, cycleId), type: 'active' },
        { cancelRefetch: false },
      )
    }
    window.addEventListener('focus', onFocus)
    return () => {
      window.removeEventListener('focus', onFocus)
    }
  }, [queryClient, userId, cycleId, lostAccess])

  // The member was removed while the page was open: re-read the project and
  // its cycles so the page shows its not-found state.
  useEffect(() => {
    if (!lostAccess) {
      return
    }
    void queryClient.invalidateQueries({
      queryKey: projectQueryKey(userId, projectId),
    })
    void queryClient.invalidateQueries({
      queryKey: projectCyclesQueryKey(userId, projectId),
    })
  }, [queryClient, userId, projectId, lostAccess])

  const status = statusQuery.data
  // After not_project_member the block stays empty while the page re-reads.
  let body: React.ReactNode = null
  if (lostAccess) {
    // No counts and no Retry.
  } else if (statusQuery.isError) {
    body = (
      <div role="alert" className="space-y-2">
        <p className="text-sm">Could not load submission status.</p>
        <Button
          type="button"
          variant="outline"
          onClick={() => {
            void statusQuery.refetch()
          }}
        >
          Retry
        </Button>
      </div>
    )
  } else if (status === undefined) {
    body = (
      <p role="status" className="text-sm text-muted-foreground">
        Loading submission status…
      </p>
    )
  } else {
    const lines = statusLines(status)
    body = (
      <>
        {lines.team.map((line) => (
          <p key={line} className={`text-sm ${wrapText}`}>
            {line}
          </p>
        ))}
        <p className={`text-sm text-muted-foreground ${wrapText}`}>
          {lines.mine}
        </p>
      </>
    )
  }

  return (
    <section
      aria-labelledby={headingId}
      className="min-w-0 space-y-2 rounded-md border p-3"
    >
      <h3 id={headingId} className="text-sm font-semibold">
        Submission status
      </h3>
      {body}
    </section>
  )
}
