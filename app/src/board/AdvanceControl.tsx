import { useEffect, useRef, useState } from 'react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import type { AdvanceFromStatus } from '@/cycles/cyclesApi'
import {
  advanceStageErrorMessage,
  closeVotingErrorMessage,
  cyclesErrorCodeOf,
  type CyclesErrorCode,
} from '@/cycles/cyclesErrors'
import { useAdvanceStage, useCloseVoting } from '@/cycles/useCycles'
import { cn } from '@/lib/utils'

/**
 * The stage the control leaves: reveal and cluster through `advance_stage`
 * (#16), vote through `close_voting` (#24).
 */
export type StageControlFrom = AdvanceFromStatus | 'vote'

interface ControlCopy {
  readonly action: string
  readonly confirm: string
  readonly pending: string
  readonly success: string
}

export const CLOSE_VOTING_CONFIRM =
  'Close voting for everyone? Members who have not used all their votes cannot vote any more, and the results are shown to the whole team. You cannot reopen voting.'
export const CLOSE_VOTING_SUCCESS = 'Voting closed. The board moved to Discuss.'

const COPY: Record<StageControlFrom, ControlCopy> = {
  reveal: {
    action: 'Start clustering',
    confirm:
      'Move everyone to the Cluster stage? You cannot go back to Reveal.',
    pending: 'Moving…',
    success: 'The board moved to Cluster.',
  },
  // #17: the board passes its cluster and ungrouped-card counts as `note`.
  cluster: {
    action: 'Start voting',
    confirm:
      'Move everyone to the Vote stage? Clusters cannot be changed once voting starts, and you cannot go back to Cluster.',
    pending: 'Moving…',
    success: 'The board moved to Vote.',
  },
  // #24: the facilitator closes voting early.
  vote: {
    action: 'Close voting',
    confirm: CLOSE_VOTING_CONFIRM,
    pending: 'Closing…',
    success: CLOSE_VOTING_SUCCESS,
  },
}

/** The toast for a failed call, or null for none (the not-found state). */
function failureMessage(
  from: StageControlFrom,
  code: CyclesErrorCode,
): string | null {
  if (from === 'vote') {
    return closeVotingErrorMessage(code)
  }
  return code === 'not_project_member' ? null : advanceStageErrorMessage(code)
}

const wrapText = 'min-w-0 break-words [overflow-wrap:anywhere]'

export interface AdvanceControlProps {
  readonly cycleId: string
  /** The stage currently shown, which is the one the call leaves. */
  readonly from: StageControlFrom
  /** Shown before the confirmation's own copy (the counts for "Start voting"). */
  readonly note?: string
  /** Called when the request is sent, before any answer or refetch. */
  readonly onStart: () => void
  /**
   * Called after the call succeeded. The board's refetch (or a Realtime
   * event) may already have rendered the new stage by then.
   */
  readonly onAdvanced: () => void
  /** Called with the stable code when the call fails. */
  readonly onFailed: (code: CyclesErrorCode) => void
}

/**
 * The facilitator's "Start clustering" / "Start voting" / "Close voting"
 * control with #10's inline confirmation. Focus moves to Cancel when it
 * opens and back to the trigger when it closes. Nothing is optimistic: the
 * mode changes only when the board's refetch returns the new stage.
 */
export function AdvanceControl({
  cycleId,
  from,
  note,
  onStart,
  onAdvanced,
  onFailed,
}: AdvanceControlProps) {
  const copy = COPY[from]
  const advance = useAdvanceStage(cycleId)
  const closeVoting = useCloseVoting(cycleId)
  const send = (): Promise<unknown> =>
    from === 'vote' ? closeVoting.mutateAsync() : advance.mutateAsync(from)
  const [confirming, setConfirming] = useState(false)
  // A synchronous second click or Enter must not send a second request.
  const pendingRef = useRef(false)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const cancelRef = useRef<HTMLButtonElement>(null)
  // Set when the confirmation closes, so focus returns to the trigger.
  const returnFocusRef = useRef(false)

  useEffect(() => {
    if (confirming) {
      cancelRef.current?.focus()
    } else if (returnFocusRef.current) {
      returnFocusRef.current = false
      triggerRef.current?.focus()
    }
  }, [confirming])

  const close = () => {
    returnFocusRef.current = true
    setConfirming(false)
  }

  const confirm = () => {
    if (pendingRef.current) {
      return
    }
    pendingRef.current = true
    onStart()
    send()
      .then(() => {
        toast.success(copy.success)
        onAdvanced()
        setConfirming(false)
      })
      .catch((error: unknown) => {
        const code = cyclesErrorCodeOf(error)
        const message = failureMessage(from, code)
        if (message !== null) {
          toast.error(message)
        }
        close()
        onFailed(code)
      })
      .finally(() => {
        pendingRef.current = false
      })
  }

  if (!confirming) {
    return (
      <div>
        <Button
          ref={triggerRef}
          type="button"
          onClick={() => {
            setConfirming(true)
          }}
        >
          {copy.action}
        </Button>
      </div>
    )
  }

  const pending = from === 'vote' ? closeVoting.isPending : advance.isPending
  return (
    <div
      role="group"
      aria-label={copy.action}
      className="space-y-3 rounded-md border border-destructive/30 p-3"
      onKeyDown={(event) => {
        if (event.key === 'Escape' && !pending) {
          event.preventDefault()
          close()
        }
      }}
    >
      {note !== undefined ? (
        <p className={cn('text-sm', wrapText)}>{note}</p>
      ) : null}
      <p className={cn('text-sm', wrapText)}>{copy.confirm}</p>
      <div className="flex flex-wrap gap-2">
        <Button
          ref={cancelRef}
          type="button"
          variant="outline"
          disabled={pending}
          onClick={close}
        >
          Cancel
        </Button>
        <Button type="button" disabled={pending} onClick={confirm}>
          {pending ? copy.pending : copy.action}
        </Button>
      </div>
    </div>
  )
}
