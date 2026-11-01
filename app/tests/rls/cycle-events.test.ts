import type {
  RealtimeChannel,
  RealtimePostgresInsertPayload,
  SupabaseClient,
} from '@supabase/supabase-js'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  expectNoRows,
  expectPgError,
  expectRows,
  type DbResult,
} from './assertions'
import {
  anonClient,
  createRoleCast,
  makeFacilitator,
  projectWithRoles,
  unknownId,
  type ProjectRow,
  type RoleCast,
  type TestUser,
} from './fixtures'

/** One row of `public.cycle_events`: exactly its eight columns. */
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

/** One row of `start_retrospective`. */
interface StartedRow {
  readonly id: string
  readonly status: string
  readonly revealed_at: string | null
}

/** One row of `create_card`. */
interface CardRpcRow {
  readonly id: string
  readonly text: string
}

/** One row of `get_my_cards`. */
interface MyCardRow {
  readonly id: string
  readonly text: string
}

/** One row of `create_cycle`. */
interface CreatedCycleRow {
  readonly id: string
}

/** One row of `close_cycle`. */
interface ClosedCycleRow {
  readonly id: string
  readonly status: string
}

/** One row of `get_cycle_status`. */
interface CycleStatusRow {
  readonly status: string
  readonly is_revealed: boolean
  readonly card_count: number | null
}

/** A Realtime `system` message, narrowed to what the test reads. */
interface SystemMessage {
  readonly extension?: string
  readonly status?: string
}

/** Who made a call: a signed-in test user or the signed-out anon client. */
type Caller = TestUser | 'anon'

const EVENT_COLUMNS = [
  'actor_id',
  'created_at',
  'cycle_id',
  'from_status',
  'id',
  'payload',
  'to_status',
  'type',
]

/** How long the three channels may take to become ready. */
const READY_TIMEOUT_MS = 30_000
/** How long a member may wait for a Realtime event. */
const EVENT_TIMEOUT_MS = 10_000
/** How long others are watched after the member's event arrived. */
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

describe('cycle events and start_retrospective', () => {
  let cast: RoleCast
  /** Every card id and text create_card has returned in this file. */
  const cardSecrets: string[] = []
  /** Every anon client this file created, so its sockets are closed. */
  const anonClients: SupabaseClient[] = []

  beforeAll(async () => {
    cast = await createRoleCast('events')
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

  /**
   * The anonymity sweep. Member A's and member B's ids and emails, and the
   * non-member's, never appear. The owner's id may appear only as an
   * `actor_id`, and the owner's email never. A `create_card` or
   * `get_my_cards` result is the author's own card, so it necessarily carries
   * that card's id, text, and `is_anonymous`; for those only user ids and
   * emails are checked. Everything else is checked for all of them.
   */
  function sweep(value: unknown, isOwnCards: boolean): void {
    const json = JSON.stringify(value)
    for (const user of [cast.memberA, cast.memberB, cast.nonMember]) {
      expect(json, `response leaks ${user.label} id`).not.toContain(user.id)
      expect(json, `response leaks ${user.label} email`).not.toContain(
        user.email,
      )
    }
    const ownerOutsideActor = json
      .split(`"actor_id":"${cast.owner.id}"`)
      .join('')
    expect(ownerOutsideActor, 'owner id outside actor_id').not.toContain(
      cast.owner.id,
    )
    expect(json, 'response leaks the owner email').not.toContain(
      cast.owner.email,
    )
    if (isOwnCards) {
      return
    }
    for (const secret of cardSecrets) {
      expect(json, 'response leaks a card id or text').not.toContain(secret)
    }
    expect(json.toLowerCase(), 'response mentions anonymous').not.toContain(
      'anonymous',
    )
  }

  async function observe<T>(
    call: PromiseLike<DbResult<T>>,
    isOwnCards = false,
  ): Promise<DbResult<T>> {
    const { data, error } = await call
    const result: DbResult<T> = { data, error }
    sweep(result, isOwnCards)
    return result
  }

  function clientOf(caller: Caller): SupabaseClient {
    return caller === 'anon' ? anon() : caller.client
  }

  async function openCycle(
    owner: TestUser,
    project: ProjectRow,
  ): Promise<string> {
    const result: DbResult<CreatedCycleRow[]> = await observe(
      owner.client.rpc('create_cycle', {
        p_project_id: project.id,
        p_title: 'Events week',
        p_week_start: thisMonday(),
      }),
    )
    const [row] = expectRows(result, 1)
    return row.id
  }

  async function closeCycle(user: TestUser, cycleId: string): Promise<void> {
    const result: DbResult<ClosedCycleRow[]> = await observe(
      user.client.rpc('close_cycle', { p_cycle_id: cycleId }),
    )
    const [row] = expectRows(result, 1)
    expect(row.status).toBe('closed')
  }

  async function addCard(
    user: TestUser,
    cycleId: string,
    text: string,
    isAnonymous: boolean,
  ): Promise<CardRpcRow> {
    const result: DbResult<CardRpcRow[]> = await observe(
      user.client.rpc('create_card', {
        p_cycle_id: cycleId,
        p_category: 'start',
        p_text: text,
        p_is_anonymous: isAnonymous,
      }),
      true,
    )
    const [row] = expectRows(result, 1)
    cardSecrets.push(row.id, row.text)
    return row
  }

  function start(
    caller: Caller,
    cycleId: string,
  ): Promise<DbResult<StartedRow[]>> {
    return observe(
      clientOf(caller).rpc('start_retrospective', { p_cycle_id: cycleId }),
    )
  }

  async function started(user: TestUser, cycleId: string): Promise<StartedRow> {
    const [row] = expectRows(await start(user, cycleId), 1)
    expect(Object.keys(row).sort()).toEqual(['id', 'revealed_at', 'status'])
    expect(row.id).toBe(cycleId)
    return row
  }

  function readEvents(
    caller: Caller,
    cycleId: string,
  ): Promise<DbResult<CycleEventRow[]>> {
    return observe(
      clientOf(caller)
        .from('cycle_events')
        .select()
        .eq('cycle_id', cycleId)
        .order('created_at'),
    )
  }

  async function events(
    user: TestUser,
    cycleId: string,
    n: number,
  ): Promise<readonly CycleEventRow[]> {
    const rows = expectRows(await readEvents(user, cycleId), n)
    for (const row of rows) {
      expect(Object.keys(row).sort()).toEqual(EVENT_COLUMNS)
    }
    return rows
  }

  async function cycleStatus(
    user: TestUser,
    cycleId: string,
  ): Promise<CycleStatusRow> {
    const result: DbResult<CycleStatusRow[]> = await observe(
      user.client.rpc('get_cycle_status', { p_cycle_id: cycleId }),
    )
    const [row] = expectRows(result, 1)
    return row
  }

  /** A project with a collecting cycle and cards from member A and member B. */
  async function setUp() {
    const roles = await projectWithRoles(cast)
    const cycleId = await openCycle(roles.owner, roles.project)
    const aAttributed = await addCard(
      roles.memberA,
      cycleId,
      'Events A attributed',
      false,
    )
    const aHidden = await addCard(
      roles.memberA,
      cycleId,
      'Events A hidden',
      true,
    )
    await addCard(roles.memberB, cycleId, 'Events B hidden', true)
    return { ...roles, cycleId, aAttributed, aHidden }
  }

  it('the facilitator starts the retrospective; members read one event, others none', async () => {
    const { owner, memberA, nonMember, cycleId } = await setUp()

    const row = await started(owner, cycleId)
    expect(row.status).toBe('reveal')
    expect(row.revealed_at).not.toBeNull()

    const [event] = await events(memberA, cycleId, 1)
    expect(event).toMatchObject({
      cycle_id: cycleId,
      type: 'stage_changed',
      from_status: 'collecting',
      to_status: 'reveal',
      actor_id: owner.id,
      payload: {},
    })

    expectNoRows(await readEvents(nonMember, cycleId))
    expectPgError(await readEvents('anon', cycleId), '42501')

    const status = await cycleStatus(memberA, cycleId)
    expect(status.is_revealed).toBe(true)
    expect(status.card_count).toBe(3)
  })

  it('member A gets not_project_facilitator; non-member, unknown id, and anon are refused; nothing changes', async () => {
    const { owner, memberA, nonMember, cycleId } = await setUp()

    expectPgError(
      await start(memberA, cycleId),
      '42501',
      'not_project_facilitator',
    )
    expectPgError(
      await start(nonMember, cycleId),
      '42501',
      'not_project_member',
    )
    expectPgError(
      await start(owner, unknownId()),
      '42501',
      'not_project_member',
    )
    expectPgError(
      await start(nonMember, unknownId()),
      '42501',
      'not_project_member',
    )
    expectPgError(await start('anon', cycleId), '42501')

    expect((await cycleStatus(owner, cycleId)).status).toBe('collecting')
    await events(owner, cycleId, 0)
  })

  it('after makeFacilitator(memberA), the owner is refused and member A starts the retrospective', async () => {
    const { project, owner, memberA, cycleId } = await setUp()
    await makeFacilitator(project, owner, memberA)

    expectPgError(
      await start(owner, cycleId),
      '42501',
      'not_project_facilitator',
    )
    expect((await cycleStatus(owner, cycleId)).status).toBe('collecting')

    const row = await started(memberA, cycleId)
    expect(row.status).toBe('reveal')
  })

  it('a repeated start is a no-op; close adds reveal -> closed; a later start is refused', async () => {
    const { owner, memberA, cycleId } = await setUp()

    const first = await started(owner, cycleId)
    const second = await started(owner, cycleId)
    expect(second).toEqual(first)
    await events(memberA, cycleId, 1)

    await closeCycle(owner, cycleId)
    const rows = await events(memberA, cycleId, 2)
    expect(rows.map((event) => [event.from_status, event.to_status])).toEqual(
      expect.arrayContaining([
        ['collecting', 'reveal'],
        ['reveal', 'closed'],
      ]),
    )
    const closeEvent = rows.find((event) => event.to_status === 'closed')
    expect(closeEvent?.actor_id).toBe(owner.id)

    expectPgError(await start(owner, cycleId), 'P0001', 'cycle_not_collecting')
    await events(memberA, cycleId, 2)
  })

  it('closing from collecting adds one event, start is refused, and the cycle stays unrevealed', async () => {
    const { owner, memberA, cycleId } = await setUp()

    await closeCycle(owner, cycleId)
    const [event] = await events(memberA, cycleId, 1)
    expect(event).toMatchObject({
      from_status: 'collecting',
      to_status: 'closed',
      actor_id: owner.id,
      payload: {},
    })

    expectPgError(await start(owner, cycleId), 'P0001', 'cycle_not_collecting')
    await events(memberA, cycleId, 1)

    const status = await cycleStatus(memberA, cycleId)
    expect(status.is_revealed).toBe(false)
    expect(status.card_count).toBeNull()
  })

  it('the facilitator starts a cycle with zero cards', async () => {
    const { project, owner, memberA } = await projectWithRoles(cast)
    const cycleId = await openCycle(owner, project)

    expect((await started(owner, cycleId)).status).toBe('reveal')
    const status = await cycleStatus(memberA, cycleId)
    expect(status.is_revealed).toBe(true)
    expect(status.card_count).toBe(0)
  })

  it('after reveal member A cannot create, update, or delete a card but still reads both own cards', async () => {
    const { owner, memberA, cycleId, aAttributed, aHidden } = await setUp()
    await started(owner, cycleId)

    expectPgError(
      await observe(
        memberA.client.rpc('create_card', {
          p_cycle_id: cycleId,
          p_category: 'stop',
          p_text: 'Events too late',
          p_is_anonymous: false,
        }),
      ),
      'P0001',
      'cycle_not_collecting',
    )
    expectPgError(
      await observe(
        memberA.client.rpc('update_card', {
          p_card_id: aAttributed.id,
          p_text: 'Events edited late',
          p_is_anonymous: true,
        }),
      ),
      'P0001',
      'cycle_not_collecting',
    )
    expectPgError(
      await observe(
        memberA.client.rpc('delete_card', { p_card_id: aHidden.id }),
      ),
      'P0001',
      'cycle_not_collecting',
    )

    const mine: DbResult<MyCardRow[]> = await observe(
      memberA.client.rpc('get_my_cards', { p_cycle_id: cycleId }),
      true,
    )
    const rows = expectRows(mine, 2)
    expect(rows.map((card) => card.id).sort()).toEqual(
      [aAttributed.id, aHidden.id].sort(),
    )
    expect(rows.map((card) => card.text).sort()).toEqual(
      [aAttributed.text, aHidden.text].sort(),
    )
  })

  it('the owner and member A cannot insert, update, or delete events', async () => {
    const { owner, memberA, cycleId } = await setUp()
    await started(owner, cycleId)
    const [event] = await events(memberA, cycleId, 1)

    for (const user of [owner, memberA]) {
      expectPgError(
        await observe(
          user.client
            .from('cycle_events')
            .insert({
              cycle_id: cycleId,
              type: 'stage_changed',
              from_status: 'reveal',
              to_status: 'cluster',
            })
            .select(),
        ),
        '42501',
      )
      expectPgError(
        await observe(
          user.client
            .from('cycle_events')
            .update({ to_status: 'closed' })
            .eq('id', event.id)
            .select(),
        ),
        '42501',
      )
      expectPgError(
        await observe(
          user.client.from('cycle_events').delete().eq('id', event.id).select(),
        ),
        '42501',
      )
    }

    const [unchanged] = await events(memberA, cycleId, 1)
    expect(unchanged).toEqual(event)
  })

  it('after reveal the owner and member A still cannot read cards or card_authors', async () => {
    const { owner, memberA, cycleId } = await setUp()

    const tryRead = async () => {
      for (const user of [owner, memberA]) {
        expectPgError(
          await observe(user.client.from('cards').select()),
          '42501',
        )
        expectPgError(
          await observe(user.client.from('card_authors').select()),
          '42501',
        )
      }
    }

    await tryRead()
    await started(owner, cycleId)
    await tryRead()
  })

  it('Realtime delivers the reveal event to member A only', async () => {
    const { owner, memberA, nonMember, cycleId } = await setUp()

    const received = new Map<string, unknown[]>()
    const channels: { client: SupabaseClient; channel: RealtimeChannel }[] = []
    let resolveMemberEvent: () => void = () => undefined
    const memberEvent = new Promise<void>((resolve) => {
      resolveMemberEvent = resolve
    })

    /**
     * Resolves once the channel reports SUBSCRIBED and Realtime confirms the
     * Postgres Changes listener ("Subscribed to PostgreSQL"). On a cold stack
     * the confirmation can follow SUBSCRIBED by several seconds, and an event
     * inserted before it is not delivered to anyone. The anon client has no
     * SELECT on cycle_events, so Realtime answers it with an error instead,
     * which also settles the wait: it can never receive an event.
     */
    const subscribe = (
      label: string,
      client: SupabaseClient,
      mayBeRefused = false,
    ) => {
      received.set(label, [])
      return new Promise<void>((resolve, reject) => {
        let subscribed = false
        let listening = false
        const settle = () => {
          if (subscribed && listening) {
            resolve()
          }
        }
        const channel = client
          .channel(`rls-cycle-events-${label}-${cycleId}`)
          .on('system', {}, (message: SystemMessage) => {
            if (message.extension !== 'postgres_changes') {
              return
            }
            if (message.status === 'ok' || mayBeRefused) {
              listening = true
              settle()
            } else {
              reject(new Error(`${label} could not listen: ${message.status}`))
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
              received.get(label)?.push(payload)
              if (label === 'memberA') {
                resolveMemberEvent()
              }
            },
          )
          .subscribe((status) => {
            if (status === 'SUBSCRIBED') {
              subscribed = true
              settle()
            }
            // CHANNEL_ERROR and TIMED_OUT are left to the client's own retry
            // (for example while the Realtime container is still starting);
            // READY_TIMEOUT_MS bounds the whole wait.
          })
        channels.push({ client, channel })
      })
    }

    try {
      await withTimeout(
        Promise.all([
          subscribe('memberA', memberA.client),
          subscribe('nonMember', nonMember.client),
          subscribe('anon', anon(), true),
        ]),
        READY_TIMEOUT_MS,
        'the channels were not ready within 30 s',
      )

      await started(owner, cycleId)

      await withTimeout(
        memberEvent,
        EVENT_TIMEOUT_MS,
        'member A received no event within 10 s',
      )
      await delay(QUIET_MS)

      const memberMessages = received.get('memberA') ?? []
      expect(memberMessages).toHaveLength(1)
      const [message] =
        memberMessages as RealtimePostgresInsertPayload<CycleEventRow>[]
      expect(Object.keys(message.new).sort()).toEqual(EVENT_COLUMNS)
      expect(message.new.to_status).toBe('reveal')
      expect(message.new.payload).toEqual({})
      expect(received.get('nonMember')).toEqual([])
      expect(received.get('anon')).toEqual([])

      for (const messages of received.values()) {
        for (const payload of messages) {
          sweep(payload, false)
        }
      }
    } finally {
      for (const { client, channel } of channels) {
        await client.removeChannel(channel)
      }
    }
  }, 70_000)
})
