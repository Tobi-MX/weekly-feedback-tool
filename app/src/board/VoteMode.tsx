import { useEffect, useRef, useState } from 'react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import type { BoardCard, BoardCluster, CycleBoard } from './boardApi'
import { ClusterCardItem, ClusterHeading } from './BoardCards'
import { ungroupedCards } from './boardModel'
import {
  voteErrorCodeOf,
  voteErrorMessage,
  type VoteOperation,
} from './voteErrors'
import { shownVotes, useVoteWrite, type VoteWrite } from './useVotes'

export const VOTE_INTRO =
  'Vote for the topics you most want to discuss. You have 3 votes and can put more than one on the same topic. You can change your votes until voting closes.'
export const VOTE_TOTALS_HIDDEN =
  'Vote totals are hidden from everyone, the facilitator included, until voting closes.'
export const VOTES_USED_UP = 'You have used all 3 votes.'
export const VOTES_WAITING =
  'Voting closes when everyone has voted or the facilitator closes it. Until then, you can remove a vote and place it on another topic.'
export const NO_VOTES_LEFT_ANNOUNCEMENT =
  'You have no votes left. Remove a vote from another topic to place it here.'
export const NO_CLUSTERS_TO_VOTE_ON = 'There are no clusters to vote on.'
export const UNGROUPED_NO_VOTES = 'Ungrouped cards cannot receive votes.'
export const NO_CARDS_IN_CLUSTER = 'No cards in this cluster.'

/** The counter's first line for the votes the caller has left. */
export function votesLeftText(votesRemaining: number): string {
  if (votesRemaining === 0) {
    return VOTES_USED_UP
  }
  return votesRemaining === 1
    ? 'You have 1 vote left.'
    : `You have ${votesRemaining} votes left.`
}

/** What the status region says once a vote write has settled. */
export function voteAnnouncement(
  operation: VoteOperation,
  name: string,
  voteCount: number,
  votesRemaining: number,
): string {
  const done =
    operation === 'add'
      ? `Vote added to ${name}.`
      : `Vote removed from ${name}.`
  return `${done} Your votes on it: ${voteCount}. Votes left: ${votesRemaining}.`
}

interface VoteClusterProps {
  readonly cluster: BoardCluster
  readonly cards: readonly BoardCard[]
  readonly ownVotes: number
  readonly addUnavailable: boolean
  readonly removeUnavailable: boolean
  readonly onAdd: () => void
  readonly onRemove: () => void
}

/**
 * One cluster: its heading, the caller's own votes on it, its two vote
 * buttons, and its cards read-only. The vote controls are never inside a
 * card, so an anonymous card's DOM is the same for every viewer. Only the
 * caller's own numbers and the border vary with votes.
 */
function VoteCluster({
  cluster,
  cards,
  ownVotes,
  addUnavailable,
  removeUnavailable,
  onAdd,
  onRemove,
}: VoteClusterProps) {
  const { clusterId, name } = cluster
  const headingId = `vote-cluster-${clusterId}-heading`
  return (
    <section
      aria-labelledby={headingId}
      className={cn(
        'min-w-0 space-y-3 rounded-lg bg-card p-4 text-card-foreground',
        ownVotes > 0 ? 'border-2 border-primary' : 'border',
      )}
    >
      <ClusterHeading
        id={headingId}
        cluster={cluster}
        cardCount={cards.length}
      />
      <p className="text-sm">Your votes: {ownVotes}</p>
      <div className="flex flex-wrap gap-2">
        <Button
          type="button"
          variant="outline"
          size="sm"
          aria-label={`Add vote to ${name}`}
          aria-disabled={addUnavailable ? 'true' : undefined}
          className="aria-disabled:opacity-50"
          onClick={onAdd}
        >
          Add vote
        </Button>
        <Button
          type="button"
          variant="outline"
          size="sm"
          aria-label={`Remove vote from ${name}`}
          aria-disabled={removeUnavailable ? 'true' : undefined}
          className="aria-disabled:opacity-50"
          onClick={onRemove}
        >
          Remove vote
        </Button>
      </div>
      {cards.length === 0 ? (
        <p className="text-sm text-muted-foreground">{NO_CARDS_IN_CLUSTER}</p>
      ) : (
        <ul aria-label={`Cards in ${name}`} className="space-y-2">
          {cards.map((card) => (
            <ClusterCardItem key={card.cardId} card={card} />
          ))}
        </ul>
      )}
    </section>
  )
}

export interface VoteModeProps {
  readonly board: CycleBoard
  /** Called when a write says the caller is no longer a member. */
  readonly onLostAccess: () => void
}

/**
 * The Vote stage (#23). Every member, the facilitator and the owner
 * included, gets the same view: the clusters in the server's order, each
 * with the caller's own votes and Add and Remove, and a counter of the votes
 * left. It never shows or fetches a vote total, a rank, or anything about
 * other members' votes. The numbers come only from the board (`myVotes`,
 * `votesRemaining`) plus the one pending write's overlay.
 */
export function VoteMode({ board, onLostAccess }: VoteModeProps) {
  const { cycleId } = board
  const writer = useVoteWrite(cycleId, (error, write) => {
    const message = voteErrorMessage(voteErrorCodeOf(error), write.operation)
    if (message === null) {
      onLostAccess()
    } else {
      toast.error(message)
    }
  })
  const shown = shownVotes(board, writer.pendingWrite)
  // A synchronous second press (a double click, a held Enter, another
  // cluster) must not send a second write before React re-renders.
  const writingRef = useRef(false)
  const mountedRef = useRef(false)
  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
    }
  }, [])

  // Each announcement gets a new id, which remounts the live region's text,
  // so the same message twice is read twice.
  const [announcement, setAnnouncementState] = useState({ text: '', id: 0 })
  const announce = (text: string) => {
    setAnnouncementState((current) => ({ text, id: current.id + 1 }))
  }

  const busy = writer.isPending

  const send = (operation: VoteOperation, cluster: BoardCluster) => {
    writingRef.current = true
    const write: VoteWrite = {
      operation,
      clusterId: cluster.clusterId,
      clusterName: cluster.name,
      myVotes: board.myVotes,
      votesRemaining: board.votesRemaining,
    }
    writer
      .mutateAsync(write)
      .then(
        (result) => {
          // A write that settles after the stage moved on says nothing.
          if (mountedRef.current) {
            announce(
              voteAnnouncement(
                operation,
                write.clusterName,
                result.voteCount,
                result.votesRemaining,
              ),
            )
          }
        },
        () => {
          // The toast (or the not-found state) was shown by onFailure.
        },
      )
      .finally(() => {
        writingRef.current = false
      })
  }

  const onAdd = (cluster: BoardCluster) => {
    if (writingRef.current || busy) {
      return
    }
    if (shown.votesRemaining === 0) {
      announce(NO_VOTES_LEFT_ANNOUNCEMENT)
      return
    }
    send('add', cluster)
  }

  const onRemove = (cluster: BoardCluster) => {
    if (writingRef.current || busy || shown.countOf(cluster.clusterId) === 0) {
      return
    }
    send('remove', cluster)
  }

  const cardsById = new Map(board.cards.map((card) => [card.cardId, card]))
  const ungrouped = ungroupedCards(board)
  const { clusters } = board

  return (
    <div data-testid="vote-board" className="min-w-0 space-y-4">
      <div className="min-w-0 space-y-2">
        <p className="text-sm">{VOTE_INTRO}</p>
        <p className="text-sm text-muted-foreground">{VOTE_TOTALS_HIDDEN}</p>
      </div>

      {clusters.length === 0 ? (
        <p className="text-sm">{NO_CLUSTERS_TO_VOTE_ON}</p>
      ) : (
        <div className="min-w-0 space-y-1 rounded-lg border bg-card p-3 text-card-foreground">
          <p className="text-sm font-medium">
            {votesLeftText(shown.votesRemaining)}
          </p>
          {shown.votesRemaining === 0 ? (
            <p className="text-sm">{VOTES_WAITING}</p>
          ) : null}
        </div>
      )}

      <p
        role="status"
        aria-live="polite"
        aria-atomic="true"
        className="sr-only"
      >
        <span key={announcement.id}>{announcement.text}</span>
      </p>

      {clusters.length === 0 ? null : (
        <div className="grid min-w-0 grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {clusters.map((cluster) => {
            const ownVotes = shown.countOf(cluster.clusterId)
            const cards = cluster.cardIds.flatMap((cardId) => {
              const card = cardsById.get(cardId)
              return card ? [card] : []
            })
            return (
              <VoteCluster
                key={cluster.clusterId}
                cluster={cluster}
                cards={cards}
                ownVotes={ownVotes}
                addUnavailable={busy || shown.votesRemaining === 0}
                removeUnavailable={busy || ownVotes === 0}
                onAdd={() => {
                  onAdd(cluster)
                }}
                onRemove={() => {
                  onRemove(cluster)
                }}
              />
            )
          })}
        </div>
      )}

      {ungrouped.length === 0 ? null : (
        <section
          aria-labelledby="vote-ungrouped-heading"
          className="min-w-0 space-y-3 rounded-lg border bg-card p-4 text-card-foreground"
        >
          <h3 id="vote-ungrouped-heading" className="text-base font-semibold">
            Ungrouped ({ungrouped.length})
          </h3>
          <p className="text-sm text-muted-foreground">{UNGROUPED_NO_VOTES}</p>
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
