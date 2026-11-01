import { describe, expect, it } from 'vitest'
import type { BoardCard, BoardCluster, CycleBoard } from './boardApi'
import {
  applyPendingMove,
  cardLocation,
  dropPosition,
  isNoOpMove,
  moveAnnouncement,
  moveButtonLabel,
  moveMenuItems,
} from './cardMove'

function card(cardId: string, text = `Card ${cardId}`): BoardCard {
  return { cardId, category: 'start', text, isAnonymous: true }
}

function cluster(
  clusterId: string,
  name: string,
  cardIds: readonly string[],
): BoardCluster {
  return { clusterId, name, source: 'manual', cardIds }
}

// Card order is the server's (here deliberately not alphabetical).
const BOARD: CycleBoard = {
  cycleId: 'cycle',
  status: 'cluster',
  isRevealed: true,
  cards: ['e', 'a', 'd', 'b', 'c', 'f'].map((id) => card(id)),
  clusters: [
    cluster('X', 'Process', ['a', 'b', 'c']),
    cluster('Y', 'Tools', ['d']),
  ],
}

function ids(board: CycleBoard, clusterId: string): readonly string[] {
  return (
    board.clusters.find((entry) => entry.clusterId === clusterId)?.cardIds ?? []
  )
}

describe('applyPendingMove', () => {
  it.each<[string, string, number | null, readonly string[]]>([
    ['a', 'X', 2, ['b', 'c', 'a']],
    ['c', 'X', 0, ['c', 'a', 'b']],
    ['b', 'X', 1, ['a', 'b', 'c']],
    ['d', 'X', 1, ['a', 'd', 'b', 'c']],
    ['d', 'X', 99, ['a', 'b', 'c', 'd']],
    ['d', 'X', null, ['a', 'b', 'c', 'd']],
    ['e', 'X', 0, ['e', 'a', 'b', 'c']],
  ])(
    'move %s into %s at %s gives %j',
    (cardId, clusterId, position, expected) => {
      const result = applyPendingMove(BOARD, { cardId, clusterId, position })
      expect(ids(result, clusterId)).toEqual(expected)
    },
  )

  it('between clusters removes the card from the source and keeps the rest in server order', () => {
    const result = applyPendingMove(BOARD, {
      cardId: 'b',
      clusterId: 'Y',
      position: 0,
    })
    expect(ids(result, 'X')).toEqual(['a', 'c'])
    expect(ids(result, 'Y')).toEqual(['b', 'd'])
    expect(result.cards).toBe(BOARD.cards)
  })

  it('to Ungrouped removes the card from every cluster; Ungrouped stays in card order', () => {
    const result = applyPendingMove(BOARD, {
      cardId: 'b',
      clusterId: null,
      position: null,
    })
    expect(ids(result, 'X')).toEqual(['a', 'c'])
    expect(result.clusters[1]).toBe(BOARD.clusters[1])
    expect(cardLocation(result, 'b')).toEqual({ clusterId: null })
  })

  it('returns the board unchanged when the target cluster or the card is missing', () => {
    expect(
      applyPendingMove(BOARD, { cardId: 'a', clusterId: 'Z', position: 0 }),
    ).toBe(BOARD)
    expect(
      applyPendingMove(BOARD, { cardId: 'z', clusterId: 'X', position: 0 }),
    ).toBe(BOARD)
    expect(
      applyPendingMove(BOARD, { cardId: 'z', clusterId: null, position: null }),
    ).toBe(BOARD)
  })
})

describe('isNoOpMove', () => {
  it('detects moves that leave the card where it is', () => {
    expect(
      isNoOpMove(BOARD, { cardId: 'e', clusterId: null, position: null }),
    ).toBe(true)
    expect(
      isNoOpMove(BOARD, { cardId: 'b', clusterId: 'X', position: 1 }),
    ).toBe(true)
    expect(
      isNoOpMove(BOARD, { cardId: 'c', clusterId: 'X', position: null }),
    ).toBe(true)
    expect(
      isNoOpMove(BOARD, { cardId: 'c', clusterId: 'X', position: 9 }),
    ).toBe(true)
    expect(
      isNoOpMove(BOARD, { cardId: 'b', clusterId: 'X', position: null }),
    ).toBe(false)
    expect(
      isNoOpMove(BOARD, { cardId: 'b', clusterId: 'Y', position: null }),
    ).toBe(false)
    expect(
      isNoOpMove(BOARD, { cardId: 'b', clusterId: null, position: null }),
    ).toBe(false)
    expect(
      isNoOpMove(BOARD, { cardId: 'z', clusterId: 'X', position: null }),
    ).toBe(true)
  })
})

describe('moveMenuItems', () => {
  const labels = (cardId: string) =>
    moveMenuItems(BOARD, cardId).map((item) => item.label)

  it('lists exactly the possible moves in order', () => {
    expect(labels('e')).toEqual(['Move to Process', 'Move to Tools'])
    expect(labels('a')).toEqual([
      'Move down',
      'Move to Ungrouped',
      'Move to Tools',
    ])
    expect(labels('b')).toEqual([
      'Move up',
      'Move down',
      'Move to Ungrouped',
      'Move to Tools',
    ])
    expect(labels('c')).toEqual([
      'Move up',
      'Move to Ungrouped',
      'Move to Tools',
    ])
    expect(labels('d')).toEqual(['Move to Ungrouped', 'Move to Process'])
    expect(
      moveMenuItems({ ...BOARD, clusters: [] }, 'e').map((item) => item.label),
    ).toEqual([])
  })

  it('Move up and Move down send the neighbouring positions; Move to appends', () => {
    expect(moveMenuItems(BOARD, 'b').map((item) => item.move)).toEqual([
      { cardId: 'b', clusterId: 'X', position: 0 },
      { cardId: 'b', clusterId: 'X', position: 2 },
      { cardId: 'b', clusterId: null, position: null },
      { cardId: 'b', clusterId: 'Y', position: null },
    ])
  })
})

describe('labels and announcements', () => {
  it('cuts the card text to 40 characters plus an ellipsis', () => {
    expect(moveButtonLabel(card('a', 'Short'))).toBe('Move card: Short')
    expect(moveButtonLabel(card('a', 'x'.repeat(40)))).toBe(
      `Move card: ${'x'.repeat(40)}`,
    )
    expect(moveButtonLabel(card('a', `${'y'.repeat(40)}z`))).toBe(
      `Move card: ${'y'.repeat(40)}…`,
    )
  })

  it('announces the cluster, position, and size, or Ungrouped', () => {
    expect(moveAnnouncement(BOARD, 'b')).toBe(
      'Moved card to Process, position 2 of 3.',
    )
    expect(moveAnnouncement(BOARD, 'e')).toBe('Moved card to Ungrouped.')
  })

  it('converts a drop index among all displayed cards to a move_card position', () => {
    expect(dropPosition(BOARD, 'a', 'X', 3)).toBe(2)
    expect(dropPosition(BOARD, 'c', 'X', 0)).toBe(0)
    expect(dropPosition(BOARD, 'b', 'X', 1)).toBe(1)
    expect(dropPosition(BOARD, 'd', 'X', 2)).toBe(2)
    expect(dropPosition(BOARD, 'd', 'X', null)).toBeNull()
  })
})
