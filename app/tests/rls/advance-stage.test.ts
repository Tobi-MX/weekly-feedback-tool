import type {
  RealtimeChannel,
  RealtimePostgresInsertPayload,
  SupabaseClient,
} from '@supabase/supabase-js'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { expectPgError, expectRows, type DbResult } from './assertions'
import {
  anonClient,
  createProject,
  createRoleCast,
  makeFacilitator,
  projectWithRoles,
  unknownId,
  type ProjectRow,
  type RoleCast,
  type TestUser,
} from './fixtures'

/** One row of `advance_stage`: exactly `id` and `status`. */
interface AdvancedRow {
  readonly id: string
  readonly status: string
}

/** One row of `public.cycle_events`. */
interface CycleEventRow {
  readonly id: string
  readonly cycle_id: string
  readonly type: string
  readonly from_status: string
  readonly to_status: string
  readonly actor_id: string | null
  readonly payload: Record<string, unknown>
  readonly created_at: string
}

/** One row of `create_card`. */
interface CardRpcRow {
  readonly id: string
  readonly text: string
}

/** One row of `create_cycle`. */
interface CreatedCycleRow {
  readonly id: string
}

/** One row of `close_cycle`. */
interface ClosedCycleRow {
  readonly status: string
}

/** One row of `start_retrospective`. */
interface StartedRow {
  readonly status: string
}

/** One row of `get_cycle_status`. */
interface CycleStatusRow {
  readonly status: string
}

/** A Realtime `system` message, narrowed to what the test reads. */
interface SystemMessage {
  readonly extension?: string
  readonly status?: string
}

/** Who made a call: a signed-in test user or the signed-out anon client. */
type Caller = TestUser | 'anon'

/** How long the channel may take to become ready. */
const READY_TIMEOUT_MS = 30_000
/** How long a member may wait for a Realtime event. */
const EVENT_TIMEOUT_MS = 10_000
/** How long the channel is watched after the event arrived. */
const QUIET_MS = 3_000

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

describe('advance_stage', () => {
  let cast: RoleCast
  /** Every card id and text create_card has returned in this file. */
  const cardSecrets: string[] = []
  /** Every anon client this file created, so its sockets are closed. */
  const anonClients: SupabaseClient[] = []

  beforeAll(async () => {
    cast = await createRoleCast('advance')
  })

  afterAll(async () => {
    for (const client of [
      ...anonClients,
      cast.owner.client,
      cast.memberA.client,
      cast.memberB.client,
      cast.nonMember.client,
    ]) {
      await client.removeAllChannels()
    }
  })

  function anon(): SupabaseClient {
    const client = anonClient()
    anonClients.push(client)
    return client
  }

  function clientOf(caller: Caller): SupabaseClient {
    return caller === 'anon' ? anon() : caller.client
  }

  /**
   * The anonymity sweep for every advance_stage response and error: no
   * member A or member B id or email, and no card id or card text.
   */
  function sweep(value: unknown): void {
    const json = JSON.stringify(value)
    for (const user of [cast.memberA, cast.memberB]) {
      expect(json, `response leaks ${user.label} id`).not.toContain(user.id)
      expect(json, `response leaks ${user.label} email`).not.toContain(
        user.email,
      )
    }
    for (const secret of cardSecrets) {
      expect(json, 'response leaks a card id or text').not.toContain(secret)
    }
  }

  async function advance(
    caller: Caller,
    cycleId: string,
    fromStatus: string,
  ): Promise<DbResult<AdvancedRow[]>> {
    const { data, error } = await clientOf(caller).rpc('advance_stage', {
      p_cycle_id: cycleId,
      p_from_status: fromStatus,
    })
    const result: DbResult<AdvancedRow[]> = { data, error }
    sweep(result)
    return result
  }

  async function advanced(
    user: TestUser,
    cycleId: string,
    fromStatus: string,
    expected: string,
  ): Promise<void> {
    const [row] = expectRows(await advance(user, cycleId, fromStatus), 1)
    expect(Object.keys(row).sort()).toEqual(['id', 'status'])
    expect(row).toEqual({ id: cycleId, status: expected })
  }

  async function openCycle(
    owner: TestUser,
    project: ProjectRow,
  ): Promise<string> {
    const result: DbResult<CreatedCycleRow[]> = await owner.client.rpc(
      'create_cycle',
      {
        p_project_id: project.id,
        p_title: 'Advance week',
        p_week_start: thisMonday(),
      },
    )
    const [row] = expectRows(result, 1)
    return row.id
  }

  async function addCard(
    user: TestUser,
    cycleId: string,
    text: string,
    isAnonymous: boolean,
  ): Promise<void> {
    const result: DbResult<CardRpcRow[]> = await user.client.rpc(
      'create_card',
      {
        p_cycle_id: cycleId,
        p_category: 'start',
        p_text: text,
        p_is_anonymous: isAnonymous,
      },
    )
    const [row] = expectRows(result, 1)
    cardSecrets.push(row.id, row.text)
  }

  async function start(user: TestUser, cycleId: string): Promise<void> {
    const result: DbResult<StartedRow[]> = await user.client.rpc(
      'start_retrospective',
      { p_cycle_id: cycleId },
    )
    const [row] = expectRows(result, 1)
    expect(row.status).toBe('reveal')
  }

  async function closeCycle(user: TestUser, cycleId: string): Promise<void> {
    const result: DbResult<ClosedCycleRow[]> = await user.client.rpc(
      'close_cycle',
      { p_cycle_id: cycleId },
    )
    const [row] = expectRows(result, 1)
    expect(row.status).toBe('closed')
  }

  async function statusOf(user: TestUser, cycleId: string): Promise<string> {
    const result: DbResult<CycleStatusRow[]> = await user.client.rpc(
      'get_cycle_status',
      { p_cycle_id: cycleId },
    )
    const [row] = expectRows(result, 1)
    return row.status
  }

  async function events(
    user: TestUser,
    cycleId: string,
    n: number,
  ): Promise<readonly CycleEventRow[]> {
    const result: DbResult<CycleEventRow[]> = await user.client
      .from('cycle_events')
      .select()
      .eq('cycle_id', cycleId)
      .order('created_at')
    return expectRows(result, n)
  }

  /**
   * A project with a collecting cycle, cards from member A (one attributed,
   * one anonymous) and member B (one anonymous), started by the owner.
   */
  async function revealed() {
    const roles = await projectWithRoles(cast)
    const cycleId = await openCycle(roles.owner, roles.project)
    await addCard(roles.memberA, cycleId, 'Advance A attributed', false)
    await addCard(roles.memberA, cycleId, 'Advance A hidden', true)
    await addCard(roles.memberB, cycleId, 'Advance B hidden', true)
    await start(roles.owner, cycleId)
    return { ...roles, cycleId }
  }

  it('member A, the non-member, an unknown id, another project, and anon are refused; nothing changes', async () => {
    const { owner, memberA, nonMember, cycleId } = await revealed()
    const otherProject = await createProject(nonMember)
    const otherCycle = await openCycle(nonMember, otherProject)

    expectPgError(
      await advance(memberA, cycleId, 'reveal'),
      '42501',
      'not_project_facilitator',
    )
    expectPgError(
      await advance(nonMember, cycleId, 'reveal'),
      '42501',
      'not_project_member',
    )
    expectPgError(
      await advance(owner, unknownId(), 'reveal'),
      '42501',
      'not_project_member',
    )
    expectPgError(
      await advance(owner, otherCycle, 'reveal'),
      '42501',
      'not_project_member',
    )
    expectPgError(await advance('anon', cycleId, 'reveal'), '42501')

    expect(await statusOf(memberA, cycleId)).toBe('reveal')
    await events(memberA, cycleId, 1)
  })

  it('the owner moves reveal to cluster once; a repeated call is a no-op', async () => {
    const { owner, memberA, cycleId } = await revealed()

    await advanced(owner, cycleId, 'reveal', 'cluster')
    const rows = await events(memberA, cycleId, 2)
    const latest = rows.find((event) => event.from_status === 'reveal')
    expect(latest).toMatchObject({
      cycle_id: cycleId,
      type: 'stage_changed',
      from_status: 'reveal',
      to_status: 'cluster',
      actor_id: owner.id,
      payload: {},
    })

    await advanced(owner, cycleId, 'reveal', 'cluster')
    await events(memberA, cycleId, 2)
    expect(await statusOf(memberA, cycleId)).toBe('cluster')
  })

  it('vote is refused, cluster moves to vote, and reveal is then out of date', async () => {
    const { owner, memberA, cycleId } = await revealed()
    await advanced(owner, cycleId, 'reveal', 'cluster')

    expectPgError(
      await advance(owner, cycleId, 'vote'),
      'P0001',
      'invalid_stage_transition',
    )
    expect(await statusOf(memberA, cycleId)).toBe('cluster')

    await advanced(owner, cycleId, 'cluster', 'vote')
    await events(memberA, cycleId, 3)

    expectPgError(
      await advance(owner, cycleId, 'reveal'),
      'P0001',
      'stage_out_of_date',
    )
    expect(await statusOf(memberA, cycleId)).toBe('vote')
    await events(memberA, cycleId, 3)
  })

  it('after makeFacilitator(memberA), the owner is refused and member A advances', async () => {
    const { project, owner, memberA, cycleId } = await revealed()
    await makeFacilitator(project, owner, memberA)

    expectPgError(
      await advance(owner, cycleId, 'reveal'),
      '42501',
      'not_project_facilitator',
    )
    expect(await statusOf(owner, cycleId)).toBe('reveal')

    await advanced(memberA, cycleId, 'reveal', 'cluster')
    const rows = await events(owner, cycleId, 2)
    expect(rows.find((event) => event.to_status === 'cluster')?.actor_id).toBe(
      memberA.id,
    )
  })

  it('the owner cannot reveal a collecting cycle or advance a closed one', async () => {
    const { project, owner, memberA } = await projectWithRoles(cast)
    const cycleId = await openCycle(owner, project)
    await addCard(memberA, cycleId, 'Advance collecting card', true)

    expectPgError(
      await advance(owner, cycleId, 'reveal'),
      'P0001',
      'stage_out_of_date',
    )
    expect(await statusOf(memberA, cycleId)).toBe('collecting')
    await events(memberA, cycleId, 0)

    await closeCycle(owner, cycleId)
    for (const fromStatus of ['reveal', 'cluster']) {
      expectPgError(
        await advance(owner, cycleId, fromStatus),
        'P0001',
        'stage_out_of_date',
      )
    }
    expect(await statusOf(memberA, cycleId)).toBe('closed')
    await events(memberA, cycleId, 1)
  })

  it('Realtime delivers the reveal -> cluster event to member A once', async () => {
    const { owner, memberA, cycleId } = await revealed()

    const received: RealtimePostgresInsertPayload<CycleEventRow>[] = []
    const channels: RealtimeChannel[] = []
    let resolveEvent: () => void = () => undefined

    try {
      // SUBSCRIBED, then Realtime's own "Subscribed to PostgreSQL" system
      // message, before any change is made (see cycle-events.test.ts).
      await withTimeout(
        new Promise<void>((resolve, reject) => {
          let subscribed = false
          let listening = false
          const settle = () => {
            if (subscribed && listening) {
              resolve()
            }
          }
          const channel = memberA.client
            .channel(`rls-advance-stage-${cycleId}`)
            .on('system', {}, (message: SystemMessage) => {
              if (message.extension !== 'postgres_changes') {
                return
              }
              if (message.status === 'ok') {
                listening = true
                settle()
              } else {
                reject(
                  new Error(`member A could not listen: ${message.status}`),
                )
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
              (payload: RealtimePostgresInsertPayload<CycleEventRow>) => {
                received.push(payload)
                resolveEvent()
              },
            )
            .subscribe((status) => {
              if (status === 'SUBSCRIBED') {
                subscribed = true
                settle()
              }
            })
          channels.push(channel)
        }),
        READY_TIMEOUT_MS,
        'the channel was not ready within 30 s',
      )

      // Under load Realtime can still deliver the collecting -> reveal event,
      // committed before the subscription, after SUBSCRIBED. Let it drain,
      // then count only what the advance produces.
      await delay(QUIET_MS)
      received.length = 0
      const gotEvent = new Promise<void>((resolve) => {
        resolveEvent = resolve
      })

      await advanced(owner, cycleId, 'reveal', 'cluster')

      await withTimeout(
        gotEvent,
        EVENT_TIMEOUT_MS,
        'member A received no event within 10 s',
      )
      await delay(QUIET_MS)

      expect(received).toHaveLength(1)
      const [message] = received
      expect(message.new.from_status).toBe('reveal')
      expect(message.new.to_status).toBe('cluster')
      expect(message.new.payload).toEqual({})
      sweep(message)
    } finally {
      for (const channel of channels) {
        await memberA.client.removeChannel(channel)
      }
    }
  }, 70_000)
})
