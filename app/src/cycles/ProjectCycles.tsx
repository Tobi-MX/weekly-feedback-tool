import { useRef, useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { Link } from 'react-router-dom'
import { toast } from 'sonner'
import { useAuth } from '@/auth/AuthProvider'
import { Button } from '@/components/ui/button'
import { formatProjectDate } from '@/projects/projectDate'
import {
  projectMembersQueryKey,
  useProjectMembersQuery,
} from '@/projects/useMembers'
import { CreateCycleForm } from './CreateCycleForm'
import type { CycleSummary } from './cyclesApi'
import { cycleStatusLabel } from './cycleStatus'
import { formatWeekStart } from './cycleWeek'
import { SubmissionStatus } from './SubmissionStatus'
import { closeCycleErrorMessage, cyclesErrorCodeOf } from './cyclesErrors'
import {
  useCloseCycle,
  useInvalidateProjectCycles,
  useProjectCyclesQuery,
} from './useCycles'

const CLOSE_CONFIRM_COPY =
  'Closing ends this cycle for everyone. Feedback can no longer be added and the cycle cannot be reopened.'

const wrapText = 'min-w-0 break-words [overflow-wrap:anywhere]'

interface CurrentCycleProps {
  readonly projectId: string
  readonly cycle: CycleSummary
  readonly isFacilitator: boolean
  readonly onRoleChanged: () => void
}

function CurrentCycle({
  projectId,
  cycle,
  isFacilitator,
  onRoleChanged,
}: CurrentCycleProps) {
  const closeMutation = useCloseCycle(projectId)
  const [confirming, setConfirming] = useState(false)
  // A synchronous second click must not send a second request.
  const pendingRef = useRef(false)

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
        setConfirming(false)
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

      {isFacilitator && !confirming ? (
        <Button
          type="button"
          variant="outline"
          onClick={() => {
            setConfirming(true)
          }}
        >
          Close cycle
        </Button>
      ) : null}

      {isFacilitator && confirming ? (
        <div className="space-y-3 rounded-md border border-destructive/30 p-3">
          <p className="text-sm">{CLOSE_CONFIRM_COPY}</p>
          <div className="flex flex-wrap gap-2">
            <Button
              type="button"
              variant="outline"
              disabled={closeMutation.isPending}
              onClick={() => {
                setConfirming(false)
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
