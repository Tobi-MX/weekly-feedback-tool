import { describe, expect, it, vi } from 'vitest'
import {
  actionsWithTopics,
  formatDueDate,
  isOverdue,
  localDateIso,
} from './actionModel'
import type { CycleAction } from './actionsApi'
import type { BoardCluster, CycleBoard } from './boardApi'

// vi.stubEnv sets process.env.TZ, which Node applies to local dates at once.
// setupTests restores it after every test with vi.unstubAllEnvs().
function setTimeZone(zone: string): void {
  vi.stubEnv('TZ', zone)
}

const T = '2026-11-03T12:00:00.000000+00:00'

function cluster(id: string, name: string): BoardCluster {
  return { clusterId: id, name, source: 'manual', cardIds: [] }
}

const X = cluster('x', 'Docs')
const Y = cluster('y', 'Process')

const board: CycleBoard = {
  cycleId: 'cycle',
  status: 'discuss',
  isRevealed: true,
  cards: [],
  clusters: [X, Y],
  myVotes: [],
  votesRemaining: 0,
}

function action(overrides: Partial<CycleAction> = {}): CycleAction {
  return {
    actionId: 'a1',
    clusterId: null,
    description: 'Do it',
    ownerId: 'd',
    ownerName: 'Dan',
    ownerIsMe: false,
    createdByMe: false,
    dueDate: null,
    status: 'open',
    completedAt: null,
    source: 'manual',
    createdAt: T,
    updatedAt: T,
    ...overrides,
  }
}

describe('actionsWithTopics', () => {
  it('keeps server order and attaches each topic', () => {
    const list = [
      action({ actionId: 'a3', clusterId: 'y' }),
      action({ actionId: 'a1', clusterId: null }),
      action({ actionId: 'a2', clusterId: 'x' }),
    ]
    expect(actionsWithTopics(board, list)).toEqual([
      { action: list[0], topic: Y },
      { action: list[1], topic: null },
      { action: list[2], topic: X },
    ])
  })

  it('returns an empty list for no actions', () => {
    expect(actionsWithTopics(board, [])).toEqual([])
  })

  it('returns null for an unknown cluster_id', () => {
    expect(actionsWithTopics(board, [action({ clusterId: 'gone' })])).toBeNull()
  })

  it('returns null for a repeated action_id', () => {
    expect(
      actionsWithTopics(board, [
        action({ actionId: 'a1' }),
        action({ actionId: 'a1', clusterId: 'x' }),
      ]),
    ).toBeNull()
  })
})

describe('isOverdue', () => {
  const today = '2026-11-03'

  it('is true for an open action due yesterday', () => {
    expect(isOverdue(action({ dueDate: '2026-11-02' }), today)).toBe(true)
  })

  it('is false for today, tomorrow, and no date', () => {
    expect(isOverdue(action({ dueDate: today }), today)).toBe(false)
    expect(isOverdue(action({ dueDate: '2026-11-04' }), today)).toBe(false)
    expect(isOverdue(action({ dueDate: null }), today)).toBe(false)
  })

  it('is false for a done action due last year', () => {
    expect(
      isOverdue(
        action({ dueDate: '2025-11-03', status: 'done', completedAt: T }),
        today,
      ),
    ).toBe(false)
  })
})

describe('localDateIso', () => {
  it.each(['UTC', 'America/Los_Angeles', 'Asia/Tokyo'])(
    'returns the local calendar date in %s',
    (zone) => {
      setTimeZone(zone)
      expect(localDateIso(new Date(2026, 10, 3, 23, 30))).toBe('2026-11-03')
      expect(localDateIso(new Date(2026, 10, 4, 0, 30))).toBe('2026-11-04')
      expect(localDateIso(new Date(2026, 0, 1, 0, 0))).toBe('2026-01-01')
    },
  )
})

describe('formatDueDate', () => {
  it.each(['UTC', 'America/Los_Angeles', 'Asia/Tokyo'])(
    'formats 2026-11-12 as Nov 12, 2026 in %s',
    (zone) => {
      setTimeZone(zone)
      expect(formatDueDate('2026-11-12')).toBe('Nov 12, 2026')
      expect(formatDueDate('2000-01-01')).toBe('Jan 1, 2000')
      expect(formatDueDate('2099-12-31')).toBe('Dec 31, 2099')
    },
  )
})
