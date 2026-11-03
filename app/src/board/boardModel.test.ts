import { describe, expect, it } from 'vitest'
import type { BoardCluster } from './boardApi'
import { discussionByTopic, rankedAgenda } from './boardModel'
import type { DiscussionNote, TopicStatus } from './discussionApi'

function cluster(clusterId: string, name: string): BoardCluster {
  return { clusterId, name, source: 'manual', cardIds: [] }
}

const A = cluster('a0000000-0000-4000-8000-000000000001', 'Alpha')
const B = cluster('b0000000-0000-4000-8000-000000000002', 'Beta')
const C = cluster('c0000000-0000-4000-8000-000000000003', 'Gamma')
const board = { clusters: [A, B, C] }

describe('rankedAgenda', () => {
  it("keeps the totals' order exactly, even when it is not by total", () => {
    const agenda = rankedAgenda(board, [
      { clusterId: C.clusterId, totalVotes: 1 },
      { clusterId: A.clusterId, totalVotes: 5 },
      { clusterId: B.clusterId, totalVotes: 0 },
    ])
    expect(agenda).toEqual([
      { cluster: C, totalVotes: 1 },
      { cluster: A, totalVotes: 5 },
      { cluster: B, totalVotes: 0 },
    ])
  })

  it('returns an empty agenda for no clusters and no totals', () => {
    expect(rankedAgenda({ clusters: [] }, [])).toEqual([])
  })

  it.each([
    [
      'a missing cluster',
      [
        { clusterId: A.clusterId, totalVotes: 1 },
        { clusterId: B.clusterId, totalVotes: 1 },
      ],
    ],
    [
      'an extra cluster',
      [
        { clusterId: A.clusterId, totalVotes: 1 },
        { clusterId: B.clusterId, totalVotes: 1 },
        { clusterId: C.clusterId, totalVotes: 1 },
        { clusterId: 'd0000000-0000-4000-8000-000000000004', totalVotes: 1 },
      ],
    ],
    [
      'an unknown cluster in place of one',
      [
        { clusterId: A.clusterId, totalVotes: 1 },
        { clusterId: B.clusterId, totalVotes: 1 },
        { clusterId: 'd0000000-0000-4000-8000-000000000004', totalVotes: 1 },
      ],
    ],
    [
      'a repeated id',
      [
        { clusterId: A.clusterId, totalVotes: 1 },
        { clusterId: A.clusterId, totalVotes: 1 },
        { clusterId: B.clusterId, totalVotes: 1 },
      ],
    ],
    [
      'a negative total',
      [
        { clusterId: A.clusterId, totalVotes: -1 },
        { clusterId: B.clusterId, totalVotes: 1 },
        { clusterId: C.clusterId, totalVotes: 1 },
      ],
    ],
    [
      'a non-integer total',
      [
        { clusterId: A.clusterId, totalVotes: 0.5 },
        { clusterId: B.clusterId, totalVotes: 1 },
        { clusterId: C.clusterId, totalVotes: 1 },
      ],
    ],
  ])('returns null for %s', (_label, totals) => {
    expect(rankedAgenda(board, totals)).toBeNull()
  })

  it('returns null when the board repeats a cluster id', () => {
    expect(
      rankedAgenda({ clusters: [A, A] }, [
        { clusterId: A.clusterId, totalVotes: 1 },
        { clusterId: A.clusterId, totalVotes: 1 },
      ]),
    ).toBeNull()
  })
})

function note(noteId: string, clusterId: string | null): DiscussionNote {
  return {
    noteId,
    clusterId,
    text: `Note ${noteId}`,
    authorName: 'Bob',
    isMine: false,
    createdAt: '2026-11-03T12:00:00Z',
    editedAt: null,
  }
}

function statuses(...clusters: BoardCluster[]): TopicStatus[] {
  return clusters.map((c) => ({
    clusterId: c.clusterId,
    discussionStatus: 'pending',
  }))
}

describe('discussionByTopic', () => {
  it("keeps each topic's notes in server order and splits off the general notes", () => {
    const notes = [
      note('n3', C.clusterId),
      note('g2', null),
      note('n1', A.clusterId),
      note('n2', C.clusterId),
      note('g1', null),
    ]
    const result = discussionByTopic(board, {
      statuses: [
        { clusterId: B.clusterId, discussionStatus: 'skipped' },
        { clusterId: A.clusterId, discussionStatus: 'discussed' },
        { clusterId: C.clusterId, discussionStatus: 'deferred' },
      ],
      notes,
    })
    expect(result).not.toBeNull()
    expect(result?.general.map((n) => n.noteId)).toEqual(['g2', 'g1'])
    expect(result?.topics.get(A.clusterId)).toEqual({
      status: 'discussed',
      notes: [notes[2]],
    })
    expect(result?.topics.get(B.clusterId)).toEqual({
      status: 'skipped',
      notes: [],
    })
    expect(result?.topics.get(C.clusterId)?.notes.map((n) => n.noteId)).toEqual(
      ['n3', 'n2'],
    )
    expect(result?.topics.size).toBe(3)
  })

  it('zero clusters with only general notes', () => {
    const result = discussionByTopic(
      { clusters: [] },
      { statuses: [], notes: [note('g1', null)] },
    )
    expect(result?.topics.size).toBe(0)
    expect(result?.general.map((n) => n.noteId)).toEqual(['g1'])
  })

  it.each([
    ['a missing status cluster', statuses(A, B), []],
    [
      'an extra status cluster',
      [
        ...statuses(A, B, C),
        {
          clusterId: 'd0000000-0000-4000-8000-000000000004',
          discussionStatus: 'pending' as const,
        },
      ],
      [],
    ],
    ['a repeated status cluster', statuses(A, B, B), []],
    [
      'an unknown status cluster',
      [...statuses(A, B), ...statuses(cluster('x', 'X'))],
      [],
    ],
    [
      'a note on an unknown cluster',
      statuses(A, B, C),
      [note('n1', 'd0000000-0000-4000-8000-000000000004')],
    ],
  ])('returns null for %s', (_label, topicStatuses, notes) => {
    expect(
      discussionByTopic(board, { statuses: topicStatuses, notes }),
    ).toBeNull()
  })
})
