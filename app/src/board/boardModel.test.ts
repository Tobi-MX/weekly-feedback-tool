import { describe, expect, it } from 'vitest'
import type { BoardCluster } from './boardApi'
import { rankedAgenda } from './boardModel'

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
