import type {
  RealtimeChannel,
  RealtimePostgresInsertPayload,
  SupabaseClient,
} from '@supabase/supabase-js'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { expectPgError, expectRows, type DbResult } from './assertions'
import {
  anonClient,
  createRoleCast,
  projectWithRoles,
  unknownId,
  type RoleCast,
  type TestUser,
} from './fixtures'

/** One row of `create_cluster` and `rename_cluster`: exactly three keys. */
interface ClusterRow {
  readonly cluster_id: string
  readonly name: string
  readonly source: 'manual' | 'ai'
}

/** One cluster on the board. */
interface BoardCluster {
  readonly cluster_id: string
  readonly name: string
  readonly source: 'manual' | 'ai'
  readonly card_ids: readonly string[]
}

/** The part of the `get_cycle_board` response this file reads. */
interface CycleBoard {
  readonly clusters: readonly BoardCluster[]
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

/** One row of `start_retrospective` and `advance_stage`. */
interface StageRow {
  readonly status: string
}

/** A Realtime `system` message, narrowed to what the test reads. */
interface SystemMessage {
  readonly extension?: string
  readonly status?: string
}

/** Who made a call: a signed-in test user or the signed-out anon client. */
type Caller = TestUser | 'anon'

const CLUSTER_ROW_KEYS = ['cluster_id', 'name', 'source']

/** How long the channels may take to become ready. */
const READY_TIMEOUT_MS = 30_000
/** How long a member may wait for a Realtime event. */
const EVENT_TIMEOUT_MS = 10_000
/** How long the channels are watched after the event arrived. */
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

describe('clusters', () => {
  let cast: RoleCast
  /** Every card id and text create_card has returned in this file. */
  const cardSecrets: string[] = []
  /** Every anon client this file created, so its sockets are closed. */
  const anonClients: SupabaseClient[] = []

  beforeAll(async () => {
    cast = await createRoleCast('clusters')
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
   * The anonymity sweep for every cluster RPC response, error, and Realtime
   * message: no member's id or email, and no card id or card text.
   */
  function sweep(value: unknown): void {
    const json = JSON.stringify(value)
    for (const user of [
      cast.owner,
      cast.memberA,
      cast.memberB,
      cast.nonMember,
    ]) {
      expect(json, `leaks ${user.label} id`).not.toContain(user.id)
      expect(json, `leaks ${user.label} email`).not.toContain(user.email)
    }
    for (const secret of cardSecrets) {
      expect(json, 'leaks a card id or text').not.toContain(secret)
    }
  }

  async function createCluster(
    caller: Caller,
    cycleId: string,
    name: string,
  ): Promise<DbResult<ClusterRow[]>> {
    const { data, error } = await clientOf(caller).rpc('create_cluster', {
      p_cycle_id: cycleId,
      p_name: name,
    })
    const result: DbResult<ClusterRow[]> = { data, error }
    sweep(result)
    return result
  }

  async function renameCluster(
    caller: Caller,
    clusterId: string,
    name: string,
  ): Promise<DbResult<ClusterRow[]>> {
    const { data, error } = await clientOf(caller).rpc('rename_cluster', {
      p_cluster_id: clusterId,
      p_name: name,
    })
    const result: DbResult<ClusterRow[]> = { data, error }
    sweep(result)
    return result
  }

  async function deleteCluster(
    caller: Caller,
    clusterId: string,
  ): Promise<DbResult<unknown>> {
    const { data, error } = await clientOf(caller).rpc('delete_cluster', {
      p_cluster_id: clusterId,
    })
    const result: DbResult<unknown> = { data, error }
    sweep(result)
    return result
  }

  async function created(
    user: TestUser,
    cycleId: string,
    name: string,
  ): Promise<ClusterRow> {
    const [row] = expectRows(await createCluster(user, cycleId, name), 1)
    expect(Object.keys(row).sort()).toEqual(CLUSTER_ROW_KEYS)
    expect(row).toMatchObject({ name, source: 'manual' })
    return row
  }

  async function boardClusters(
    user: TestUser,
    cycleId: string,
  ): Promise<readonly BoardCluster[]> {
    const { data, error } = await user.client.rpc('get_cycle_board', {
      p_cycle_id: cycleId,
    })
    const result: DbResult<CycleBoard> = { data, error }
    expect(result.error).toBeNull()
    if (result.data === null) {
      throw new Error('expected a board')
    }
    return result.data.clusters
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
        p_category: 'stop',
        p_text: text,
        p_is_anonymous: isAnonymous,
      },
    )
    const [row] = expectRows(result, 1)
    cardSecrets.push(row.id, row.text)
  }

  /**
   * A project with a cycle in the cluster stage: cards from member A (one
   * attributed, one anonymous) and member B (anonymous), revealed and
   * advanced by the owner.
   */
  async function clustering() {
    const roles = await projectWithRoles(cast)
    const cycleResult: DbResult<CreatedCycleRow[]> =
      await roles.owner.client.rpc('create_cycle', {
        p_project_id: roles.project.id,
        p_title: 'Cluster week',
        p_week_start: thisMonday(),
      })
    const [cycle] = expectRows(cycleResult, 1)
    await addCard(roles.memberA, cycle.id, 'Cluster A attributed', false)
    await addCard(roles.memberA, cycle.id, 'Cluster A hidden', true)
    await addCard(roles.memberB, cycle.id, 'Cluster B hidden', true)
    const started: DbResult<StageRow[]> = await roles.owner.client.rpc(
      'start_retrospective',
      { p_cycle_id: cycle.id },
    )
    expect(expectRows(started, 1)[0].status).toBe('reveal')
    const advanced: DbResult<StageRow[]> = await roles.owner.client.rpc(
      'advance_stage',
      { p_cycle_id: cycle.id, p_from_status: 'reveal' },
    )
    expect(expectRows(advanced, 1)[0].status).toBe('cluster')
    return { ...roles, cycleId: cycle.id }
  }

  it('member A creates, member B renames, and the owner deletes a cluster', async () => {
    const { owner, memberA, memberB, cycleId } = await clustering()

    const row = await created(memberA, cycleId, 'Process')
    expect(await boardClusters(memberB, cycleId)).toEqual([
      {
        cluster_id: row.cluster_id,
        name: 'Process',
        source: 'manual',
        card_ids: [],
      },
    ])

    const [renamed] = expectRows(
      await renameCluster(memberB, row.cluster_id, '  Process and tools '),
      1,
    )
    expect(renamed).toEqual({
      cluster_id: row.cluster_id,
      name: 'Process and tools',
      source: 'manual',
    })
    expect((await boardClusters(owner, cycleId))[0].name).toBe(
      'Process and tools',
    )

    const deleted = await deleteCluster(owner, row.cluster_id)
    expect(deleted.error).toBeNull()
    expect(await boardClusters(memberA, cycleId)).toEqual([])
  })

  it('the non-member and anon are refused; a probe cannot tell a real cluster id from a random one', async () => {
    const { memberA, nonMember, cycleId } = await clustering()
    const row = await created(memberA, cycleId, 'Members only')

    expectPgError(
      await createCluster(nonMember, cycleId, 'Outsider'),
      '42501',
      'not_project_member',
    )
    expectPgError(
      await renameCluster(nonMember, row.cluster_id, 'Taken over'),
      'P0001',
      'cluster_not_found',
    )
    expectPgError(
      await deleteCluster(nonMember, row.cluster_id),
      'P0001',
      'cluster_not_found',
    )
    const real = await renameCluster(nonMember, row.cluster_id, 'x')
    const random = await renameCluster(nonMember, unknownId(), 'x')
    expect(real).toEqual(random)

    expectPgError(await createCluster('anon', cycleId, 'Anon'), '42501')
    expectPgError(await renameCluster('anon', row.cluster_id, 'Anon'), '42501')
    expectPgError(await deleteCluster('anon', row.cluster_id), '42501')

    const clusters = await boardClusters(memberA, cycleId)
    expect(clusters.map((cluster) => cluster.name)).toEqual(['Members only'])
  })

  it('no role can read or write clusters or cluster_cards directly', async () => {
    const roles = await clustering()
    const row = await created(roles.memberA, roles.cycleId, 'Direct')
    const callers: Caller[] = [
      roles.owner,
      roles.memberA,
      roles.memberB,
      roles.nonMember,
      'anon',
    ]

    for (const caller of callers) {
      const client = clientOf(caller)
      for (const table of ['clusters', 'cluster_cards']) {
        expectPgError(await client.from(table).select(), '42501')
        expectPgError(
          await client
            .from(table)
            .update({ sort_order: 9 })
            .eq('cycle_id', roles.cycleId)
            .select(),
          '42501',
        )
        expectPgError(
          await client
            .from(table)
            .delete()
            .eq('cycle_id', roles.cycleId)
            .select(),
          '42501',
        )
      }
      expectPgError(
        await client
          .from('clusters')
          .insert({ cycle_id: roles.cycleId, name: 'Sneaky', sort_order: 99 })
          .select(),
        '42501',
      )
      expectPgError(
        await client
          .from('cluster_cards')
          .insert({
            cycle_id: roles.cycleId,
            cluster_id: row.cluster_id,
            card_id: cardSecrets[0],
          })
          .select(),
        '42501',
      )
    }

    const clusters = await boardClusters(roles.memberB, roles.cycleId)
    expect(clusters).toEqual([
      {
        cluster_id: row.cluster_id,
        name: 'Direct',
        source: 'manual',
        card_ids: [],
      },
    ])
  })

  it('Realtime delivers one clusters_changed event to member B and nothing to the non-member', async () => {
    const { memberA, memberB, nonMember, cycleId } = await clustering()

    const received = new Map<
      string,
      RealtimePostgresInsertPayload<CycleEventRow>[]
    >()
    const channels: { client: SupabaseClient; channel: RealtimeChannel }[] = []
    let resolveMemberEvent: () => void = () => undefined

    /**
     * Resolves once the channel reports SUBSCRIBED and Realtime confirms the
     * Postgres Changes listener (see cycle-events.test.ts).
     */
    const subscribe = (label: string, client: SupabaseClient) => {
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
          .channel(`rls-clusters-${label}-${cycleId}`)
          .on('system', {}, (message: SystemMessage) => {
            if (message.extension !== 'postgres_changes') {
              return
            }
            if (message.status === 'ok') {
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
              if (label === 'memberB') {
                resolveMemberEvent()
              }
            },
          )
          .subscribe((status) => {
            if (status === 'SUBSCRIBED') {
              subscribed = true
              settle()
            }
          })
        channels.push({ client, channel })
      })
    }

    try {
      await withTimeout(
        Promise.all([
          subscribe('memberB', memberB.client),
          subscribe('nonMember', nonMember.client),
        ]),
        READY_TIMEOUT_MS,
        'the channels were not ready within 30 s',
      )

      // A stage event committed before the subscription can still arrive
      // after SUBSCRIBED under load. Let it drain, then count only what the
      // create produces.
      await delay(QUIET_MS)
      for (const messages of received.values()) {
        messages.length = 0
      }
      const memberEvent = new Promise<void>((resolve) => {
        resolveMemberEvent = resolve
      })

      await created(memberA, cycleId, 'Live cluster')

      await withTimeout(
        memberEvent,
        EVENT_TIMEOUT_MS,
        'member B received no event within 10 s',
      )
      await delay(QUIET_MS)

      const memberMessages = received.get('memberB') ?? []
      expect(memberMessages).toHaveLength(1)
      const [message] = memberMessages
      expect(message.new.type).toBe('clusters_changed')
      expect(message.new.actor_id).toBeNull()
      expect(message.new.from_status).toBe('cluster')
      expect(message.new.to_status).toBe('cluster')
      expect(message.new.payload).toEqual({})
      expect(received.get('nonMember')).toEqual([])

      for (const messages of received.values()) {
        for (const payload of messages) {
          sweep(payload)
        }
      }
    } finally {
      for (const { client, channel } of channels) {
        await client.removeChannel(channel)
      }
    }
  }, 70_000)
})
