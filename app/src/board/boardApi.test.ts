import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  BoardApiError,
  boardErrorCodeOf,
  type BoardErrorCode,
} from './boardErrors'
import { cycleBoardQueryKey } from './boardKeys'

const state = vi.hoisted(() => ({ client: null as unknown }))

vi.mock('../auth/supabaseClient', () => ({
  get supabase() {
    return state.client
  },
}))

const { fetchCycleBoard } =
  await vi.importActual<typeof import('./boardApi')>('./boardApi')

interface DbResult {
  readonly data: unknown
  readonly error: { readonly message: string; readonly code?: string } | null
}

const CYCLE_ID = '30000000-0000-4000-8000-000000000001'

const anonymousCard = {
  card_id: 'c2000000-0000-4000-8000-000000000001',
  category: 'stop',
  text: 'Too many meetings',
  is_anonymous: true,
}

const attributedCard = {
  card_id: 'c1000000-0000-4000-8000-000000000001',
  category: 'start',
  text: 'Pair more',
  is_anonymous: false,
  is_mine: true,
  author_display_name: 'Ada',
}

const deletedAuthorCard = {
  card_id: 'c3000000-0000-4000-8000-000000000001',
  category: 'continue',
  text: 'Demos',
  is_anonymous: false,
  is_mine: false,
  author_display_name: null,
}

// Ids out of alphabetical order: the parse keeps the server's order.
const processCluster = {
  cluster_id: 'f1000000-0000-4000-8000-000000000001',
  name: 'Process',
  source: 'manual',
  card_ids: [deletedAuthorCard.card_id, anonymousCard.card_id],
}

const emptyAiCluster = {
  cluster_id: 'a1000000-0000-4000-8000-000000000002',
  name: 'Tools',
  source: 'ai',
  card_ids: [],
}

const board = {
  cycle_id: CYCLE_ID,
  status: 'reveal',
  is_revealed: true,
  cards: [attributedCard, anonymousCard, deletedAuthorCard],
  clusters: [processCluster, emptyAiCluster],
  my_votes: [],
  votes_remaining: 3,
}

// The board's other five top-level keys, without the two vote keys.
const boardWithoutVotes = {
  cycle_id: board.cycle_id,
  status: board.status,
  is_revealed: board.is_revealed,
  cards: board.cards,
  clusters: board.clusters,
}

function createClientMock(result: DbResult) {
  const rpc = vi.fn<
    (name: string, args: Record<string, unknown>) => Promise<DbResult>
  >(() => Promise.resolve(result))
  const from = vi.fn()
  state.client = { rpc, from }
  return { rpc, from }
}

async function captureError(promise: Promise<unknown>): Promise<unknown> {
  return promise.then(
    () => {
      throw new Error('expected a rejection')
    },
    (reason: unknown) => reason,
  )
}

beforeEach(() => {
  state.client = null
  vi.spyOn(console, 'error')
  vi.spyOn(console, 'warn')
  vi.spyOn(console, 'log')
})

describe('fetchCycleBoard', () => {
  it('calls get_cycle_board once with exactly { p_cycle_id }', async () => {
    const fake = createClientMock({ data: board, error: null })

    await fetchCycleBoard(CYCLE_ID)

    expect(fake.rpc).toHaveBeenCalledTimes(1)
    const [name, args] = fake.rpc.mock.calls[0] ?? []
    expect(name).toBe('get_cycle_board')
    expect(args).toStrictEqual({ p_cycle_id: CYCLE_ID })
    expect(fake.from).not.toHaveBeenCalled()
  })

  it('resolves a non-UUID id to not found without a request', async () => {
    const fake = createClientMock({ data: board, error: null })

    await expect(fetchCycleBoard('not-a-uuid')).resolves.toBeNull()
    expect(fake.rpc).not.toHaveBeenCalled()
  })

  it('parses anonymous and attributed cards (with a name and with null) in response order', async () => {
    createClientMock({ data: board, error: null })

    await expect(fetchCycleBoard(CYCLE_ID)).resolves.toStrictEqual({
      cycleId: CYCLE_ID,
      status: 'reveal',
      isRevealed: true,
      cards: [
        {
          cardId: attributedCard.card_id,
          category: 'start',
          text: 'Pair more',
          isAnonymous: false,
          isMine: true,
          authorDisplayName: 'Ada',
        },
        {
          cardId: anonymousCard.card_id,
          category: 'stop',
          text: 'Too many meetings',
          isAnonymous: true,
        },
        {
          cardId: deletedAuthorCard.card_id,
          category: 'continue',
          text: 'Demos',
          isAnonymous: false,
          isMine: false,
          authorDisplayName: null,
        },
      ],
      clusters: [
        {
          clusterId: processCluster.cluster_id,
          name: 'Process',
          source: 'manual',
          cardIds: [deletedAuthorCard.card_id, anonymousCard.card_id],
        },
        {
          clusterId: emptyAiCluster.cluster_id,
          name: 'Tools',
          source: 'ai',
          cardIds: [],
        },
      ],
      myVotes: [],
      votesRemaining: 3,
    })
  })

  it('parses own votes spread over clusters, in response order', async () => {
    createClientMock({
      data: {
        ...board,
        my_votes: [
          { cluster_id: processCluster.cluster_id, vote_count: 2 },
          { cluster_id: emptyAiCluster.cluster_id, vote_count: 1 },
        ],
        votes_remaining: 0,
      },
      error: null,
    })

    const parsed = await fetchCycleBoard(CYCLE_ID)
    expect(parsed?.myVotes).toStrictEqual([
      { clusterId: processCluster.cluster_id, voteCount: 2 },
      { clusterId: emptyAiCluster.cluster_id, voteCount: 1 },
    ])
    expect(parsed?.votesRemaining).toBe(0)
  })

  it('parses 3 stacked votes on one cluster with 0 remaining', async () => {
    createClientMock({
      data: {
        ...board,
        my_votes: [{ cluster_id: emptyAiCluster.cluster_id, vote_count: 3 }],
        votes_remaining: 0,
      },
      error: null,
    })

    const parsed = await fetchCycleBoard(CYCLE_ID)
    expect(parsed?.myVotes).toStrictEqual([
      { clusterId: emptyAiCluster.cluster_id, voteCount: 3 },
    ])
    expect(parsed?.votesRemaining).toBe(0)
  })

  it('parses no votes with 3 remaining', async () => {
    createClientMock({ data: board, error: null })

    const parsed = await fetchCycleBoard(CYCLE_ID)
    expect(parsed?.myVotes).toStrictEqual([])
    expect(parsed?.votesRemaining).toBe(3)
  })

  it('parses an empty board', async () => {
    createClientMock({
      data: {
        ...board,
        status: 'collecting',
        is_revealed: false,
        cards: [],
        clusters: [],
      },
      error: null,
    })

    await expect(fetchCycleBoard(CYCLE_ID)).resolves.toStrictEqual({
      cycleId: CYCLE_ID,
      status: 'collecting',
      isRevealed: false,
      cards: [],
      clusters: [],
      myVotes: [],
      votesRemaining: 3,
    })
  })

  it.each<[string, unknown]>([
    [
      'an anonymous card with is_mine',
      { ...board, cards: [{ ...anonymousCard, is_mine: true }] },
    ],
    [
      'an anonymous card with author_display_name',
      { ...board, cards: [{ ...anonymousCard, author_display_name: 'Ada' }] },
    ],
    [
      'an anonymous card with created_at',
      {
        ...board,
        cards: [{ ...anonymousCard, created_at: '2026-11-01T09:00:00Z' }],
      },
    ],
    [
      'an attributed card missing is_mine',
      {
        ...board,
        cards: [
          {
            card_id: attributedCard.card_id,
            category: 'start',
            text: 'Pair more',
            is_anonymous: false,
            author_display_name: 'Ada',
          },
        ],
      },
    ],
    ['an extra top-level key', { ...board, revealed_at: '2026-11-01' }],
    ['cards: null', { ...board, cards: null }],
    ['an unknown status', { ...board, status: 'open' }],
    [
      'a missing top-level key',
      { cycle_id: CYCLE_ID, status: 'reveal', cards: [] },
    ],
    [
      'an unknown category',
      { ...board, cards: [{ ...anonymousCard, category: 'later' }] },
    ],
    ['null data', null],
    [
      'a missing clusters key',
      {
        cycle_id: CYCLE_ID,
        status: 'reveal',
        is_revealed: true,
        cards: board.cards,
      },
    ],
    ['clusters: null', { ...board, clusters: null }],
    [
      'a cluster with sort_order',
      { ...board, clusters: [{ ...processCluster, sort_order: 1 }] },
    ],
    [
      'a cluster with created_at',
      {
        ...board,
        clusters: [{ ...processCluster, created_at: '2026-11-01T09:00:00Z' }],
      },
    ],
    [
      'a cluster without card_ids',
      {
        ...board,
        clusters: [
          {
            cluster_id: processCluster.cluster_id,
            name: 'Process',
            source: 'manual',
          },
        ],
      },
    ],
    [
      'an unknown cluster source',
      { ...board, clusters: [{ ...processCluster, source: 'robot' }] },
    ],
    [
      'a card_ids entry that is not a UUID',
      { ...board, clusters: [{ ...processCluster, card_ids: ['card-1'] }] },
    ],
    [
      'a card_ids entry that is not in cards',
      {
        ...board,
        clusters: [
          {
            ...processCluster,
            card_ids: ['b9000000-0000-4000-8000-000000000009'],
          },
        ],
      },
    ],
    [
      'a card id in two clusters',
      {
        ...board,
        clusters: [
          processCluster,
          { ...emptyAiCluster, card_ids: [anonymousCard.card_id] },
        ],
      },
    ],
    [
      'a card id twice in one cluster',
      {
        ...board,
        clusters: [
          {
            ...processCluster,
            card_ids: [anonymousCard.card_id, anonymousCard.card_id],
          },
        ],
      },
    ],
    ['a missing my_votes', { ...boardWithoutVotes, votes_remaining: 3 }],
    ['a missing votes_remaining', { ...boardWithoutVotes, my_votes: [] }],
    ['my_votes: null', { ...board, my_votes: null }],
    [
      'an extra key in a my_votes element',
      {
        ...board,
        my_votes: [
          { cluster_id: processCluster.cluster_id, vote_count: 1, total: 5 },
        ],
        votes_remaining: 2,
      },
    ],
    [
      'a vote_count of 0',
      {
        ...board,
        my_votes: [{ cluster_id: processCluster.cluster_id, vote_count: 0 }],
        votes_remaining: 3,
      },
    ],
    [
      'a vote_count of 4',
      {
        ...board,
        my_votes: [{ cluster_id: processCluster.cluster_id, vote_count: 4 }],
        votes_remaining: 0,
      },
    ],
    [
      'a vote_count of 1.5',
      {
        ...board,
        my_votes: [{ cluster_id: processCluster.cluster_id, vote_count: 1.5 }],
        votes_remaining: 1.5,
      },
    ],
    ['a votes_remaining of -1', { ...board, votes_remaining: -1 }],
    ['a votes_remaining of 4', { ...board, votes_remaining: 4 }],
    [
      'a my_votes cluster_id that is not a cluster of the response',
      {
        ...board,
        my_votes: [
          {
            cluster_id: 'b9000000-0000-4000-8000-000000000009',
            vote_count: 1,
          },
        ],
        votes_remaining: 2,
      },
    ],
    [
      'a cluster twice in my_votes',
      {
        ...board,
        my_votes: [
          { cluster_id: processCluster.cluster_id, vote_count: 1 },
          { cluster_id: processCluster.cluster_id, vote_count: 1 },
        ],
        votes_remaining: 1,
      },
    ],
    [
      'votes and votes_remaining that add up to less than 3',
      {
        ...board,
        my_votes: [{ cluster_id: processCluster.cluster_id, vote_count: 1 }],
        votes_remaining: 1,
      },
    ],
    [
      'votes and votes_remaining that add up to more than 3',
      {
        ...board,
        my_votes: [{ cluster_id: processCluster.cluster_id, vote_count: 2 }],
        votes_remaining: 2,
      },
    ],
    ['no votes with 2 remaining', { ...board, votes_remaining: 2 }],
  ])('fails to parse %s', async (_label, data) => {
    createClientMock({ data, error: null })

    const error = await captureError(fetchCycleBoard(CYCLE_ID))
    expect(error).toBeInstanceOf(BoardApiError)
    expect((error as BoardApiError).code).toBe('unknown')
  })

  it.each<[string, string, BoardErrorCode]>([
    ['42501', 'not_project_member', 'not_project_member'],
    ['42501', 'permission denied for function get_cycle_board', 'unknown'],
    ['42501', 'not_project_facilitator', 'unknown'],
    ['PGRST202', 'Could not find the function', 'unknown'],
  ])(
    'maps %s %s to %s without keeping or logging the raw text',
    async (code, message, expected) => {
      createClientMock({ data: null, error: { code, message } })

      const error = await captureError(fetchCycleBoard(CYCLE_ID))
      expect(error).toBeInstanceOf(BoardApiError)
      expect((error as BoardApiError).code).toBe(expected)
      expect((error as BoardApiError).message).toBe(expected)
      expect(boardErrorCodeOf(error)).toBe(expected)
      expect(console.error).not.toHaveBeenCalled()
      expect(console.warn).not.toHaveBeenCalled()
      expect(console.log).not.toHaveBeenCalled()
    },
  )

  it('maps a network failure and a missing client to unknown', async () => {
    expect(
      ((await captureError(fetchCycleBoard(CYCLE_ID))) as BoardApiError).code,
    ).toBe('unknown')
    expect(boardErrorCodeOf(new Error('network'))).toBe('unknown')
  })

  it('keys the board query by user and cycle', () => {
    expect(cycleBoardQueryKey('user-1', CYCLE_ID)).toEqual([
      'cycle-board',
      'user-1',
      CYCLE_ID,
    ])
  })
})
