import { useEffect } from 'react'
import { Button } from '@/components/ui/button'
import type { BoardCard, BoardCluster, CycleBoard } from './boardApi'
import { ClusterCardItem, ClusterHeading } from './BoardCards'
import { rankedAgenda, ungroupedCards, type AgendaItem } from './boardModel'
import { useVoteTotalsQuery } from './useVoteTotals'
import { voteTotalsErrorCodeOf } from './voteTotalsApi'

export const DISCUSS_INTRO =
  'Voting has closed. Topics are listed by total votes, most votes first.'
export const NO_VOTES_CAST =
  'No votes were cast. Topics are listed in their cluster-board order.'
export const TIES_IN_BOARD_ORDER =
  'Topics with the same number of votes are listed in their cluster-board order.'
export const NO_TOPICS = 'There were no topics to vote on.'
export const RESULTS_LOADING = 'Loading results…'
export const RESULTS_LOAD_ERROR = 'Could not load the vote results.'
export const UNGROUPED_NOT_VOTED = 'Ungrouped cards were not part of the vote.'
export const NO_CARDS_IN_CLUSTER = 'No cards in this cluster.'

/** A total as text: `1 vote` or `N votes`. */
export function totalVotesText(total: number): string {
  return total === 1 ? '1 vote' : `${total} votes`
}

/**
 * The line under the intro: the all-zero line, the tie line (two topics share
 * a total, unless every total is 0), or nothing.
 */
function orderNote(items: readonly AgendaItem[]): string | null {
  if (items.every((item) => item.totalVotes === 0)) {
    return NO_VOTES_CAST
  }
  const totals = items.map((item) => item.totalVotes)
  return new Set(totals).size < totals.length ? TIES_IN_BOARD_ORDER : null
}

function cardsOf(
  cluster: BoardCluster,
  cardsById: ReadonlyMap<string, BoardCard>,
): BoardCard[] {
  return cluster.cardIds.flatMap((cardId) => {
    const card = cardsById.get(cardId)
    return card ? [card] : []
  })
}

function AgendaTopic({
  item,
  cards,
}: {
  item: AgendaItem
  cards: readonly BoardCard[]
}) {
  const { cluster, totalVotes } = item
  const headingId = `discuss-cluster-${cluster.clusterId}-heading`
  return (
    <li className="min-w-0 pl-1">
      <section
        aria-labelledby={headingId}
        className="min-w-0 space-y-3 rounded-lg border bg-card p-4 text-card-foreground"
      >
        <ClusterHeading
          id={headingId}
          cluster={cluster}
          cardCount={cards.length}
        />
        <p className="text-sm font-medium">{totalVotesText(totalVotes)}</p>
        {cards.length === 0 ? (
          <p className="text-sm text-muted-foreground">{NO_CARDS_IN_CLUSTER}</p>
        ) : (
          <ul aria-label={`Cards in ${cluster.name}`} className="space-y-2">
            {cards.map((card) => (
              <ClusterCardItem key={card.cardId} card={card} />
            ))}
          </ul>
        )}
      </section>
    </li>
  )
}

export interface DiscussModeProps {
  readonly board: CycleBoard
  /** Called when the totals read says the caller is no longer a member. */
  readonly onLostAccess: () => void
}

/**
 * The Discuss stage (#24): the ranked agenda, the same for every member, the
 * facilitator and the owner included. Topics are listed in the order
 * `get_vote_totals` returns them, with their totals as text. It shows
 * aggregates only: never the caller's own votes (`myVotes`,
 * `votesRemaining`), and it does not read the caller's role. #25 adds
 * statuses and notes.
 */
export function DiscussMode({ board, onLostAccess }: DiscussModeProps) {
  const totalsQuery = useVoteTotalsQuery(board.cycleId, true)
  const lostAccess =
    voteTotalsErrorCodeOf(totalsQuery.error) === 'not_project_member'

  useEffect(() => {
    if (lostAccess) {
      onLostAccess()
    }
  }, [lostAccess, onLostAccess])

  const cardsById = new Map(board.cards.map((card) => [card.cardId, card]))
  const ungrouped = ungroupedCards(board)
  const agenda =
    totalsQuery.data === undefined
      ? undefined
      : rankedAgenda(board, totalsQuery.data)

  let results: React.ReactNode
  if (board.clusters.length === 0) {
    results = <p className="text-sm">{NO_TOPICS}</p>
  } else if (agenda === null || (agenda === undefined && totalsQuery.isError)) {
    results = (
      <div
        role="alert"
        className="space-y-3 rounded-lg border border-destructive/30 bg-card p-4 text-card-foreground"
      >
        <p className="text-sm">{RESULTS_LOAD_ERROR}</p>
        <Button
          type="button"
          variant="outline"
          onClick={() => {
            void totalsQuery.refetch()
          }}
        >
          Retry
        </Button>
      </div>
    )
  } else if (agenda === undefined) {
    results = (
      <p role="status" className="text-sm text-muted-foreground">
        {RESULTS_LOADING}
      </p>
    )
  } else {
    const note = orderNote(agenda)
    results = (
      <>
        {note !== null ? <p className="text-sm">{note}</p> : null}
        <ol
          aria-label="Agenda"
          className="min-w-0 list-outside list-decimal space-y-4 pl-6 marker:font-semibold"
        >
          {agenda.map((item) => (
            <AgendaTopic
              key={item.cluster.clusterId}
              item={item}
              cards={cardsOf(item.cluster, cardsById)}
            />
          ))}
        </ol>
      </>
    )
  }

  return (
    <div data-testid="discuss-board" className="min-w-0 space-y-4">
      <p className="text-sm">{DISCUSS_INTRO}</p>
      {results}
      {ungrouped.length === 0 ? null : (
        <section
          aria-labelledby="discuss-ungrouped-heading"
          className="min-w-0 space-y-3 rounded-lg border bg-card p-4 text-card-foreground"
        >
          <h3
            id="discuss-ungrouped-heading"
            className="text-base font-semibold"
          >
            Ungrouped ({ungrouped.length})
          </h3>
          <p className="text-sm text-muted-foreground">{UNGROUPED_NOT_VOTED}</p>
          <ul
            aria-label="Ungrouped cards"
            className="grid min-w-0 grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-3"
          >
            {ungrouped.map((card) => (
              <ClusterCardItem key={card.cardId} card={card} />
            ))}
          </ul>
        </section>
      )}
    </div>
  )
}
