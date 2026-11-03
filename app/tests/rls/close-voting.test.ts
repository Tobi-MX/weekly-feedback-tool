import type { RealtimeChannel } from '@supabase/supabase-js'
import { beforeAll, describe, expect, it } from 'vitest'
import { expectPgError, expectRows, type DbResult } from './assertions'
import {
  createRoleCast,
  projectWithRoles,
  type ProjectWithRoles,
  type RoleCast,
  type TestUser,
} from './fixtures'

interface CreatedCycleRow {
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

interface CloseRow {
  readonly id: string
  readonly status: string
  readonly voting_closed_at: string | null
}

interface CycleRow {
  readonly status: string
  readonly voting_closed_at: string | null
}

interface EventRow {
  readonly id: string
  readonly type: string
  readonly from_status: string
  readonly to_status: string
  readonly actor_id: string | null
  readonly payload: Record<string, unknown>
}

/** One cycle_events INSERT as Realtime delivers it. */
interface CycleEventPayload {
  readonly new: EventRow
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
/** How long the channel is watched after the close event. */
const QUIET_MS = 3_000
const CLOSE_RACE_ROUNDS = 10

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

function closeVoting(
  user: TestUser,
  cycleId: string,
): PromiseLike<DbResult<CloseRow[]>> {
  return user.client.rpc('close_voting', { p_cycle_id: cycleId })
}

function totals(
  user: TestUser,
  cycleId: string,
): PromiseLike<DbResult<TotalRow[]>> {
  return user.client.rpc('get_vote_totals', { p_cycle_id: cycleId })
}

/** Casts and expects success; returns the one row. */
async function cast(
  user: TestUser,
  cycleId: string,
  clusterId: string,
): Promise<VoteRow> {
  return expectRows(await castVote(user, cycleId, clusterId), 1)[0]
}

/** The cycle row as a member reads it through RLS. */
async function cycleRow(user: TestUser, cycleId: string): Promise<CycleRow> {
  const result: DbResult<CycleRow[]> = await user.client
    .from('feedback_cycles')
    .select('status, voting_closed_at')
    .eq('id', cycleId)
  return expectRows(result, 1)[0]
}

/** The cycle's vote -> discuss events, as a member reads them through RLS. */
async function closeEvents(
  user: TestUser,
  cycleId: string,
): Promise<EventRow[]> {
  const result: DbResult<EventRow[]> = await user.client
    .from('cycle_events')
    .select('id, type, from_status, to_status, actor_id, payload')
    .eq('cycle_id', cycleId)
    .eq('to_status', 'discuss')
  expect(result.error).toBeNull()
  return result.data ?? []
}

const CLOSE_EVENT = {
  type: 'stage_changed',
  from_status: 'vote',
  to_status: 'discuss',
  actor_id: null,
  payload: {},
}

/**
 * Closing voting (#24): the vote that gives every current member all 3
 * votes closes voting in the same transaction, the facilitator can close it
 * earlier with close_voting, and either way exactly one vote -> discuss
 * event with no actor is recorded.
 */
describe('close voting', () => {
  let roleCast: RoleCast

  beforeAll(async () => {
    roleCast = await createRoleCast('closevote')
  })

  /**
   * A new cycle of the project in vote, taken there by the owner (the
   * facilitator), with clusters X and Y and no cards.
   */
  async function votingCycle(roles: ProjectWithRoles): Promise<{
    cycleId: string
    x: string
    y: string
  }> {
    const { owner } = roles
    const created: DbResult<CreatedCycleRow[]> = await owner.client.rpc(
      'create_cycle',
      {
        p_project_id: roles.project.id,
        p_title: 'Close week',
        p_week_start: thisMonday(),
      },
    )
    const [cycle] = expectRows(created, 1)
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
    const toVote: DbResult<StageRow[]> = await owner.client.rpc(
      'advance_stage',
      { p_cycle_id: cycle.id, p_from_status: 'cluster' },
    )
    expect(expectRows(toVote, 1)[0].status).toBe('vote')
    return { cycleId: cycle.id, x: clusterIds[0], y: clusterIds[1] }
  }

  /** Ends the cycle so the project can open the next one. */
  async function endCycle(owner: TestUser, cycleId: string): Promise<void> {
    const closed = await owner.client.rpc('close_cycle', {
      p_cycle_id: cycleId,
    })
    expect(closed.error).toBeNull()
  }

  it('the 9th vote closes voting with exactly one Realtime event, and A, B, and D then get the same totals', async () => {
    const roles = await projectWithRoles(roleCast)
    const { owner: a, memberA: b, memberB: d, nonMember: c } = roles
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
          channel = a.client
            .channel(`rls-close-voting-${cycleId}`)
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
                if (payload.new.to_status === 'discuss') {
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

      // Realtime may still deliver the setup's events after the channel is
      // ready; they are known rows and are ignored.
      const existing = await a.client
        .from('cycle_events')
        .select('id')
        .eq('cycle_id', cycleId)
      expect(existing.error).toBeNull()
      const setupIds = new Set((existing.data ?? []).map((row) => row.id))

      const series: [TestUser, string][] = [
        [b, x],
        [a, y],
        [d, x],
        [b, y],
        [a, x],
        [d, y],
        [b, x],
        [a, y],
      ]
      for (const [user, clusterId] of series) {
        await cast(user, cycleId, clusterId)
        expect(await cycleRow(user, cycleId)).toEqual({
          status: 'vote',
          voting_closed_at: null,
        })
      }
      expect(await cast(d, cycleId, x)).toEqual({
        cluster_id: x,
        vote_count: 2,
        votes_remaining: 0,
      })
      await withTimeout(
        closedEvent,
        EVENT_TIMEOUT_MS,
        'the close event did not arrive within 10 s',
      )
      await delay(QUIET_MS)

      const unexpected = received.filter(
        (payload) => !setupIds.has(payload.new.id),
      )
      expect(unexpected).toHaveLength(1)
      expect(unexpected[0].new).toMatchObject(CLOSE_EVENT)

      const row = await cycleRow(b, cycleId)
      expect(row.status).toBe('discuss')
      expect(row.voting_closed_at).not.toBeNull()

      const expected: TotalRow[] = [
        { cluster_id: x, total_votes: 5 },
        { cluster_id: y, total_votes: 4 },
      ]
      for (const user of [a, b, d]) {
        expect(expectRows(await totals(user, cycleId), 2)).toEqual(expected)
      }
      expectPgError(await totals(c, cycleId), '42501', 'not_project_member')
    } finally {
      if (channel) {
        await a.client.removeChannel(channel)
      }
    }
  }, 60_000)

  it('two racing final votes both succeed and record one vote -> discuss event', async () => {
    const roles = await projectWithRoles(roleCast)
    const { owner: a, memberA: b, memberB: d } = roles
    const { cycleId, x, y } = await votingCycle(roles)

    for (const clusterId of [x, x, y]) {
      await cast(a, cycleId, clusterId)
    }
    for (const user of [b, d]) {
      await cast(user, cycleId, x)
      await cast(user, cycleId, y)
    }

    const [fromB, fromD] = await Promise.all([
      castVote(b, cycleId, x),
      castVote(d, cycleId, y),
    ])
    expect(expectRows(fromB, 1)[0].votes_remaining).toBe(0)
    expect(expectRows(fromD, 1)[0].votes_remaining).toBe(0)

    expect((await cycleRow(a, cycleId)).status).toBe('discuss')
    const events = await closeEvents(a, cycleId)
    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject(CLOSE_EVENT)
  })

  it("A's close_voting racing D's final vote always ends in discuss with one event and no other error", async () => {
    const roles = await projectWithRoles(roleCast)
    const { owner: a, memberA: b, memberB: d } = roles

    for (let round = 0; round < CLOSE_RACE_ROUNDS; round += 1) {
      const { cycleId, x, y } = await votingCycle(roles)
      for (const user of [a, b]) {
        await cast(user, cycleId, x)
        await cast(user, cycleId, y)
        await cast(user, cycleId, x)
      }
      await cast(d, cycleId, y)
      await cast(d, cycleId, y)

      const [closed, voted] = await Promise.all([
        closeVoting(a, cycleId),
        castVote(d, cycleId, x),
      ])
      const [closedRow] = expectRows(closed, 1)
      expect(closedRow.id).toBe(cycleId)
      expect(closedRow.status).toBe('discuss')
      expect(closedRow.voting_closed_at).not.toBeNull()
      if (voted.error !== null) {
        expectPgError(voted, 'P0001', 'cycle_not_voting')
      } else {
        expect(expectRows(voted, 1)[0].votes_remaining).toBe(0)
      }

      const row = await cycleRow(a, cycleId)
      expect(row).toEqual({
        status: 'discuss',
        voting_closed_at: closedRow.voting_closed_at,
      })
      const events = await closeEvents(a, cycleId)
      expect(events).toHaveLength(1)
      expect(events[0]).toMatchObject(CLOSE_EVENT)

      await endCycle(a, cycleId)
    }
  }, 180_000)

  it("A's two concurrent close_voting calls both succeed with the same voting_closed_at and one event", async () => {
    const roles = await projectWithRoles(roleCast)
    const { owner: a, memberA: b } = roles
    const { cycleId, x } = await votingCycle(roles)
    await cast(b, cycleId, x)

    const [first, second] = await Promise.all([
      closeVoting(a, cycleId),
      closeVoting(a, cycleId),
    ])
    const [firstRow] = expectRows(first, 1)
    const [secondRow] = expectRows(second, 1)
    expect(firstRow.status).toBe('discuss')
    expect(firstRow.voting_closed_at).not.toBeNull()
    expect(secondRow).toEqual(firstRow)

    const events = await closeEvents(a, cycleId)
    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject(CLOSE_EVENT)
  })

  it("B and D cannot update the cycle directly, and B's close_voting gets not_project_facilitator", async () => {
    const roles = await projectWithRoles(roleCast)
    const { owner: a, memberA: b, memberB: d } = roles
    const { cycleId } = await votingCycle(roles)

    for (const user of [b, d]) {
      expectPgError(
        await user.client
          .from('feedback_cycles')
          .update({ status: 'discuss' })
          .eq('id', cycleId)
          .select(),
        '42501',
      )
      expectPgError(
        await user.client
          .from('feedback_cycles')
          .update({ voting_closed_at: new Date().toISOString() })
          .eq('id', cycleId)
          .select(),
        '42501',
      )
    }
    expectPgError(
      await closeVoting(b, cycleId),
      '42501',
      'not_project_facilitator',
    )

    expect(await cycleRow(a, cycleId)).toEqual({
      status: 'vote',
      voting_closed_at: null,
    })
    expect(await closeEvents(a, cycleId)).toEqual([])
  })
})
