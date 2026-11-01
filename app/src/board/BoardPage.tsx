import { useCallback, useEffect, useRef, useState, type RefObject } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { Link, useParams } from 'react-router-dom'
import { useAuth } from '@/auth/AuthProvider'
import { focusRing } from '@/cards/CardForms'
import { NOT_FOUND_MESSAGE } from '@/cards/cardsErrors'
import { Button } from '@/components/ui/button'
import type { AdvanceFromStatus, CycleDetail } from '@/cycles/cyclesApi'
import type { CyclesErrorCode } from '@/cycles/cyclesErrors'
import { cycleStatusLabel, type CycleStatus } from '@/cycles/cycleStatus'
import { formatWeekStart } from '@/cycles/cycleWeek'
import { useCycleEvents } from '@/cycles/useCycleEvents'
import { cycleQueryKey, useCycleQuery } from '@/cycles/useCycles'
import { cn } from '@/lib/utils'
import { isProjectId } from '@/projects/projectId'
import {
  projectMembersQueryKey,
  useProjectMembersQuery,
} from '@/projects/useMembers'
import { AdvanceControl } from './AdvanceControl'
import type { CycleBoard } from './boardApi'
import { boardErrorCodeOf } from './boardErrors'
import { isBoardStage, isConsistentBoard, stageName } from './boardModel'
import { BoardCardList } from './BoardCards'
import { StageIndicator } from './StageIndicator'
import {
  BOARD_POLL_INTERVAL_MS,
  cycleBoardQueryKey,
  useCycleBoardQuery,
} from './useBoard'

export const BOARD_LOAD_ERROR_MESSAGE = 'Could not load the board.'
export const LIVE_UNAVAILABLE_MESSAGE =
  'Live updates are unavailable. The board refreshes every few seconds.'

const linkClass = cn(
  'inline-block rounded-sm text-sm font-medium underline underline-offset-4',
  focusRing,
)

const wrapText = 'min-w-0 break-words [overflow-wrap:anywhere]'

function NotFound() {
  return (
    <div className="space-y-3 rounded-lg border border-dashed bg-card p-6 text-card-foreground">
      <p className="text-sm">{NOT_FOUND_MESSAGE}</p>
      <Link to="/projects" className={linkClass}>
        Back to projects
      </Link>
    </div>
  )
}

function LoadError({ onRetry }: { onRetry: () => void }) {
  return (
    <div
      role="alert"
      className="space-y-3 rounded-lg border border-destructive/30 bg-card p-4 text-card-foreground"
    >
      <p className="text-sm">{BOARD_LOAD_ERROR_MESSAGE}</p>
      <Button type="button" variant="outline" onClick={onRetry}>
        Retry
      </Button>
    </div>
  )
}

/** The header is the same in every mode; its badge uses the board's status. */
function BoardHeader({
  cycle,
  status,
}: {
  cycle: CycleDetail
  status: CycleStatus
}) {
  return (
    <div className="min-w-0 space-y-2">
      <h1 className={cn('text-2xl font-semibold tracking-tight', wrapText)}>
        {cycle.title}
      </h1>
      <p className="text-sm text-muted-foreground">
        Week of {formatWeekStart(cycle.weekStart)}
      </p>
      <p className="text-sm">
        <span className="inline-block rounded-md border px-2 py-0.5 text-xs font-medium">
          {cycleStatusLabel(status)}
        </span>
      </p>
      <div className="flex flex-wrap gap-x-4 gap-y-2">
        <Link to={`/projects/${cycle.projectId}`} className={linkClass}>
          Back to project
        </Link>
        <Link to={`/cycles/${cycle.id}/feedback`} className={linkClass}>
          {status === 'collecting' ? 'Add feedback' : 'View my feedback'}
        </Link>
      </div>
    </div>
  )
}

/** A plain-text placeholder for a mode a later task builds. */
function Placeholder({ text }: { text: string }) {
  return (
    <div
      data-testid="mode-placeholder"
      className="rounded-lg border border-dashed bg-card p-4 text-sm text-card-foreground"
    >
      {text}
    </div>
  )
}

interface ModeProps {
  readonly board: CycleBoard
  readonly isFacilitator: boolean
  readonly headingRef: RefObject<HTMLHeadingElement | null>
  readonly onAdvanceStart: (target: CycleStatus) => void
  readonly onAdvanced: (target: CycleStatus) => void
  readonly onAdvanceFailed: (code: CyclesErrorCode) => void
}

const ADVANCE_TARGET: Record<AdvanceFromStatus, CycleStatus> = {
  reveal: 'cluster',
  cluster: 'vote',
}

/** The h2, copy, control, and cards of the mode the server reports. */
function BoardMode({
  board,
  isFacilitator,
  headingRef,
  onAdvanceStart,
  onAdvanced,
  onAdvanceFailed,
}: ModeProps) {
  const { status, isRevealed, cards } = board
  let heading: string
  let intro: React.ReactNode = null
  let placeholder: string | null = null
  let from: AdvanceFromStatus | null = null

  switch (status) {
    case 'collecting':
      heading = 'The retrospective has not started yet'
      intro = (
        <>
          <p className="text-sm">
            Cards appear here when the facilitator starts the retrospective.
          </p>
          {isFacilitator ? (
            <p className="text-sm text-muted-foreground">
              Start the retrospective from the project page.
            </p>
          ) : null}
        </>
      )
      break
    case 'reveal':
      heading = 'Reveal'
      intro = (
        <p className="text-sm">
          All feedback for this cycle, grouped by Start, Stop and Continue.
        </p>
      )
      from = 'reveal'
      break
    case 'cluster':
      heading = 'Cluster'
      placeholder = 'Grouping cards into clusters is not available yet.'
      from = 'cluster'
      break
    case 'vote':
      heading = 'Vote'
      placeholder = 'Voting is not available yet.'
      break
    case 'discuss':
      heading = 'Discuss'
      placeholder = 'The discussion agenda is not available yet.'
      break
    case 'closed':
      heading = 'Closed'
      intro = (
        <p className="text-sm">
          {isRevealed
            ? 'This retrospective is closed.'
            : 'This cycle was closed before the retrospective started, so no feedback was revealed.'}
        </p>
      )
      break
  }

  return (
    <section aria-labelledby="board-mode-heading" className="min-w-0 space-y-4">
      <div className="min-w-0 space-y-2">
        <h2
          id="board-mode-heading"
          ref={headingRef}
          tabIndex={-1}
          className={cn('text-xl font-semibold', focusRing)}
        >
          {heading}
        </h2>
        {intro}
      </div>
      {placeholder !== null ? <Placeholder text={placeholder} /> : null}
      {from !== null && isFacilitator ? (
        <AdvanceControl
          key={from}
          cycleId={board.cycleId}
          from={from}
          onStart={() => {
            onAdvanceStart(ADVANCE_TARGET[from])
          }}
          onAdvanced={() => {
            onAdvanced(ADVANCE_TARGET[from])
          }}
          onFailed={onAdvanceFailed}
        />
      ) : null}
      {/* Cards are shown only once revealed, never the caller's own before. */}
      {isRevealed ? <BoardCardList cards={cards} /> : null}
    </section>
  )
}

interface FocusRequest {
  readonly target: CycleStatus
  readonly succeeded: boolean
}

interface StageAnnouncement {
  readonly status: CycleStatus | null
  readonly text: string
}

function BoardScreen({ cycleId }: { cycleId: string }) {
  const { user } = useAuth()
  const userId = user?.id ?? null
  const queryClient = useQueryClient()
  const validId = isProjectId(cycleId)
  // Set once a read or the stage control says the caller has no access. No
  // further board or cycle request is made after that.
  const [lostAccess, setLostAccess] = useState(false)
  // Whether the board and cycle poll: only while Realtime is unavailable.
  const [polling, setPolling] = useState(false)
  const [announcement, setAnnouncement] = useState<StageAnnouncement>({
    status: null,
    text: '',
  })
  const headingRef = useRef<HTMLHeadingElement | null>(null)
  // The caller's own advance, from the moment it is sent. Focus moves to the
  // new mode's h2 once the call has succeeded AND the board shows its target,
  // in whichever order the mutation, the refetch, and a Realtime event land.
  // A stage change the caller did not make never moves focus.
  const focusRequestRef = useRef<FocusRequest | null>(null)
  // The status the page last rendered, for the case where the board already
  // shows the target when the call resolves.
  const shownStatusRef = useRef<CycleStatus | undefined>(undefined)

  const refetchInterval = polling ? BOARD_POLL_INTERVAL_MS : false
  const cycleQuery = useCycleQuery(cycleId, validId && !lostAccess, {
    refetchInterval,
  })
  const boardQuery = useCycleBoardQuery(
    cycleId,
    validId && !lostAccess,
    refetchInterval,
  )
  const cycle = cycleQuery.data
  const board = boardQuery.data

  // Not found wins: either read saying "no access" hides everything.
  const denied =
    cycle === null ||
    board === null ||
    boardErrorCodeOf(boardQuery.error) === 'not_project_member'
  if (denied && !lostAccess) {
    setLostAccess(true)
  }
  const notFound = !validId || lostAccess || denied

  const projectId = !notFound && cycle ? cycle.projectId : undefined
  const membersQuery = useProjectMembersQuery(projectId)
  // The control comes from the caller's own member row, never owner_id. While
  // the members query is loading or has failed, no control is shown.
  const isFacilitator =
    membersQuery.isSuccess &&
    membersQuery.data?.some(
      (member) => member.isMe && member.role === 'facilitator',
    ) === true

  const invalidateAll = useCallback(() => {
    void queryClient.invalidateQueries({
      queryKey: cycleBoardQueryKey(userId, cycleId),
    })
    void queryClient.invalidateQueries({
      queryKey: cycleQueryKey(userId, cycleId),
    })
    if (projectId !== undefined) {
      void queryClient.invalidateQueries({
        queryKey: projectMembersQueryKey(userId, projectId),
      })
    }
  }, [queryClient, userId, cycleId, projectId])

  const refetchMembers = useCallback(() => {
    if (projectId !== undefined) {
      void queryClient.invalidateQueries({
        queryKey: projectMembersQueryKey(userId, projectId),
      })
    }
  }, [queryClient, userId, projectId])

  // One channel while the cycle is open and the caller has access. A closed
  // cycle never changes again, and a caller without access gets nothing.
  const channelId =
    !notFound && board !== undefined && board.status !== 'closed'
      ? cycleId
      : null
  const connection = useCycleEvents(channelId, invalidateAll)
  const shouldPoll = channelId !== null && connection === 'unavailable'
  if (shouldPoll !== polling) {
    setPolling(shouldPoll)
  }

  // Tell screen readers about every server stage change (not the first load).
  if (!notFound && board && board.status !== announcement.status) {
    setAnnouncement({
      status: board.status,
      text:
        announcement.status === null ? '' : `Stage: ${stageName(board.status)}`,
    })
  }

  // The members query does not refetch on focus or reconnect by default; the
  // board does, so a role change shows up without a reload.
  useEffect(() => {
    if (projectId === undefined) {
      return
    }
    window.addEventListener('focus', refetchMembers)
    window.addEventListener('online', refetchMembers)
    return () => {
      window.removeEventListener('focus', refetchMembers)
      window.removeEventListener('online', refetchMembers)
    }
  }, [projectId, refetchMembers])

  const boardStatus = board?.status
  useEffect(() => {
    shownStatusRef.current = boardStatus
    const request = focusRequestRef.current
    if (request?.succeeded === true && request.target === boardStatus) {
      focusRequestRef.current = null
      headingRef.current?.focus()
    }
  }, [boardStatus])

  const onAdvanceStart = useCallback((target: CycleStatus) => {
    focusRequestRef.current = { target, succeeded: false }
  }, [])

  const onAdvanced = useCallback((target: CycleStatus) => {
    if (shownStatusRef.current === target) {
      focusRequestRef.current = null
      headingRef.current?.focus()
    } else {
      focusRequestRef.current = { target, succeeded: true }
    }
  }, [])

  const onAdvanceFailed = useCallback(
    (code: CyclesErrorCode) => {
      focusRequestRef.current = null
      if (code === 'not_project_member') {
        setLostAccess(true)
      } else if (code === 'not_project_facilitator') {
        refetchMembers()
      }
      // Every failure re-reads the board and cycle when the mutation settles.
    },
    [refetchMembers],
  )

  const retry = () => {
    if (cycleQuery.isError) {
      void cycleQuery.refetch()
    }
    if (boardQuery.isError) {
      void boardQuery.refetch()
    }
  }

  let body: React.ReactNode
  if (notFound) {
    body = <NotFound />
  } else if (
    (cycle === undefined && cycleQuery.isError) ||
    (board === undefined && boardQuery.isError)
  ) {
    body = <LoadError onRetry={retry} />
  } else if (cycle === undefined || board === undefined) {
    body = (
      <p role="status" className="text-sm text-muted-foreground">
        Loading board…
      </p>
    )
  } else if (!isConsistentBoard(board)) {
    body = (
      <LoadError
        onRetry={() => {
          void boardQuery.refetch()
        }}
      />
    )
  } else {
    body = (
      <>
        <BoardHeader cycle={cycle} status={board.status} />
        {cycleQuery.isError || boardQuery.isError ? (
          <LoadError onRetry={retry} />
        ) : null}
        {shouldPoll ? (
          <p
            role="status"
            className="rounded-lg border bg-card p-3 text-sm text-card-foreground"
          >
            {LIVE_UNAVAILABLE_MESSAGE}
          </p>
        ) : null}
        {isBoardStage(board.status) ? (
          <StageIndicator current={board.status} />
        ) : null}
        <BoardMode
          board={board}
          isFacilitator={isFacilitator}
          headingRef={headingRef}
          onAdvanceStart={onAdvanceStart}
          onAdvanced={onAdvanced}
          onAdvanceFailed={onAdvanceFailed}
        />
      </>
    )
  }

  return (
    <div className="min-w-0 space-y-4">
      <p role="status" className="sr-only">
        {notFound ? '' : announcement.text}
      </p>
      {body}
    </div>
  )
}

/** `/cycles/:id/board`: the retrospective board in the server's stage. */
export function BoardPage() {
  const { id = '' } = useParams<{ id: string }>()
  // A new cycle id starts with fresh page state and a new channel.
  return <BoardScreen key={id} cycleId={id} />
}

export default BoardPage
