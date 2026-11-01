import type { CycleStatus } from '@/cycles/cycleStatus'
import type { BoardCard, CycleBoard } from './boardApi'

/** The retrospective stages the indicator shows, in order. */
export const BOARD_STAGES = ['reveal', 'cluster', 'vote', 'discuss'] as const

export type BoardStage = (typeof BOARD_STAGES)[number]

const STAGE_NAMES: Record<CycleStatus, string> = {
  collecting: 'Not started',
  reveal: 'Reveal',
  cluster: 'Cluster',
  vote: 'Vote',
  discuss: 'Discuss',
  closed: 'Closed',
}

/** The stage's name as the board shows and announces it. */
export function stageName(status: CycleStatus): string {
  return STAGE_NAMES[status]
}

export function isBoardStage(status: CycleStatus): status is BoardStage {
  return (BOARD_STAGES as readonly CycleStatus[]).includes(status)
}

/**
 * Whether a response is one the database can produce: every revealed stage
 * has `is_revealed`, and `collecting` never does (#10's and #14's CHECKs).
 * Anything else is shown as a load error, with no card text.
 */
export function isConsistentBoard(board: CycleBoard): boolean {
  if (board.status === 'collecting') {
    return !board.isRevealed
  }
  if (board.status === 'closed') {
    return true
  }
  return board.isRevealed
}

/**
 * A card's label. An anonymous card is always "Anonymous", for its author
 * too: no "(you)" and no other marker.
 */
export function boardCardLabel(card: BoardCard): string {
  if (card.isAnonymous) {
    return 'Anonymous'
  }
  if (card.authorDisplayName === null) {
    return 'Deleted user'
  }
  return card.isMine
    ? `${card.authorDisplayName} (you)`
    : card.authorDisplayName
}

/**
 * The cards in no cluster, in the response's order: a filter, never a sort.
 */
export function ungroupedCards(board: CycleBoard): readonly BoardCard[] {
  const clustered = new Set(
    board.clusters.flatMap((cluster) => cluster.cardIds),
  )
  return board.cards.filter((card) => !clustered.has(card.cardId))
}

/**
 * The cluster and ungrouped-card counts the "Start voting" confirmation shows
 * before its own copy.
 */
export function votingSummary(board: CycleBoard): string {
  const clusterCount = board.clusters.length
  if (clusterCount === 0) {
    return 'There are no clusters yet, so there is nothing to vote on.'
  }
  const ungroupedCount = ungroupedCards(board).length
  const clusters = clusterCount === 1 ? '1 cluster' : `${clusterCount} clusters`
  const cards =
    ungroupedCount === 1
      ? '1 ungrouped card'
      : `${ungroupedCount} ungrouped cards`
  return `There ${clusterCount === 1 ? 'is' : 'are'} ${clusters} and ${cards}. Ungrouped cards cannot receive votes.`
}
