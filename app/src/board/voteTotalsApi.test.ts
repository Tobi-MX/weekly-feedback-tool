import { beforeEach, describe, expect, it, vi } from 'vitest'

const state = vi.hoisted(() => ({ client: null as unknown }))

vi.mock('../auth/supabaseClient', () => ({
  get supabase() {
    return state.client
  },
}))

// The shared votes mock loads the real module (for its error class) before
// this file's supabaseClient mock exists; load a fresh copy that sees it.
vi.resetModules()
const { fetchVoteTotals, VoteTotalsApiError, voteTotalsErrorCodeOf } =
  await vi.importActual<typeof import('./voteTotalsApi')>('./voteTotalsApi')

interface DbResult {
  readonly data: unknown
  readonly error: { readonly message: string; readonly code?: string } | null
}

const CYCLE_ID = '30000000-0000-4000-8000-000000000001'
const X = 'c1000000-0000-4000-8000-000000000001'
const Y = 'a1000000-0000-4000-8000-000000000002'
const Z = 'b1000000-0000-4000-8000-000000000003'

function createClientMock(result: DbResult | (() => Promise<DbResult>)) {
  const rpc = vi.fn<
    (name: string, args: Record<string, unknown>) => Promise<DbResult>
  >(typeof result === 'function' ? result : () => Promise.resolve(result))
  const from = vi.fn()
  state.client = { rpc, from }
  return { rpc, from }
}

async function codeOf(promise: Promise<unknown>): Promise<string> {
  const error = await promise.then(
    () => {
      throw new Error('expected a rejection')
    },
    (reason: unknown) => reason,
  )
  expect(error).toBeInstanceOf(VoteTotalsApiError)
  expect((error as Error).message).toBe(voteTotalsErrorCodeOf(error))
  return voteTotalsErrorCodeOf(error)
}

beforeEach(() => {
  state.client = null
  vi.spyOn(console, 'error')
  vi.spyOn(console, 'warn')
  vi.spyOn(console, 'log')
})

describe('fetchVoteTotals', () => {
  it("calls get_vote_totals once with exactly { p_cycle_id } and keeps the server's order", async () => {
    // Not ordered by total, so any re-sort would show.
    const fake = createClientMock({
      data: [
        { cluster_id: Y, total_votes: 1 },
        { cluster_id: X, total_votes: 4 },
        { cluster_id: Z, total_votes: 0 },
      ],
      error: null,
    })

    await expect(fetchVoteTotals(CYCLE_ID)).resolves.toStrictEqual([
      { clusterId: Y, totalVotes: 1 },
      { clusterId: X, totalVotes: 4 },
      { clusterId: Z, totalVotes: 0 },
    ])
    expect(fake.rpc).toHaveBeenCalledTimes(1)
    expect(fake.rpc).toHaveBeenCalledWith('get_vote_totals', {
      p_cycle_id: CYCLE_ID,
    })
    expect(Object.keys(fake.rpc.mock.calls[0]?.[1] ?? {})).toEqual([
      'p_cycle_id',
    ])
    expect(fake.from).not.toHaveBeenCalled()
  })

  it('returns an empty list for a cycle with no clusters', async () => {
    createClientMock({ data: [], error: null })
    await expect(fetchVoteTotals(CYCLE_ID)).resolves.toEqual([])
  })

  it.each([
    ['an extra key', [{ cluster_id: X, total_votes: 1, voter_id: 'u' }]],
    ['a negative total', [{ cluster_id: X, total_votes: -1 }]],
    ['a non-integer total', [{ cluster_id: X, total_votes: 1.5 }]],
    ['a string total', [{ cluster_id: X, total_votes: '1' }]],
    ['a missing total', [{ cluster_id: X }]],
    ['a missing cluster id', [{ total_votes: 1 }]],
    ['a non-array', { cluster_id: X, total_votes: 1 }],
    ['null', null],
  ])('treats %s as unknown', async (_label, data) => {
    createClientMock({ data, error: null })
    expect(await codeOf(fetchVoteTotals(CYCLE_ID))).toBe('unknown')
  })

  it.each([
    ['42501', 'not_project_member', 'not_project_member'],
    ['P0001', 'voting_not_closed', 'voting_not_closed'],
    ['42501', 'permission denied for function get_vote_totals', 'unknown'],
    ['PGRST202', 'Could not find the function', 'unknown'],
  ])(
    '%s %s becomes %s without keeping or logging the raw text',
    async (pgCode, message, code) => {
      createClientMock({ data: null, error: { code: pgCode, message } })
      expect(await codeOf(fetchVoteTotals(CYCLE_ID))).toBe(code)
      expect(console.error).not.toHaveBeenCalled()
      expect(console.warn).not.toHaveBeenCalled()
      expect(console.log).not.toHaveBeenCalled()
    },
  )

  it('treats a thrown call as unknown', async () => {
    createClientMock(() => Promise.reject(new Error('offline')))
    expect(await codeOf(fetchVoteTotals(CYCLE_ID))).toBe('unknown')
  })

  it('rejects when Supabase is not configured', async () => {
    expect(await codeOf(fetchVoteTotals(CYCLE_ID))).toBe('unknown')
  })

  it('reads the code only from its own error class', () => {
    expect(voteTotalsErrorCodeOf(new Error('not_project_member'))).toBe(
      'unknown',
    )
    expect(
      voteTotalsErrorCodeOf(new VoteTotalsApiError('not_project_member')),
    ).toBe('not_project_member')
  })
})
