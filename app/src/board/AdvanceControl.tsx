import { useEffect, useRef, useState } from 'react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import type { AdvanceFromStatus } from '@/cycles/cyclesApi'
import {
  advanceStageErrorMessage,
  cyclesErrorCodeOf,
  type CyclesErrorCode,
} from '@/cycles/cyclesErrors'
import { useAdvanceStage } from '@/cycles/useCycles'
import { cn } from '@/lib/utils'

interface ControlCopy {
  readonly action: string
  readonly confirm: string
  readonly success: string
}

const COPY: Record<AdvanceFromStatus, ControlCopy> = {
  reveal: {
    action: 'Start clustering',
    confirm:
      'Move everyone to the Cluster stage? You cannot go back to Reveal.',
    success: 'The board moved to Cluster.',
  },
  // #17 adds its cluster and ungrouped-card counts to this confirmation.
  cluster: {
    action: 'Start voting',
    confirm:
      'Move everyone to the Vote stage? Clusters cannot be changed once voting starts, and you cannot go back to Cluster.',
    success: 'The board moved to Vote.',
  },
}

const wrapText = 'min-w-0 break-words [overflow-wrap:anywhere]'

export interface AdvanceControlProps {
  readonly cycleId: string
  /** The stage currently shown, which is the one the call leaves. */
  readonly from: AdvanceFromStatus
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
 * The facilitator's "Start clustering" / "Start voting" control with #10's
 * inline confirmation. Focus moves to Cancel when it opens and back to the
 * trigger when it closes. Nothing is optimistic: the mode changes only when
 * the board's refetch returns the new stage.
 */
export function AdvanceControl({
  cycleId,
  from,
  onStart,
  onAdvanced,
  onFailed,
}: AdvanceControlProps) {
  const copy = COPY[from]
  const mutation = useAdvanceStage(cycleId)
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
    mutation
      .mutateAsync(from)
      .then(() => {
        toast.success(copy.success)
        onAdvanced()
        setConfirming(false)
      })
      .catch((error: unknown) => {
        const code = cyclesErrorCodeOf(error)
        if (code !== 'not_project_member') {
          toast.error(advanceStageErrorMessage(code))
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

  const pending = mutation.isPending
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
          {pending ? 'Moving…' : copy.action}
        </Button>
      </div>
    </div>
  )
}
