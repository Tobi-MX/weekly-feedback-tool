import { useCallback, useEffect, useRef, useState } from 'react'
import { useMutationState, useQueryClient } from '@tanstack/react-query'
import { Link, useParams } from 'react-router-dom'
import { toast } from 'sonner'
import { useAuth } from '@/auth/AuthProvider'
import { Button } from '@/components/ui/button'
import { cycleStatusLabel } from '@/cycles/cycleStatus'
import { formatWeekStart } from '@/cycles/cycleWeek'
import { cycleQueryKey, useCycleQuery } from '@/cycles/useCycles'
import { cn } from '@/lib/utils'
import { isProjectId } from '@/projects/projectId'
import { useOnline } from './browserState'
import type { MyCard } from './cardsApi'
import {
  CARD_CATEGORIES,
  cardCategoryLabel,
  cardCategoryPrompt,
  type CardCategory,
} from './cardCategories'
import { CardItem } from './CardItem'
import {
  CardComposer,
  NotSavedText,
  focusRing,
  type WriteErrorHandler,
} from './CardForms'
import {
  CARD_GONE_ON_SAVE_MESSAGE,
  COLLECTION_ENDED_MESSAGE,
  LOAD_ERROR_MESSAGE,
  NOT_FOUND_MESSAGE,
  cardsErrorCodeOf,
  cardsErrorMessage,
} from './cardsErrors'
import {
  CREATE_CARD_KEY,
  DELETE_CARD_KEY,
  UPDATE_CARD_KEY,
  useInvalidateFeedback,
  useMyCardsQuery,
} from './useCards'

const CLOSED_NOTICE =
  'Feedback collection has ended for this cycle. You can still read your cards.'
const OFFLINE_MESSAGE =
  'You are offline. Cards cannot be saved until you reconnect.'

const linkClass = cn(
  'inline-block rounded-sm text-sm font-medium underline underline-offset-4',
  focusRing,
)

interface GoneCard {
  readonly key: number
  readonly text: string
}

interface CardSectionProps {
  readonly cycleId: string
  readonly category: CardCategory
  readonly cards: readonly MyCard[]
  readonly collecting: boolean
  readonly online: boolean
  readonly onWriteError: WriteErrorHandler
}

function CardSection({
  cycleId,
  category,
  cards,
  collecting,
  online,
  onWriteError,
}: CardSectionProps) {
  const label = cardCategoryLabel(category)
  const headingId = `feedback-${category}-heading`
  const composerRef = useRef<HTMLTextAreaElement | null>(null)
  // Text from an edit whose card was deleted elsewhere, kept to be copied.
  const [goneCards, setGoneCards] = useState<readonly GoneCard[]>([])
  const nextKey = useRef(0)

  const focusComposer = useCallback(() => {
    composerRef.current?.focus()
  }, [])

  const onCardGone = useCallback((text: string) => {
    nextKey.current += 1
    const key = nextKey.current
    setGoneCards((current) => [...current, { key, text }])
  }, [])

  return (
    <section
      aria-labelledby={headingId}
      className="min-w-0 space-y-3 rounded-lg border bg-card p-4 text-card-foreground"
    >
      <div className="space-y-1">
        <h2 id={headingId} className="text-lg font-semibold">
          {label}
        </h2>
        <p className="text-sm text-muted-foreground">
          {cardCategoryPrompt(category)}
        </p>
      </div>

      {cards.length === 0 ? (
        <p className="text-sm text-muted-foreground">No {label} cards yet.</p>
      ) : (
        <ul aria-label={`Your ${label} cards`} className="space-y-2">
          {cards.map((card, index) => (
            <CardItem
              key={card.id}
              cycleId={cycleId}
              card={card}
              name={`${label} card ${index + 1}`}
              collecting={collecting}
              online={online}
              onWriteError={onWriteError}
              onCardGone={onCardGone}
              focusComposer={focusComposer}
            />
          ))}
        </ul>
      )}

      {goneCards.map((gone) => (
        <div key={gone.key} className="min-w-0 space-y-2">
          <p role="alert" className="text-sm text-destructive">
            {CARD_GONE_ON_SAVE_MESSAGE}
          </p>
          <NotSavedText text={gone.text} />
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => {
              setGoneCards((current) =>
                current.filter((item) => item.key !== gone.key),
              )
            }}
          >
            Dismiss
          </Button>
        </div>
      ))}

      <CardComposer
        cycleId={cycleId}
        category={category}
        collecting={collecting}
        online={online}
        textareaRef={composerRef}
        onWriteError={onWriteError}
      />
    </section>
  )
}

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
      <p className="text-sm">{LOAD_ERROR_MESSAGE}</p>
      <Button type="button" variant="outline" onClick={onRetry}>
        Retry
      </Button>
    </div>
  )
}

/** Announces pending writes; the buttons' own text changes too. */
function PendingAnnouncer() {
  const pending = useMutationState({
    filters: { status: 'pending' },
    select: (mutation) => mutation.options.mutationKey?.[0],
  })
  let message = ''
  if (pending.includes(CREATE_CARD_KEY[0])) {
    message = 'Adding…'
  } else if (pending.includes(UPDATE_CARD_KEY[0])) {
    message = 'Saving…'
  } else if (pending.includes(DELETE_CARD_KEY[0])) {
    message = 'Deleting…'
  }
  return (
    <p role="status" className="sr-only">
      {message}
    </p>
  )
}

function FeedbackScreen({ cycleId }: { cycleId: string }) {
  const { user } = useAuth()
  const userId = user?.id ?? null
  const queryClient = useQueryClient()
  const online = useOnline()
  const validId = isProjectId(cycleId)
  // Set when a card RPC answers not_project_member: no further card request.
  const [lostAccess, setLostAccess] = useState(false)
  // Set when a write answers cycle_not_collecting, before the re-read lands.
  const [ended, setEnded] = useState(false)

  const cycleQuery = useCycleQuery(cycleId, validId && !lostAccess)
  const cycle = cycleQuery.data
  const cardsQuery = useMyCardsQuery(
    cycleId,
    validId && !lostAccess && cycle !== undefined && cycle !== null,
  )
  const cards = cardsQuery.data
  const invalidate = useInvalidateFeedback(cycleId)

  // TanStack re-reads on visibilitychange; also re-read when the window
  // itself regains focus. An in-flight read is reused, not restarted.
  useEffect(() => {
    if (!validId || lostAccess) {
      return
    }
    const onFocus = () => {
      void queryClient.refetchQueries(
        { queryKey: cycleQueryKey(userId, cycleId), type: 'active' },
        { cancelRefetch: false },
      )
    }
    window.addEventListener('focus', onFocus)
    return () => {
      window.removeEventListener('focus', onFocus)
    }
  }, [queryClient, userId, cycleId, validId, lostAccess])

  const onWriteError = useCallback<WriteErrorHandler>(
    (code, operation) => {
      switch (code) {
        case 'not_project_member':
          setLostAccess(true)
          return
        case 'cycle_not_collecting':
          setEnded(true)
          void invalidate(true)
          return
        case 'card_not_found':
          void invalidate(false)
          if (operation === 'delete') {
            toast.error(cardsErrorMessage(code, operation))
          }
          return
        default:
          toast.error(cardsErrorMessage(code, operation))
      }
    },
    [invalidate],
  )

  const cardsNotMember =
    cardsErrorCodeOf(cardsQuery.error) === 'not_project_member'
  const notFound = !validId || lostAccess || cycle === null || cardsNotMember

  let body: React.ReactNode
  if (notFound) {
    body = <NotFound />
  } else if (cycleQuery.isError && cycle === undefined) {
    body = (
      <LoadError
        onRetry={() => {
          void cycleQuery.refetch()
        }}
      />
    )
  } else if (cardsQuery.isError && cards === undefined) {
    body = (
      <LoadError
        onRetry={() => {
          void cardsQuery.refetch()
        }}
      />
    )
  } else if (cycle === undefined || cards === undefined) {
    body = (
      <p role="status" className="text-sm text-muted-foreground">
        Loading feedback…
      </p>
    )
  } else {
    const collecting = cycle.status === 'collecting' && !ended
    const refetchFailed = cycleQuery.isError || cardsQuery.isError
    body = (
      <>
        <div className="min-w-0 space-y-2">
          <h1 className="min-w-0 break-words text-2xl font-semibold tracking-tight [overflow-wrap:anywhere]">
            {cycle.title}
          </h1>
          <p className="text-sm">
            <span className="inline-block rounded-md border px-2 py-0.5 text-xs font-medium">
              {cycleStatusLabel(cycle.status)}
            </span>
          </p>
          <p className="text-sm text-muted-foreground">
            Week of {formatWeekStart(cycle.weekStart)}
          </p>
          <Link to={`/projects/${cycle.projectId}`} className={linkClass}>
            Back to project
          </Link>
        </div>

        <PendingAnnouncer />

        {!online ? (
          <p
            role="status"
            className="rounded-lg border border-destructive/30 bg-card p-3 text-sm text-card-foreground"
          >
            {OFFLINE_MESSAGE}
          </p>
        ) : null}

        {ended ? (
          <p
            role="alert"
            className="rounded-lg border border-destructive/30 bg-card p-3 text-sm text-card-foreground"
          >
            {COLLECTION_ENDED_MESSAGE}
          </p>
        ) : null}

        {refetchFailed ? (
          <LoadError
            onRetry={() => {
              if (cycleQuery.isError) {
                void cycleQuery.refetch()
              }
              if (cardsQuery.isError) {
                void cardsQuery.refetch()
              }
            }}
          />
        ) : null}

        {!collecting ? (
          <p className="rounded-lg border bg-card p-3 text-sm text-card-foreground">
            {CLOSED_NOTICE}
          </p>
        ) : null}

        <div className="grid min-w-0 grid-cols-1 gap-4 md:grid-cols-3">
          {CARD_CATEGORIES.map((category) => (
            <CardSection
              key={category}
              cycleId={cycle.id}
              category={category}
              cards={cards.filter((card) => card.category === category)}
              collecting={collecting}
              online={online}
              onWriteError={onWriteError}
            />
          ))}
        </div>
      </>
    )
  }

  return <div className="min-w-0 space-y-4">{body}</div>
}

/** `/cycles/:id/feedback`: the member's own Start, Stop, and Continue cards. */
export function FeedbackPage() {
  const { id = '' } = useParams<{ id: string }>()
  // A new cycle id starts with fresh page state.
  return <FeedbackScreen key={id} cycleId={id} />
}

export default FeedbackPage
