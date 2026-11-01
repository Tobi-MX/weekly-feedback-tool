import type { BoardCard, CycleBoard } from './boardApi'

/**
 * One card move as `move_card` takes it. A null `clusterId` is Ungrouped (and
 * then `position` is null). `position` is the card's zero-based index in the
 * target after the move, counted among the target's other cards; null means
 * the end.
 */
export interface CardMove {
  readonly cardId: string
  readonly clusterId: string | null
  readonly position: number | null
}

/** The `dataTransfer` type a dragged card carries: its id, nothing else. */
export const CARD_DRAG_TYPE = 'application/x-weekly-feedback-card'

/** Where a card is on a board: in a cluster at an index, or ungrouped. */
export type CardLocation =
  | {
      readonly clusterId: string
      readonly name: string
      readonly index: number
      readonly size: number
    }
  | { readonly clusterId: null }

/** The card's location, or null when the card is not on the board. */
export function cardLocation(
  board: CycleBoard,
  cardId: string,
): CardLocation | null {
  if (!board.cards.some((card) => card.cardId === cardId)) {
    return null
  }
  for (const cluster of board.clusters) {
    const index = cluster.cardIds.indexOf(cardId)
    if (index !== -1) {
      return {
        clusterId: cluster.clusterId,
        name: cluster.name,
        index,
        size: cluster.cardIds.length,
      }
    }
  }
  return { clusterId: null }
}

/** A string that changes whenever the card's place changes. */
export function locationKey(location: CardLocation | null): string {
  if (location === null) {
    return 'gone'
  }
  return location.clusterId === null
    ? 'ungrouped'
    : `${location.clusterId}:${String(location.index)}`
}

/**
 * The board as it looks with a pending move applied: the card leaves every
 * cluster and enters the target at the clamped index. Everything else keeps
 * the server's order; nothing is sorted. Ungrouped is derived, so a card sent
 * there takes its response-order place. A move whose card or target cluster
 * is not on the board returns the board unchanged.
 */
export function applyPendingMove(
  board: CycleBoard,
  move: CardMove,
): CycleBoard {
  if (!board.cards.some((card) => card.cardId === move.cardId)) {
    return board
  }
  if (
    move.clusterId !== null &&
    !board.clusters.some((cluster) => cluster.clusterId === move.clusterId)
  ) {
    return board
  }
  return {
    ...board,
    clusters: board.clusters.map((cluster) => {
      const others = cluster.cardIds.filter((id) => id !== move.cardId)
      if (cluster.clusterId !== move.clusterId) {
        return others.length === cluster.cardIds.length
          ? cluster
          : { ...cluster, cardIds: others }
      }
      const index = Math.min(move.position ?? others.length, others.length)
      return {
        ...cluster,
        cardIds: [
          ...others.slice(0, index),
          move.cardId,
          ...others.slice(index),
        ],
      }
    }),
  }
}

/** Whether a move would leave the card exactly where it is. */
export function isNoOpMove(board: CycleBoard, move: CardMove): boolean {
  const location = cardLocation(board, move.cardId)
  if (location === null) {
    return true
  }
  if (move.clusterId === null) {
    return location.clusterId === null
  }
  if (location.clusterId !== move.clusterId) {
    return false
  }
  const othersCount = location.size - 1
  return Math.min(move.position ?? othersCount, othersCount) === location.index
}

/** One item of a card's Move menu. */
export interface MoveMenuItem {
  readonly key: string
  readonly label: string
  readonly move: CardMove
}

/**
 * A card's Move menu, in order: "Move up" and "Move down" where that
 * direction exists, "Move to Ungrouped" for a clustered card, then "Move to
 * <name>" for every other cluster in response order (appending at the end).
 */
export function moveMenuItems(
  board: CycleBoard,
  cardId: string,
): readonly MoveMenuItem[] {
  const location = cardLocation(board, cardId)
  if (location === null) {
    return []
  }
  const items: MoveMenuItem[] = []
  if (location.clusterId !== null) {
    const { clusterId, index, size } = location
    if (index > 0) {
      items.push({
        key: 'up',
        label: 'Move up',
        move: { cardId, clusterId, position: index - 1 },
      })
    }
    if (index < size - 1) {
      items.push({
        key: 'down',
        label: 'Move down',
        move: { cardId, clusterId, position: index + 1 },
      })
    }
    items.push({
      key: 'ungrouped',
      label: 'Move to Ungrouped',
      move: { cardId, clusterId: null, position: null },
    })
  }
  for (const cluster of board.clusters) {
    if (cluster.clusterId !== location.clusterId) {
      items.push({
        key: `to:${cluster.clusterId}`,
        label: `Move to ${cluster.name}`,
        move: { cardId, clusterId: cluster.clusterId, position: null },
      })
    }
  }
  return items
}

const LABEL_LIMIT = 40

/** The Move button's accessible name: the card text cut to 40 characters. */
export function moveButtonLabel(card: BoardCard): string {
  const characters = [...card.text]
  const text =
    characters.length > LABEL_LIMIT
      ? `${characters.slice(0, LABEL_LIMIT).join('')}…`
      : card.text
  return `Move card: ${text}`
}

/** What the status region says after a successful move. */
export function moveAnnouncement(board: CycleBoard, cardId: string): string {
  const location = cardLocation(board, cardId)
  if (location === null || location.clusterId === null) {
    return 'Moved card to Ungrouped.'
  }
  return `Moved card to ${location.name}, position ${String(location.index + 1)} of ${String(location.size)}.`
}

/**
 * The drop position inside a cluster's list from the insertion index among
 * every displayed card (the dragged card included), as `move_card` counts it
 * (the dragged card excluded).
 */
export function dropPosition(
  board: CycleBoard,
  cardId: string,
  clusterId: string,
  insertionIndex: number | null,
): number | null {
  if (insertionIndex === null) {
    return null
  }
  const location = cardLocation(board, cardId)
  if (
    location !== null &&
    location.clusterId === clusterId &&
    insertionIndex > location.index
  ) {
    return insertionIndex - 1
  }
  return insertionIndex
}

/**
 * Where a card sits relative to the cards around it: its group (a cluster id,
 * "ungrouped", or "gone") and, in a cluster, the cards before and after it.
 */
export interface CardAnchor {
  readonly group: string
  readonly before: readonly string[]
  readonly after: readonly string[]
}

export function cardAnchor(board: CycleBoard, cardId: string): CardAnchor {
  const location = cardLocation(board, cardId)
  if (location === null) {
    return { group: 'gone', before: [], after: [] }
  }
  if (location.clusterId === null) {
    return { group: 'ungrouped', before: [], after: [] }
  }
  const ids =
    board.clusters.find((cluster) => cluster.clusterId === location.clusterId)
      ?.cardIds ?? []
  return {
    group: location.clusterId,
    before: ids.slice(0, location.index),
    after: ids.slice(location.index + 1),
  }
}

/**
 * Whether the card itself moved between two boards: it changed group, or
 * some card that stayed in its cluster is now on the other side of it. Other
 * cards leaving or joining the cluster do not count.
 */
export function cardMovedItself(was: CardAnchor, now: CardAnchor): boolean {
  if (was.group !== now.group) {
    return true
  }
  const wasBefore = new Set(was.before)
  const wasAfter = new Set(was.after)
  return (
    now.before.some((id) => wasAfter.has(id)) ||
    now.after.some((id) => wasBefore.has(id))
  )
}
