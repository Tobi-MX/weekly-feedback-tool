import {
  createClient,
  type RealtimeChannel,
  type SupabaseClient,
} from '@supabase/supabase-js'
import { beforeAll, describe, expect, inject, it } from 'vitest'
import { expectPgError, expectRows, type DbResult } from './assertions'
import {
  anonClient,
  createRoleCast,
  projectWithRoles,
  type ProjectWithRoles,
  type RoleCast,
  type TestUser,
} from './fixtures'

interface CreatedCycleRow {
  readonly id: string
}

interface CardRpcRow {
  readonly id: string
}

interface StageRow {
  readonly status: string
}

interface ClusterRow {
  readonly cluster_id: string
}

interface VoteRow {
  readonly cluster_id: string
  readonly vote_count: number
  readonly votes_remaining: number
}

interface TotalRow {
  readonly cluster_id: string
  readonly total_votes: number
}

interface MyVote {
  readonly cluster_id: string
  readonly vote_count: number
}

interface CycleBoard {
  readonly cycle_id: string
  readonly status: string
  readonly is_revealed: boolean
  readonly cards: readonly { readonly card_id: string }[]
  readonly clusters: readonly { readonly cluster_id: string }[]
  readonly my_votes: readonly MyVote[]
  readonly votes_remaining: number
}

/** One cycle_events INSERT as Realtime delivers it. */
interface CycleEventPayload {
  readonly new: { readonly id: string; readonly to_status: string }
}

/** System messages Realtime sends on a channel. */
interface SystemMessage {
  readonly extension?: string
  readonly status?: string
}

/** How long the channel may take to become ready. */
const READY_TIMEOUT_MS = 30_000
/** How long the close event may take to arrive. */
const EVENT_TIMEOUT_MS = 10_000
/** How long the channel is watched after the last vote write. */
const QUIET_MS = 3_000
const STAGE_RACE_ROUNDS = 10

/** The Monday of the current UTC week, as the database's current_date sees it. */
function thisMonday(): string {
  const now = new Date()
  const offset = (now.getUTCDay() + 6) % 7
  const monday = new Date(
    Date.UTC(
      now.getUTCFullYear(),
      now.getUTCMonth(),
      now.getUTCDate() - offset,
    ),
  )
  return monday.toISOString().slice(0, 10)
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/** Settles like `promise`, or rejects with `message` after `ms`. */
async function withTimeout<T>(
  promise: Promise<T>,
  ms: number,
  message: string,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      reject(new Error(message))
    }, ms)
  })
  try {
    return await Promise.race([promise, timeout])
  } finally {
    clearTimeout(timer)
  }
}

/**
 * A service-role client, used only to open the totals gate the way #24's
 * close_voting will (setting discuss and voting_closed_at, which has no
 * product RPC yet). It is never used for an allow or deny assertion.
 */
function seedClient(): SupabaseClient {
  const env = inject('rlsEnv')
  return createClient(env.url, env.serviceRoleKey, {
    auth: {
      persistSession: false,
      autoRefreshToken: false,
      detectSessionInUrl: false,
    },
  })
}

async function board(user: TestUser, cycleId: string): Promise<CycleBoard> {
  const result: DbResult<CycleBoard> = await user.client.rpc(
    'get_cycle_board',
    { p_cycle_id: cycleId },
  )
  expect(result.error).toBeNull()
  if (result.data === null) {
    throw new Error('expected a board')
  }
  return result.data
}

function castVote(
  user: TestUser,
  cycleId: string,
  clusterId: string,
): PromiseLike<DbResult<VoteRow[]>> {
  return user.client.rpc('cast_vote', {
    p_cycle_id: cycleId,
    p_cluster_id: clusterId,
  })
}

function removeVote(
  user: TestUser,
  cycleId: string,
  clusterId: string,
): PromiseLike<DbResult<VoteRow[]>> {
  return user.client.rpc('remove_vote', {
    p_cycle_id: cycleId,
    p_cluster_id: clusterId,
  })
}

function totals(
  client: SupabaseClient,
  cycleId: string,
): PromiseLike<DbResult<TotalRow[]>> {
  return client.rpc('get_vote_totals', { p_cycle_id: cycleId })
}

/** Casts and expects success; returns the one row. */
async function cast(
  user: TestUser,
  cycleId: string,
  clusterId: string,
): Promise<VoteRow> {
  return expectRows(await castVote(user, cycleId, clusterId), 1)[0]
}

/**
 * Voting (#22): every member casts up to 3 votes on clusters during vote,
 * reads only their own votes, and nobody sees totals until voting closes.
 */
describe('votes', () => {
  let roleCast: RoleCast
  let seed: SupabaseClient

  beforeAll(async () => {
    roleCast = await createRoleCast('votes')
    seed = seedClient()
  })

  /**
   * A new cycle of the project in vote: one card from each member, revealed
   * and clustered by the owner (the facilitator) into clusters X and Y (Y
   * has no cards).
   */
  async function votingCycle(roles: ProjectWithRoles): Promise<{
    cycleId: string
    x: string
    y: string
  }> {
    const { owner, memberA, memberB } = roles
    const created: DbResult<CreatedCycleRow[]> = await owner.client.rpc(
      'create_cycle',
      {
        p_project_id: roles.project.id,
        p_title: 'Vote week',
        p_week_start: thisMonday(),
      },
    )
    const [cycle] = expectRows(created, 1)
    const cards: string[] = []
    for (const user of [owner, memberA, memberB]) {
      const card: DbResult<CardRpcRow[]> = await user.client.rpc(
        'create_card',
        {
          p_cycle_id: cycle.id,
          p_category: 'start',
          p_text: `Vote card ${cards.length + 1}`,
          p_is_anonymous: cards.length % 2 === 0,
        },
      )
      cards.push(expectRows(card, 1)[0].id)
    }
    const started: DbResult<StageRow[]> = await owner.client.rpc(
      'start_retrospective',
      { p_cycle_id: cycle.id },
    )
    expect(expectRows(started, 1)[0].status).toBe('reveal')
    const toCluster: DbResult<StageRow[]> = await owner.client.rpc(
      'advance_stage',
      { p_cycle_id: cycle.id, p_from_status: 'reveal' },
    )
    expect(expectRows(toCluster, 1)[0].status).toBe('cluster')

    const clusterIds: string[] = []
    for (const name of ['X', 'Y']) {
      const made: DbResult<ClusterRow[]> = await owner.client.rpc(
        'create_cluster',
        { p_cycle_id: cycle.id, p_name: name },
      )
      clusterIds.push(expectRows(made, 1)[0].cluster_id)
    }
    const moved: DbResult<unknown> = await owner.client.rpc('move_card', {
      p_card_id: cards[0],
      p_cluster_id: clusterIds[0],
      p_position: null,
    })
    expect(moved.error).toBeNull()

    const toVote: DbResult<StageRow[]> = await owner.client.rpc(
      'advance_stage',
      { p_cycle_id: cycle.id, p_from_status: 'cluster' },
    )
    expect(expectRows(toVote, 1)[0].status).toBe('vote')
    return { cycleId: cycle.id, x: clusterIds[0], y: clusterIds[1] }
  }

  it("no client can select, insert, update, or delete votes directly, and B cannot read D's votes", async () => {
    const roles = await projectWithRoles(roleCast)
    const { owner, memberA: b, memberB: d } = roles
    const { cycleId, x, y } = await votingCycle(roles)

    expect(await cast(b, cycleId, x)).toEqual({
      cluster_id: x,
      vote_count: 1,
      votes_remaining: 2,
    })
    await cast(d, cycleId, y)
    await cast(d, cycleId, y)

    // Signed out, A, B, and D.
    for (const client of [anonClient(), owner.client, b.client, d.client]) {
      expectPgError(await client.from('votes').select(), '42501')
      expectPgError(
        await client
          .from('votes')
          .insert({ cycle_id: cycleId, cluster_id: x, voter_id: b.id })
          .select(),
        '42501',
      )
      expectPgError(
        await client
          .from('votes')
          .update({ cluster_id: y })
          .eq('cycle_id', cycleId)
          .select(),
        '42501',
      )
      expectPgError(
        await client.from('votes').delete().eq('cycle_id', cycleId).select(),
        '42501',
      )
    }

    // B's only paths: the board (own votes only) and totals (gated).
    const bBoard = await board(b, cycleId)
    expect(bBoard.my_votes).toEqual([{ cluster_id: x, vote_count: 1 }])
    expect(bBoard.votes_remaining).toBe(2)
    expect(JSON.stringify(bBoard)).not.toContain(d.id)
    expectPgError(await totals(b.client, cycleId), 'P0001', 'voting_not_closed')

    // The writes above are all still there: nothing was changed directly.
    expect((await board(d, cycleId)).my_votes).toEqual([
      { cluster_id: y, vote_count: 2 },
    ])
  })

  it("during vote nobody gets totals, and B's board does not change when D casts and removes", async () => {
    const roles = await projectWithRoles(roleCast)
    const { owner, memberA: b, memberB: d } = roles
    const { cycleId, x, y } = await votingCycle(roles)

    await cast(b, cycleId, x)
    const before = await board(b, cycleId)

    await cast(d, cycleId, x)
    await cast(d, cycleId, y)
    expectRows(await removeVote(d, cycleId, x), 1)

    expect(await board(b, cycleId)).toEqual(before)
    for (const user of [owner, b, d]) {
      expectPgError(
        await totals(user.client, cycleId),
        'P0001',
        'voting_not_closed',
      )
    }
  })

  it('after voting closes A, B, and D get the same totals, and C gets not_project_member', async () => {
    const roles = await projectWithRoles(roleCast)
    const { owner, memberA: b, memberB: d, nonMember: c } = roles
    const { cycleId, x, y } = await votingCycle(roles)

    await cast(owner, cycleId, y)
    await cast(b, cycleId, x)
    await cast(b, cycleId, x)
    await cast(d, cycleId, x)

    const gate = await seed
      .from('feedback_cycles')
      .update({ status: 'discuss', voting_closed_at: new Date().toISOString() })
      .eq('id', cycleId)
      .select('id')
    expect(gate.error).toBeNull()
    expect(gate.data).toHaveLength(1)

    const expected: TotalRow[] = [
      { cluster_id: x, total_votes: 3 },
      { cluster_id: y, total_votes: 1 },
    ]
    for (const user of [owner, b, d]) {
      expect(expectRows(await totals(user.client, cycleId), 2)).toEqual(
        expected,
      )
    }
    expectPgError(
      await totals(c.client, cycleId),
      '42501',
      'not_project_member',
    )
  })

  it('a Realtime subscriber on cycle_events receives no event while B and D vote', async () => {
    const roles = await projectWithRoles(roleCast)
    const { owner, memberA: b, memberB: d } = roles
    const { cycleId, x, y } = await votingCycle(roles)

    const received: CycleEventPayload[] = []
    let resolveClosed: () => void = () => undefined
    const closedEvent = new Promise<void>((resolve) => {
      resolveClosed = resolve
    })
    let channel: RealtimeChannel | undefined
    try {
      await withTimeout(
        new Promise<void>((resolve, reject) => {
          let subscribed = false
          let listening = false
          const settle = () => {
            if (subscribed && listening) {
              resolve()
            }
          }
          channel = owner.client
            .channel(`rls-votes-${cycleId}`)
            .on('system', {}, (message: SystemMessage) => {
              if (message.extension !== 'postgres_changes') {
                return
              }
              if (message.status === 'ok') {
                listening = true
                settle()
              } else {
                reject(new Error(`could not listen: ${message.status}`))
              }
            })
            .on(
              'postgres_changes',
              {
                event: 'INSERT',
                schema: 'public',
                table: 'cycle_events',
                filter: `cycle_id=eq.${cycleId}`,
              },
              (payload: CycleEventPayload) => {
                received.push(payload)
                if (payload.new.to_status === 'closed') {
                  resolveClosed()
                }
              },
            )
            .subscribe((status) => {
              if (status === 'SUBSCRIBED') {
                subscribed = true
                settle()
              }
            })
        }),
        READY_TIMEOUT_MS,
        'the channel was not ready within 30 s',
      )

      // Realtime may still deliver the setup's stage events after the
      // channel is ready; they are known rows and are ignored.
      const existing = await owner.client
        .from('cycle_events')
        .select('id')
        .eq('cycle_id', cycleId)
      expect(existing.error).toBeNull()
      const setupIds = new Set((existing.data ?? []).map((row) => row.id))

      await cast(b, cycleId, x)
      await cast(d, cycleId, y)
      await cast(b, cycleId, x)
      expectRows(await removeVote(b, cycleId, x), 1)
      expectRows(await removeVote(d, cycleId, y), 1)
      await cast(d, cycleId, x)
      await delay(QUIET_MS)

      // No cycle_events row was written by the votes.
      const afterVotes = await owner.client
        .from('cycle_events')
        .select('id')
        .eq('cycle_id', cycleId)
      expect(afterVotes.error).toBeNull()
      expect(afterVotes.data).toHaveLength(setupIds.size)

      // Positive control: closing the cycle is delivered, and it is the only
      // event after the setup. Delivery is in commit order, so any event a
      // vote had caused would have arrived first.
      const closed = await owner.client.rpc('close_cycle', {
        p_cycle_id: cycleId,
      })
      expect(closed.error).toBeNull()
      await withTimeout(
        closedEvent,
        EVENT_TIMEOUT_MS,
        'the close event did not arrive within 10 s',
      )
      const unexpected = received.filter(
        (payload) => !setupIds.has(payload.new.id),
      )
      expect(unexpected.map((payload) => payload.new.to_status)).toEqual([
        'closed',
      ])
    } finally {
      if (channel) {
        await owner.client.removeChannel(channel)
      }
    }
  }, 60_000)

  it('B racing 5 casts for 3 votes gets exactly 3 through and 2 no_votes_remaining', async () => {
    const roles = await projectWithRoles(roleCast)
    const { memberA: b } = roles
    const { cycleId, x, y } = await votingCycle(roles)

    const results = await Promise.all(
      [x, y, x, y, x].map((clusterId) => castVote(b, cycleId, clusterId)),
    )
    const succeeded = results.filter((result) => result.error === null)
    const refused = results.filter((result) => result.error !== null)
    expect(succeeded).toHaveLength(3)
    expect(refused).toHaveLength(2)
    for (const result of refused) {
      expectPgError(result, 'P0001', 'no_votes_remaining')
    }
    const remaining = succeeded
      .map((result) => result.data?.[0]?.votes_remaining ?? -1)
      .sort((left, right) => left - right)
    expect(remaining).toEqual([0, 1, 2])

    const after = await board(b, cycleId)
    expect(after.votes_remaining).toBe(0)
    expect(after.my_votes.reduce((sum, vote) => sum + vote.vote_count, 0)).toBe(
      3,
    )
  })

  it('B casting while A closes the cycle either succeeds or gets cycle_not_voting, never a deadlock', async () => {
    const roles = await projectWithRoles(roleCast)
    const { owner, memberA: b } = roles

    for (let round = 0; round < STAGE_RACE_ROUNDS; round += 1) {
      const { cycleId, x } = await votingCycle(roles)
      const [voted, closed] = await Promise.all([
        castVote(b, cycleId, x),
        owner.client.rpc('close_cycle', { p_cycle_id: cycleId }),
      ])
      expect(closed.error).toBeNull()
      if (voted.error === null) {
        expect(expectRows(voted, 1)[0]).toEqual({
          cluster_id: x,
          vote_count: 1,
          votes_remaining: 2,
        })
      } else {
        expectPgError(voted, 'P0001', 'cycle_not_voting')
      }

      const after = await board(b, cycleId)
      expect(after.status).toBe('closed')
      expect(after.my_votes).toEqual(
        voted.error === null ? [{ cluster_id: x, vote_count: 1 }] : [],
      )
      expectPgError(
        await totals(b.client, cycleId),
        'P0001',
        'voting_not_closed',
      )
    }
  }, 120_000)
})
