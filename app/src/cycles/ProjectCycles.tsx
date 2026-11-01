import { useEffect, useRef, useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { Link, useNavigate } from 'react-router-dom'
import { toast } from 'sonner'
import { useAuth } from '@/auth/AuthProvider'
import { Button } from '@/components/ui/button'
import { formatProjectDate } from '@/projects/projectDate'
import {
  projectMembersQueryKey,
  useProjectMembersQuery,
} from '@/projects/useMembers'
import { projectQueryKey } from '@/projects/useProjects'
import { CreateCycleForm } from './CreateCycleForm'
import type { CycleSubmissionStatus, CycleSummary } from './cyclesApi'
import { cycleStatusLabel, type CycleStatus } from './cycleStatus'
import { formatWeekStart } from './cycleWeek'
import { SubmissionStatus } from './SubmissionStatus'
import {
  closeCycleErrorMessage,
  cyclesErrorCodeOf,
  startRetrospectiveErrorMessage,
} from './cyclesErrors'
import { useCycleEvents } from './useCycleEvents'
import {
  projectCyclesQueryKey,
  useCloseCycle,
  useCycleStatusQuery,
  useInvalidateCycleStage,
  useInvalidateProjectCycles,
  useProjectCyclesQuery,
  useStartRetrospective,
} from './useCycles'

const CLOSE_CONFIRM_COPY =
  'Closing ends this cycle for everyone. Feedback can no longer be added and the cycle cannot be reopened.'

const START_CONFIRM_COPY =
  'Start the retrospective? Feedback collection ends for everyone, and every card in this cycle becomes visible to all project members. Names are shown only on cards that were not submitted anonymously. This cannot be undone.'

/** Stages in which the retrospective board is open. */
const BOARD_STATUSES: readonly CycleStatus[] = [
  'reveal',
  'cluster',
  'vote',
  'discuss',
]

/**
 * The confirmation's one line of submission data: the same aggregate every
 * member sees, never a card count.
 */
function submittersLine(status: CycleSubmissionStatus): string {
  if (status.submittedMemberCount === 0) {
    return 'No one has added feedback yet.'
  }
  const members = status.memberCount === 1 ? 'member' : 'members'
  const verb = status.memberCount === 1 ? 'has' : 'have'
  return `${status.submittedMemberCount} of ${status.memberCount} ${members} ${verb} added feedback.`
}

interface StartConfirmationProps {
  readonly cycleId: string
  readonly pending: boolean
  readonly onCancel: () => void
  readonly onConfirm: () => void
}

/** The inline "Start retrospective" confirmation. */
function StartConfirmation({
  cycleId,
  pending,
  onCancel,
  onConfirm,
}: StartConfirmationProps) {
  // The same query (and key) as the Submission status block: no new request.
  const statusQuery = useCycleStatusQuery(cycleId)
  const cancelRef = useRef<HTMLButtonElement>(null)

  useEffect(() => {
    cancelRef.current?.focus()
  }, [])

  let line: string
  if (statusQuery.data) {
    line = submittersLine(statusQuery.data)
  } else if (statusQuery.isError) {
    line = 'Could not load submission status.'
  } else {
    line = 'Loading submission status…'
  }

  return (
    <div
      role="group"
      aria-label="Start retrospective"
      className="space-y-3 rounded-md border border-destructive/30 p-3"
      onKeyDown={(event) => {
        if (event.key === 'Escape' && !pending) {
          event.preventDefault()
          onCancel()
        }
      }}
    >
      <p className={`text-sm ${wrapText}`}>{START_CONFIRM_COPY}</p>
      <p className={`text-sm ${wrapText}`}>{line}</p>
      <div className="flex flex-wrap gap-2">
        <Button
          ref={cancelRef}
          type="button"
          variant="outline"
          disabled={pending}
          onClick={onCancel}
        >
          Cancel
        </Button>
        <Button type="button" disabled={pending} onClick={onConfirm}>
          {pending ? 'Starting…' : 'Start retrospective'}
        </Button>
      </div>
    </div>
  )
}

const wrapText = 'min-w-0 break-words [overflow-wrap:anywhere]'

interface CurrentCycleProps {
  readonly projectId: string
  readonly cycle: CycleSummary
  readonly isFacilitator: boolean
  readonly onRoleChanged: () => void
}

type Confirming = 'close' | 'start' | null

function CurrentCycle({
  projectId,
  cycle,
  isFacilitator,
  onRoleChanged,
}: CurrentCycleProps) {
  const { user } = useAuth()
  const userId = user?.id ?? null
  const queryClient = useQueryClient()
  const navigate = useNavigate()
  const closeMutation = useCloseCycle(projectId)
  const startMutation = useStartRetrospective(projectId)
  const invalidateStage = useInvalidateCycleStage(projectId)
  // Only one of the two confirmations is open at a time.
  const [confirming, setConfirming] = useState<Confirming>(null)
  // A synchronous second click must not send a second request.
  const pendingRef = useRef(false)
  const startPendingRef = useRef(false)
  const startButtonRef = useRef<HTMLButtonElement>(null)
  const canStart = isFacilitator && cycle.status === 'collecting'
  const boardOpen = BOARD_STATUSES.includes(cycle.status)

  const cancelStart = () => {
    setConfirming(null)
    // Focus returns to the button that opened the confirmation.
    queueMicrotask(() => {
      startButtonRef.current?.focus()
    })
  }

  const confirmStart = () => {
    if (startPendingRef.current) {
      return
    }
    startPendingRef.current = true
    startMutation
      .mutateAsync(cycle.id)
      .then((row) => {
        toast.success('Retrospective started.')
        void navigate(`/cycles/${row.id}/board`)
      })
      .catch((error: unknown) => {
        const code = cyclesErrorCodeOf(error)
        toast.error(startRetrospectiveErrorMessage(code))
        if (code === 'not_project_facilitator') {
          onRoleChanged()
        } else if (code === 'cycle_not_collecting') {
          void invalidateStage(cycle.id)
        } else if (code === 'not_project_member') {
          void queryClient.invalidateQueries({
            queryKey: projectQueryKey(userId, projectId),
          })
          void queryClient.invalidateQueries({
            queryKey: projectCyclesQueryKey(userId, projectId),
          })
        }
      })
      .finally(() => {
        startPendingRef.current = false
        setConfirming(null)
      })
  }

  const confirmClose = () => {
    if (pendingRef.current) {
      return
    }
    pendingRef.current = true
    closeMutation
      .mutateAsync(cycle.id)
      .then(() => {
        toast.success('Cycle closed.')
      })
      .catch((error: unknown) => {
        const code = cyclesErrorCodeOf(error)
        toast.error(closeCycleErrorMessage(code))
        if (code === 'not_project_facilitator') {
          onRoleChanged()
        }
      })
      .finally(() => {
        pendingRef.current = false
        setConfirming(null)
      })
  }

  return (
    <div className="min-w-0 space-y-3 rounded-lg border bg-card p-4 text-card-foreground">
      <div className="min-w-0 space-y-1">
        <h3 className={`text-base font-semibold ${wrapText}`}>{cycle.title}</h3>
        <p className="text-sm">
          <span className="inline-block rounded-md border px-2 py-0.5 text-xs font-medium">
            {cycleStatusLabel(cycle.status)}
          </span>
        </p>
        <p className="text-sm text-muted-foreground">
          Week of {formatWeekStart(cycle.weekStart)}
        </p>
        <p className="text-sm text-muted-foreground">
          Opened {formatProjectDate(cycle.createdAt)}
        </p>
      </div>

      {/* The same aggregate counts for every member, the facilitator included. */}
      <SubmissionStatus projectId={projectId} cycleId={cycle.id} />

      {/* Every member, the facilitator included, gets the same link. */}
      <Link
        to={`/cycles/${cycle.id}/feedback`}
        className="inline-block text-sm font-medium underline underline-offset-4"
      >
        {cycle.status === 'collecting' ? 'Add feedback' : 'View my feedback'}
      </Link>

      {/* Every member, the facilitator included, gets the board link. */}
      {boardOpen ? (
        <Link
          to={`/cycles/${cycle.id}/board`}
          className="block text-sm font-medium underline underline-offset-4"
        >
          Open retrospective board
        </Link>
      ) : null}

      {isFacilitator && confirming === null ? (
        <div className="flex flex-wrap gap-2">
          {canStart ? (
            <Button
              ref={startButtonRef}
              type="button"
              onClick={() => {
                setConfirming('start')
              }}
            >
              Start retrospective
            </Button>
          ) : null}
          <Button
            type="button"
            variant="outline"
            onClick={() => {
              setConfirming('close')
            }}
          >
            Close cycle
          </Button>
        </div>
      ) : null}

      {canStart && confirming === 'start' ? (
        <StartConfirmation
          cycleId={cycle.id}
          pending={startMutation.isPending}
          onCancel={cancelStart}
          onConfirm={confirmStart}
        />
      ) : null}

      {isFacilitator && confirming === 'close' ? (
        <div className="space-y-3 rounded-md border border-destructive/30 p-3">
          <p className="text-sm">{CLOSE_CONFIRM_COPY}</p>
          <div className="flex flex-wrap gap-2">
            <Button
              type="button"
              variant="outline"
              disabled={closeMutation.isPending}
              onClick={() => {
                setConfirming(null)
              }}
            >
              Cancel
            </Button>
            <Button
              type="button"
              variant="destructive"
              disabled={closeMutation.isPending}
              onClick={confirmClose}
            >
              Close cycle
            </Button>
          </div>
        </div>
      ) : null}
    </div>
  )
}

function PastCycles({ cycles }: { cycles: readonly CycleSummary[] }) {
  if (cycles.length === 0) {
    return <p className="text-sm text-muted-foreground">No past cycles yet.</p>
  }

  return (
    <ul
      aria-label="Past cycles"
      className="divide-y rounded-lg border bg-card text-card-foreground"
    >
      {cycles.map((cycle) => (
        <li key={cycle.id} className="min-w-0 space-y-1 px-4 py-3">
          <p className={`font-medium ${wrapText}`}>{cycle.title}</p>
          <p className="text-sm text-muted-foreground">
            Week of {formatWeekStart(cycle.weekStart)}
          </p>
          {cycle.closedAt ? (
            <p className="text-sm text-muted-foreground">
              Closed {formatProjectDate(cycle.closedAt)}
            </p>
          ) : null}
        </li>
      ))}
    </ul>
  )
}

/** The project page's "Current cycle" and "Past cycles" sections. */
export function ProjectCycles({ projectId }: { projectId: string }) {
  const { user } = useAuth()
  const userId = user?.id ?? null
  const queryClient = useQueryClient()
  const cyclesQuery = useProjectCyclesQuery(projectId)
  const membersQuery = useProjectMembersQuery(projectId)
  const invalidateCycles = useInvalidateProjectCycles(projectId)
  const [formOpen, setFormOpen] = useState(false)

  // The role always comes from get_project_members; never from owner_id.
  const isFacilitator =
    membersQuery.data?.some(
      (member) => member.isMe && member.role === 'facilitator',
    ) ?? false

  const refetchMembers = () => {
    void queryClient.invalidateQueries({
      queryKey: projectMembersQueryKey(userId, projectId),
    })
  }

  const cycles = cyclesQuery.data
  const current = cycles?.current ?? null
  const currentId = current?.id ?? null
  const invalidateStage = useInvalidateCycleStage(projectId)

  // One live cycle_events channel while there is an open cycle. Each event,
  // and each SUBSCRIBED (so a missed event is caught up), re-reads the cycles
  // and the status. Nothing is read from the message, and nothing polls.
  useCycleEvents(currentId, () => {
    if (currentId !== null) {
      void invalidateStage(currentId)
    }
  })

  // TanStack re-reads on visibilitychange; also re-read the cycles when the
  // window itself regains focus, as the status block does.
  useEffect(() => {
    const onFocus = () => {
      void queryClient.refetchQueries(
        { queryKey: projectCyclesQueryKey(userId, projectId), type: 'active' },
        { cancelRefetch: false },
      )
    }
    window.addEventListener('focus', onFocus)
    return () => {
      window.removeEventListener('focus', onFocus)
    }
  }, [queryClient, userId, projectId])

  return (
    <div className="min-w-0 space-y-6">
      <section aria-labelledby="current-cycle-heading" className="space-y-3">
        <h2 id="current-cycle-heading" className="text-lg font-semibold">
          Current cycle
        </h2>

        {cyclesQuery.isPending ? (
          <p role="status" className="text-sm text-muted-foreground">
            Loading cycles…
          </p>
        ) : null}

        {cyclesQuery.isError ? (
          <div
            role="alert"
            className="space-y-3 rounded-lg border border-destructive/30 bg-card p-4 text-card-foreground"
          >
            <p className="text-sm">Could not load the cycles.</p>
            <Button
              type="button"
              variant="outline"
              onClick={() => {
                void cyclesQuery.refetch()
              }}
            >
              Retry
            </Button>
          </div>
        ) : null}

        {cyclesQuery.isSuccess && current ? (
          <CurrentCycle
            key={current.id}
            projectId={projectId}
            cycle={current}
            isFacilitator={isFacilitator}
            onRoleChanged={refetchMembers}
          />
        ) : null}

        {cyclesQuery.isSuccess && !current ? (
          <div className="space-y-3 rounded-lg border border-dashed bg-card p-4 text-card-foreground">
            <p className="text-sm">No open feedback cycle.</p>
            {isFacilitator ? (
              <>
                <p className="text-sm text-muted-foreground">
                  Start a cycle to collect this week&apos;s feedback.
                </p>
                {formOpen ? (
                  <CreateCycleForm
                    projectId={projectId}
                    onClose={() => {
                      setFormOpen(false)
                    }}
                    onCycleConflict={() => {
                      void invalidateCycles()
                    }}
                    onRoleChanged={refetchMembers}
                  />
                ) : (
                  <Button
                    type="button"
                    onClick={() => {
                      setFormOpen(true)
                    }}
                  >
                    New cycle
                  </Button>
                )}
              </>
            ) : (
              <p className="text-sm text-muted-foreground">
                The facilitator has not started a cycle yet.
              </p>
            )}
          </div>
        ) : null}
      </section>

      {cyclesQuery.isSuccess && cycles ? (
        <section aria-labelledby="past-cycles-heading" className="space-y-3">
          <h2 id="past-cycles-heading" className="text-lg font-semibold">
            Past cycles
          </h2>
          <PastCycles cycles={cycles.past} />
        </section>
      ) : null}
    </div>
  )
}
