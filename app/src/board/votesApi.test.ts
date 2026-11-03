import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  VOTE_ERROR_CODES,
  voteErrorCodeOf,
  VotesApiError,
  type VoteErrorCode,
} from './voteErrors'

const state = vi.hoisted(() => ({ client: null as unknown }))

vi.mock('../auth/supabaseClient', () => ({
  get supabase() {
    return state.client
  },
}))

const { castVote, removeVote } =
  await vi.importActual<typeof import('./votesApi')>('./votesApi')

interface DbResult {
  readonly data: unknown
  readonly error: { readonly message: string; readonly code?: string } | null
}

const CYCLE_ID = '30000000-0000-4000-8000-000000000001'
const CLUSTER_ID = 'c1000000-0000-4000-8000-000000000001'
const OTHER_CLUSTER_ID = 'c1000000-0000-4000-8000-000000000002'

function createClientMock(result: DbResult | (() => Promise<DbResult>)) {
  const rpc = vi.fn<
    (name: string, args: Record<string, unknown>) => Promise<DbResult>
  >(typeof result === 'function' ? result : () => Promise.resolve(result))
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

async function codeOf(promise: Promise<unknown>): Promise<VoteErrorCode> {
  const error = await captureError(promise)
  expect(error).toBeInstanceOf(VotesApiError)
  return voteErrorCodeOf(error)
}

const CALLS = [
  ['castVote', 'cast_vote', () => castVote(CYCLE_ID, CLUSTER_ID)],
  ['removeVote', 'remove_vote', () => removeVote(CYCLE_ID, CLUSTER_ID)],
] as const

beforeEach(() => {
  state.client = null
  vi.spyOn(console, 'error')
  vi.spyOn(console, 'warn')
  vi.spyOn(console, 'log')
})

describe('votesApi', () => {
  it('castVote calls cast_vote once with exactly { p_cycle_id, p_cluster_id } and parses the row', async () => {
    const fake = createClientMock({
      data: [{ cluster_id: CLUSTER_ID, vote_count: 1, votes_remaining: 2 }],
      error: null,
    })

    await expect(castVote(CYCLE_ID, CLUSTER_ID)).resolves.toEqual({
      clusterId: CLUSTER_ID,
      voteCount: 1,
      votesRemaining: 2,
    })
    expect(fake.rpc).toHaveBeenCalledTimes(1)
    expect(fake.rpc).toHaveBeenCalledWith('cast_vote', {
      p_cycle_id: CYCLE_ID,
      p_cluster_id: CLUSTER_ID,
    })
    expect(Object.keys(fake.rpc.mock.calls[0]?.[1] ?? {})).toEqual([
      'p_cycle_id',
      'p_cluster_id',
    ])
    expect(fake.rpc.mock.calls[0]).toHaveLength(2)
    expect(fake.from).not.toHaveBeenCalled()
  })

  it("passes the caller's ids through unchanged ('c', 'k')", async () => {
    const fake = createClientMock({
      data: [{ cluster_id: 'k', vote_count: 3, votes_remaining: 0 }],
      error: null,
    })

    await expect(castVote('c', 'k')).resolves.toEqual({
      clusterId: 'k',
      voteCount: 3,
      votesRemaining: 0,
    })
    expect(fake.rpc).toHaveBeenCalledTimes(1)
    expect(fake.rpc).toHaveBeenCalledWith('cast_vote', {
      p_cycle_id: 'c',
      p_cluster_id: 'k',
    })

    const removeFake = createClientMock({
      data: [{ cluster_id: 'k', vote_count: 0, votes_remaining: 3 }],
      error: null,
    })
    await expect(removeVote('c', 'k')).resolves.toEqual({
      clusterId: 'k',
      voteCount: 0,
      votesRemaining: 3,
    })
    expect(removeFake.rpc).toHaveBeenCalledTimes(1)
    expect(removeFake.rpc).toHaveBeenCalledWith('remove_vote', {
      p_cycle_id: 'c',
      p_cluster_id: 'k',
    })
    expect(Object.keys(removeFake.rpc.mock.calls[0]?.[1] ?? {})).toEqual([
      'p_cycle_id',
      'p_cluster_id',
    ])
  })

  it('removeVote calls remove_vote once with exactly { p_cycle_id, p_cluster_id } and parses the row', async () => {
    const fake = createClientMock({
      data: [{ cluster_id: CLUSTER_ID, vote_count: 2, votes_remaining: 1 }],
      error: null,
    })

    await expect(removeVote(CYCLE_ID, CLUSTER_ID)).resolves.toEqual({
      clusterId: CLUSTER_ID,
      voteCount: 2,
      votesRemaining: 1,
    })
    expect(fake.rpc).toHaveBeenCalledTimes(1)
    expect(fake.rpc).toHaveBeenCalledWith('remove_vote', {
      p_cycle_id: CYCLE_ID,
      p_cluster_id: CLUSTER_ID,
    })
  })

  it.each([
    [1, 2],
    [2, 1],
    [3, 0],
    [2, 0],
  ])(
    'castVote accepts vote_count %i with votes_remaining %i',
    async (count, left) => {
      createClientMock({
        data: [
          { cluster_id: CLUSTER_ID, vote_count: count, votes_remaining: left },
        ],
        error: null,
      })
      await expect(castVote(CYCLE_ID, CLUSTER_ID)).resolves.toEqual({
        clusterId: CLUSTER_ID,
        voteCount: count,
        votesRemaining: left,
      })
    },
  )

  it.each([
    [0, 3],
    [1, 2],
    [2, 1],
    [0, 1],
  ])(
    'removeVote accepts vote_count %i with votes_remaining %i',
    async (count, left) => {
      createClientMock({
        data: [
          { cluster_id: CLUSTER_ID, vote_count: count, votes_remaining: left },
        ],
        error: null,
      })
      await expect(removeVote(CYCLE_ID, CLUSTER_ID)).resolves.toEqual({
        clusterId: CLUSTER_ID,
        voteCount: count,
        votesRemaining: left,
      })
    },
  )

  const good = { cluster_id: CLUSTER_ID, vote_count: 1, votes_remaining: 1 }
  const BAD_REPLIES: ReadonlyArray<[string, unknown]> = [
    ['zero rows', []],
    ['two rows', [good, good]],
    ['null', null],
    ['a bare object', good],
    ['an extra key', [{ ...good, total: 4 }]],
    ['a missing cluster_id', [{ vote_count: 1, votes_remaining: 1 }]],
    ['a missing vote_count', [{ cluster_id: CLUSTER_ID, votes_remaining: 1 }]],
    ['a missing votes_remaining', [{ cluster_id: CLUSTER_ID, vote_count: 1 }]],
    ['a different cluster_id', [{ ...good, cluster_id: OTHER_CLUSTER_ID }]],
    ['a non-integer vote_count', [{ ...good, vote_count: 1.5 }]],
    ['a non-integer votes_remaining', [{ ...good, votes_remaining: 0.5 }]],
    ['a string vote_count', [{ ...good, vote_count: '1' }]],
    ['a null votes_remaining', [{ ...good, votes_remaining: null }]],
  ]

  it.each(CALLS)(
    '%s maps every malformed reply to unknown',
    async (_n, _r, call) => {
      for (const [, data] of BAD_REPLIES) {
        createClientMock({ data, error: null })
        expect(await codeOf(call())).toBe('unknown')
      }
    },
  )

  it.each([
    ['vote_count 0', 0, 2],
    ['vote_count 4', 4, 0],
    ['votes_remaining 3', 1, 3],
    ['votes_remaining -1', 1, -1],
  ])(
    'castVote maps a reply with %s to unknown',
    async (_label, count, left) => {
      createClientMock({
        data: [
          { cluster_id: CLUSTER_ID, vote_count: count, votes_remaining: left },
        ],
        error: null,
      })
      expect(await codeOf(castVote(CYCLE_ID, CLUSTER_ID))).toBe('unknown')
    },
  )

  it.each([
    ['vote_count 3', 3, 1],
    ['vote_count -1', -1, 3],
    ['votes_remaining 0', 1, 0],
    ['votes_remaining 4', 0, 4],
  ])(
    'removeVote maps a reply with %s to unknown',
    async (_label, count, left) => {
      createClientMock({
        data: [
          { cluster_id: CLUSTER_ID, vote_count: count, votes_remaining: left },
        ],
        error: null,
      })
      expect(await codeOf(removeVote(CYCLE_ID, CLUSTER_ID))).toBe('unknown')
    },
  )

  it.each(CALLS)(
    '%s maps a thrown call and a missing client to unknown',
    async (_n, _r, call) => {
      createClientMock(() => Promise.reject(new Error('Failed to fetch')))
      expect(await codeOf(call())).toBe('unknown')

      state.client = null
      expect(await codeOf(call())).toBe('unknown')
    },
  )

  it.each(CALLS)(
    '%s maps each of #22 five codes to itself and anything else to unknown',
    async (_n, _r, call) => {
      for (const code of VOTE_ERROR_CODES) {
        createClientMock({
          data: null,
          error: { message: code, code: 'P0001' },
        })
        expect(await codeOf(call())).toBe(code)
      }
      for (const message of [
        'voting_not_closed',
        'cycle_not_clustering',
        'permission denied for function cast_vote',
        '',
      ]) {
        createClientMock({ data: null, error: { message, code: '42501' } })
        expect(await codeOf(call())).toBe('unknown')
      }
    },
  )

  it.each(CALLS)(
    '%s keeps no server message text in the error',
    async (_n, _r, call) => {
      const secret = 'duplicate key value violates "votes_pkey" SECRET-DETAIL'
      createClientMock({
        data: null,
        error: { message: secret, code: '23505' },
      })
      const error = await captureError(call())

      expect(error).toBeInstanceOf(VotesApiError)
      const shown = JSON.stringify(error, Object.getOwnPropertyNames(error))
      expect(shown).not.toContain('SECRET-DETAIL')
      expect((error as Error).message).toBe('unknown')
      for (const value of Object.values(error as object)) {
        expect(String(value)).not.toContain('SECRET-DETAIL')
      }
      expect(console.error).not.toHaveBeenCalled()
      expect(console.warn).not.toHaveBeenCalled()
      expect(console.log).not.toHaveBeenCalled()
    },
  )

  it('a known code keeps only the code as its message', async () => {
    createClientMock({
      data: null,
      error: { message: 'no_votes_remaining', code: 'P0001' },
    })
    const error = await captureError(castVote(CYCLE_ID, CLUSTER_ID))
    expect(error).toBeInstanceOf(VotesApiError)
    expect((error as VotesApiError).message).toBe('no_votes_remaining')
    expect((error as VotesApiError).code).toBe('no_votes_remaining')
  })
})
