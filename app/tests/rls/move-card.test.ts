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

/** One row of `create_cluster`. */
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
  readonly cards: readonly { readonly card_id: string }[]
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

type Caller = TestUser | 'anon'

const READY_TIMEOUT_MS = 30_000
const EVENT_TIMEOUT_MS = 10_000

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

describe('move_card', () => {
  let cast: RoleCast
  /** Every card id and text, and every cluster id, of this file. */
  const secrets: string[] = []
  const anonClients: SupabaseClient[] = []

  beforeAll(async () => {
    cast = await createRoleCast('move')
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

  function clientOf(caller: Caller): SupabaseClient {
    if (caller !== 'anon') {
      return caller.client
    }
    const client = anonClient()
    anonClients.push(client)
    return client
  }

  /**
   * The anonymity sweep for every move_card response, error, and Realtime
   * message: no member's id or email, no card text, card id, or cluster id.
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
    for (const secret of secrets) {
      expect(json, 'leaks a card or cluster id or a card text').not.toContain(
        secret,
      )
    }
  }

  async function moveCard(
    caller: Caller,
    cardId: string,
    clusterId: string | null,
    position: number | null,
  ): Promise<DbResult<unknown>> {
    const { data, error } = await clientOf(caller).rpc('move_card', {
      p_card_id: cardId,
      p_cluster_id: clusterId,
      p_position: position,
    })
    const result: DbResult<unknown> = { data, error }
    sweep(result)
    return result
  }

  async function moved(
    caller: Caller,
    cardId: string,
    clusterId: string | null,
    position: number | null = null,
  ): Promise<void> {
    const result = await moveCard(caller, cardId, clusterId, position)
    expect(result.error).toBeNull()
  }

  async function board(user: TestUser, cycleId: string): Promise<CycleBoard> {
    const { data, error } = await user.client.rpc('get_cycle_board', {
      p_cycle_id: cycleId,
    })
    const result: DbResult<CycleBoard> = { data, error }
    expect(result.error).toBeNull()
    if (result.data === null) {
      throw new Error('expected a board')
    }
    return result.data
  }

  async function cluster(
    user: TestUser,
    cycleId: string,
    name: string,
  ): Promise<string> {
    const result: DbResult<ClusterRow[]> = await user.client.rpc(
      'create_cluster',
      { p_cycle_id: cycleId, p_name: name },
    )
    const [row] = expectRows(result, 1)
    secrets.push(row.cluster_id)
    return row.cluster_id
  }

  async function addCard(
    user: TestUser,
    cycleId: string,
    text: string,
    isAnonymous: boolean,
  ): Promise<string> {
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
    secrets.push(row.id, row.text)
    return row.id
  }

  /**
   * A cycle in the cluster stage with cards from members A and B (attributed
   * and anonymous) and two clusters.
   */
  async function clustering(cardCount = 2) {
    const roles = await projectWithRoles(cast)
    const cycleResult: DbResult<CreatedCycleRow[]> =
      await roles.owner.client.rpc('create_cycle', {
        p_project_id: roles.project.id,
        p_title: 'Move week',
        p_week_start: thisMonday(),
      })
    const [cycle] = expectRows(cycleResult, 1)
    const cardIds: string[] = []
    for (let index = 0; index < cardCount; index += 1) {
      const author = index % 2 === 0 ? roles.memberA : roles.memberB
      cardIds.push(
        await addCard(
          author,
          cycle.id,
          `Move card ${String(index)} ${roles.project.id.slice(0, 8)}`,
          index % 3 === 1,
        ),
      )
    }
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
    const first = await cluster(roles.owner, cycle.id, 'First')
    const second = await cluster(roles.owner, cycle.id, 'Second')
    return { ...roles, cycleId: cycle.id, cardIds, first, second }
  }

  function clusterOf(current: CycleBoard, cardId: string): readonly string[] {
    return current.clusters
      .filter((entry) => entry.card_ids.includes(cardId))
      .map((entry) => entry.cluster_id)
  }

  it('member A moves a card into a cluster, member B to another, then to Ungrouped', async () => {
    const { memberA, memberB, owner, cycleId, cardIds, first, second } =
      await clustering()
    const [card] = cardIds

    await moved(memberA, card, first)
    expect(clusterOf(await board(memberB, cycleId), card)).toEqual([first])

    await moved(memberB, card, second, 0)
    expect(clusterOf(await board(owner, cycleId), card)).toEqual([second])

    await moved(memberB, card, null)
    const after = await board(memberA, cycleId)
    expect(clusterOf(after, card)).toEqual([])
    expect(after.cards.map((entry) => entry.card_id)).toContain(card)
  })

  it('the non-member gets card_not_found and anon gets 42501; nobody writes cluster_cards directly', async () => {
    const roles = await clustering()
    const [card] = roles.cardIds

    expectPgError(
      await moveCard(roles.nonMember, card, roles.first, null),
      'P0001',
      'card_not_found',
    )
    expect(await moveCard(roles.nonMember, card, roles.first, null)).toEqual(
      await moveCard(roles.nonMember, unknownId(), roles.first, null),
    )
    expectPgError(await moveCard('anon', card, roles.first, null), '42501')

    const callers: Caller[] = [
      roles.owner,
      roles.memberA,
      roles.memberB,
      roles.nonMember,
      'anon',
    ]
    for (const caller of callers) {
      const client = clientOf(caller)
      expectPgError(await client.from('cluster_cards').select(), '42501')
      expectPgError(
        await client
          .from('cluster_cards')
          .insert({
            cycle_id: roles.cycleId,
            cluster_id: roles.first,
            card_id: card,
          })
          .select(),
        '42501',
      )
      expectPgError(
        await client
          .from('cluster_cards')
          .update({ sort_order: 9 })
          .eq('cycle_id', roles.cycleId)
          .select(),
        '42501',
      )
      expectPgError(
        await client
          .from('cluster_cards')
          .delete()
          .eq('cycle_id', roles.cycleId)
          .select(),
        '42501',
      )
    }
    expect(clusterOf(await board(roles.memberA, roles.cycleId), card)).toEqual(
      [],
    )
  })

  it('concurrent moves of one card all succeed and leave it in exactly one cluster', async () => {
    const { memberA, memberB, cycleId, cardIds, first, second } =
      await clustering()
    const [card] = cardIds

    const results = await Promise.all(
      Array.from({ length: 10 }, (_unused, index) =>
        moveCard(
          index % 2 === 0 ? memberA : memberB,
          card,
          index % 3 === 0 ? first : second,
          null,
        ),
      ),
    )
    for (const result of results) {
      expect(result.error).toBeNull()
    }
    expect(clusterOf(await board(memberA, cycleId), card)).toHaveLength(1)
  })

  it('five cards moved concurrently into one cluster all land once', async () => {
    const { memberA, memberB, cycleId, cardIds, first } = await clustering(5)

    const results = await Promise.all(
      cardIds.map((card, index) =>
        moveCard(index % 2 === 0 ? memberA : memberB, card, first, 0),
      ),
    )
    for (const result of results) {
      expect(result.error).toBeNull()
    }
    const listed =
      (await board(memberB, cycleId)).clusters.find(
        (entry) => entry.cluster_id === first,
      )?.card_ids ?? []
    expect([...listed].sort()).toEqual([...cardIds].sort())
  })

  it('Realtime delivers clusters_changed with no actor to member B after member A moves a card', async () => {
    const { memberA, memberB, cycleId, cardIds, first } = await clustering()
    const messages: RealtimePostgresInsertPayload<CycleEventRow>[] = []
    let channel: RealtimeChannel | null = null
    let resolveEvent: () => void = () => undefined

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
          channel = memberB.client
            .channel(`rls-move-${cycleId}`)
            .on('system', {}, (message: SystemMessage) => {
              if (message.extension !== 'postgres_changes') {
                return
              }
              if (message.status === 'ok') {
                listening = true
                settle()
              } else {
                reject(new Error(`could not listen: ${String(message.status)}`))
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
                messages.push(payload)
                if (payload.new.type === 'clusters_changed') {
                  resolveEvent()
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
      // Events committed before the subscription (the stage changes and the
      // cluster creates) may still arrive; only what follows the move counts.
      await new Promise((resolve) => setTimeout(resolve, 2_000))
      messages.length = 0
      const event = new Promise<void>((resolve) => {
        resolveEvent = resolve
      })

      await moved(memberA, cardIds[0], first)
      await withTimeout(
        event,
        EVENT_TIMEOUT_MS,
        'member B received no event within 10 s',
      )

      expect(messages.length).toBeGreaterThanOrEqual(1)
      for (const message of messages) {
        expect(message.new.type).toBe('clusters_changed')
        expect(message.new.actor_id).toBeNull()
        expect(message.new.payload).toEqual({})
        sweep(message)
      }
    } finally {
      if (channel !== null) {
        await memberB.client.removeChannel(channel)
      }
    }
  }, 70_000)
})
