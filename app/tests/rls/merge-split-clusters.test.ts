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

/** One row of `create_cluster`, `merge_clusters`, and `split_cluster`. */
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

describe('merge_clusters and split_cluster', () => {
  let cast: RoleCast
  /** Every card id and card text of this file. */
  const secrets: string[] = []
  const anonClients: SupabaseClient[] = []

  beforeAll(async () => {
    cast = await createRoleCast('merge')
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
   * The anonymity sweep for every merge and split response, error, and
   * Realtime message: no member's id or email, no card text or card id.
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
      expect(json, 'leaks a card id or a card text').not.toContain(secret)
    }
  }

  async function mergeClusters(
    caller: Caller,
    sourceClusterId: string,
    targetClusterId: string,
  ): Promise<DbResult<ClusterRow[]>> {
    const { data, error } = await clientOf(caller).rpc('merge_clusters', {
      p_source_cluster_id: sourceClusterId,
      p_target_cluster_id: targetClusterId,
    })
    const result: DbResult<ClusterRow[]> = { data, error }
    sweep(result)
    return result
  }

  async function splitCluster(
    caller: Caller,
    clusterId: string,
    cardIds: readonly string[],
    name: string,
  ): Promise<DbResult<ClusterRow[]>> {
    const { data, error } = await clientOf(caller).rpc('split_cluster', {
      p_cluster_id: clusterId,
      p_card_ids: cardIds,
      p_name: name,
    })
    const result: DbResult<ClusterRow[]> = { data, error }
    sweep(result)
    return result
  }

  async function moveCard(
    caller: Caller,
    cardId: string,
    clusterId: string | null,
  ): Promise<DbResult<unknown>> {
    const { data, error } = await clientOf(caller).rpc('move_card', {
      p_card_id: cardId,
      p_cluster_id: clusterId,
      p_position: null,
    })
    return { data, error }
  }

  async function moved(
    caller: Caller,
    cardId: string,
    clusterId: string | null,
  ): Promise<void> {
    expect((await moveCard(caller, cardId, clusterId)).error).toBeNull()
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
   * A cycle in the cluster stage with four cards from members A and B
   * (attributed and anonymous), and clusters "First" and "Second", each
   * holding two of them, placed by member A.
   */
  async function clustering() {
    const roles = await projectWithRoles(cast)
    const cycleResult: DbResult<CreatedCycleRow[]> =
      await roles.owner.client.rpc('create_cycle', {
        p_project_id: roles.project.id,
        p_title: 'Merge week',
        p_week_start: thisMonday(),
      })
    const [cycle] = expectRows(cycleResult, 1)
    const cardIds: string[] = []
    for (let index = 0; index < 4; index += 1) {
      const author = index % 2 === 0 ? roles.memberA : roles.memberB
      cardIds.push(
        await addCard(
          author,
          cycle.id,
          `Merge card ${String(index)} ${roles.project.id.slice(0, 8)}`,
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
    const first = await cluster(roles.memberA, cycle.id, 'First')
    const second = await cluster(roles.memberA, cycle.id, 'Second')
    await moved(roles.memberA, cardIds[0], first)
    await moved(roles.memberA, cardIds[1], first)
    await moved(roles.memberA, cardIds[2], second)
    await moved(roles.memberA, cardIds[3], second)
    return { ...roles, cycleId: cycle.id, cardIds, first, second }
  }

  function cardsOf(current: CycleBoard, clusterId: string): readonly string[] {
    return (
      current.clusters.find((entry) => entry.cluster_id === clusterId)
        ?.card_ids ?? []
    )
  }

  /** Every clustered card id, once per cluster it is in. */
  function clustered(current: CycleBoard): readonly string[] {
    return current.clusters.flatMap((entry) => entry.card_ids)
  }

  it('member A clusters, member B splits two cards out, the owner merges them back', async () => {
    const { owner, memberA, memberB, cycleId, cardIds, first } =
      await clustering()
    // First = [0, 1]; add card 2 to it, so it has three.
    await moved(memberA, cardIds[2], first)
    expect(cardsOf(await board(memberB, cycleId), first)).toEqual([
      cardIds[0],
      cardIds[1],
      cardIds[2],
    ])

    const split = await splitCluster(
      memberB,
      first,
      [cardIds[2], cardIds[0]],
      '  Tools  ',
    )
    const [created] = expectRows(split, 1)
    expect(created.name).toBe('Tools')
    expect(created.source).toBe('manual')
    const afterSplit = await board(owner, cycleId)
    expect(cardsOf(afterSplit, created.cluster_id)).toEqual([
      cardIds[0],
      cardIds[2],
    ])
    expect(cardsOf(afterSplit, first)).toEqual([cardIds[1]])
    expect(afterSplit.clusters.at(-1)?.cluster_id).toBe(created.cluster_id)

    const merged = await mergeClusters(owner, created.cluster_id, first)
    const [target] = expectRows(merged, 1)
    expect(target).toEqual({
      cluster_id: first,
      name: 'First',
      source: 'manual',
    })
    const afterMerge = await board(memberA, cycleId)
    expect(cardsOf(afterMerge, first)).toEqual([
      cardIds[1],
      cardIds[0],
      cardIds[2],
    ])
    expect(
      afterMerge.clusters.some(
        (entry) => entry.cluster_id === created.cluster_id,
      ),
    ).toBe(false)
  })

  it('the non-member gets cluster_not_found and anon gets 42501; nobody writes the cluster tables directly', async () => {
    const roles = await clustering()
    const { nonMember, first, second, cardIds, cycleId } = roles

    expectPgError(
      await mergeClusters(nonMember, first, second),
      'P0001',
      'cluster_not_found',
    )
    expect(await mergeClusters(nonMember, first, second)).toEqual(
      await mergeClusters(nonMember, unknownId(), second),
    )
    expectPgError(
      await splitCluster(nonMember, first, [cardIds[0]], 'Sneaky'),
      'P0001',
      'cluster_not_found',
    )
    expect(
      await splitCluster(nonMember, first, [cardIds[0]], 'Sneaky'),
    ).toEqual(
      await splitCluster(nonMember, unknownId(), [cardIds[0]], 'Sneaky'),
    )
    expectPgError(await mergeClusters('anon', first, second), '42501')
    expectPgError(
      await splitCluster('anon', first, [cardIds[0]], 'Sneaky'),
      '42501',
    )

    const callers: Caller[] = [
      roles.owner,
      roles.memberA,
      roles.memberB,
      nonMember,
      'anon',
    ]
    for (const caller of callers) {
      const client = clientOf(caller)
      for (const table of ['clusters', 'cluster_cards'] as const) {
        expectPgError(await client.from(table).select(), '42501')
        expectPgError(
          await client
            .from(table)
            .update({ sort_order: 9 })
            .eq('cycle_id', cycleId)
            .select(),
          '42501',
        )
        expectPgError(
          await client.from(table).delete().eq('cycle_id', cycleId).select(),
          '42501',
        )
      }
      expectPgError(
        await client
          .from('clusters')
          .insert({ cycle_id: cycleId, name: 'Sneaky', sort_order: 99 })
          .select(),
        '42501',
      )
      expectPgError(
        await client
          .from('cluster_cards')
          .insert({
            cycle_id: cycleId,
            cluster_id: second,
            card_id: cardIds[0],
          })
          .select(),
        '42501',
      )
    }
    const after = await board(roles.memberA, cycleId)
    expect(cardsOf(after, first)).toEqual([cardIds[0], cardIds[1]])
    expect(cardsOf(after, second)).toEqual([cardIds[2], cardIds[3]])
  })

  it('opposite merges at the same moment: exactly one succeeds and every card ends in one cluster', async () => {
    const { memberA, memberB, cycleId, cardIds, first, second } =
      await clustering()

    const [one, two] = await Promise.all([
      mergeClusters(memberA, first, second),
      mergeClusters(memberB, second, first),
    ])
    const outcomes = [one, two]
    expect(outcomes.filter((result) => result.error === null)).toHaveLength(1)
    const failed = outcomes.find((result) => result.error !== null)
    if (failed === undefined) {
      throw new Error('expected one failure')
    }
    expectPgError(failed, 'P0001', 'cluster_not_found')

    const after = await board(memberA, cycleId)
    const remaining = after.clusters.filter(
      (entry) => entry.cluster_id === first || entry.cluster_id === second,
    )
    expect(remaining).toHaveLength(1)
    expect([...remaining[0].card_ids].sort()).toEqual([...cardIds].sort())
    expect([...clustered(after)].sort()).toEqual([...cardIds].sort())
  })

  it('a split racing a move of one of its cards either splits or gets card_not_in_cluster', async () => {
    const { memberA, memberB, cycleId, cardIds, first, second } =
      await clustering()
    // First = [0, 1, 2]; split 0 and 1 while 0 moves to Second.
    await moved(memberA, cardIds[2], first)

    const [split, move] = await Promise.all([
      splitCluster(memberB, first, [cardIds[0], cardIds[1]], 'Raced'),
      moveCard(memberA, cardIds[0], second),
    ])
    expect(move.error).toBeNull()
    if (split.error !== null) {
      expectPgError(split, 'P0001', 'card_not_in_cluster')
    } else {
      expectRows(split, 1)
    }

    const after = await board(memberB, cycleId)
    const all = clustered(after)
    expect(new Set(all).size).toBe(all.length)
    expect(cardsOf(after, second)).toContain(cardIds[0])
  })

  it('Realtime delivers clusters_changed with no actor to member B after member A merges and splits', async () => {
    const { memberA, memberB, cycleId, cardIds, first, second } =
      await clustering()
    const messages: RealtimePostgresInsertPayload<CycleEventRow>[] = []
    let channel: RealtimeChannel | null = null
    let resolveEvent: () => void = () => undefined

    const nextEvent = () =>
      new Promise<void>((resolve) => {
        resolveEvent = resolve
      })

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
            .channel(`rls-merge-${cycleId}`)
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
      // Events committed before the subscription may still arrive; only what
      // follows each write counts.
      await new Promise((resolve) => setTimeout(resolve, 2_000))

      messages.length = 0
      const merged = nextEvent()
      expectRows(await mergeClusters(memberA, second, first), 1)
      await withTimeout(
        merged,
        EVENT_TIMEOUT_MS,
        'member B received no event within 10 s of the merge',
      )
      // The merge's statements may send several rows; let them all arrive
      // before waiting for the split's.
      await new Promise((resolve) => setTimeout(resolve, 2_000))

      const split = nextEvent()
      expectRows(
        await splitCluster(memberA, first, [cardIds[3]], 'Split out'),
        1,
      )
      await withTimeout(
        split,
        EVENT_TIMEOUT_MS,
        'member B received no event within 10 s of the split',
      )

      expect(messages.length).toBeGreaterThanOrEqual(2)
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
