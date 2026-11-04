import type { RealtimeChannel } from '@supabase/supabase-js'
import { beforeAll, describe, expect, it } from 'vitest'
import { expectPgError, expectRows, type DbResult } from './assertions'
import {
  anonClient,
  createRoleCast,
  projectWithRoles,
  unknownId,
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

interface ActionIdRow {
  readonly action_id: string
}

interface ActionStatusRow {
  readonly action_id: string
  readonly status: string
}

interface ActionRow {
  readonly action_id: string
  readonly cluster_id: string | null
  readonly description: string
  readonly owner_id: string | null
  readonly owner_name: string | null
  readonly owner_is_me: boolean
  readonly created_by_me: boolean
  readonly due_date: string | null
  readonly status: string
  readonly completed_at: string | null
  readonly source: string
  readonly created_at: string
  readonly updated_at: string
}

interface CycleActions {
  readonly cycle_id: string
  readonly actions: readonly ActionRow[]
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

interface ActionFields {
  readonly description: string
  readonly ownerId: string
  readonly dueDate?: string | null
  readonly clusterId?: string | null
}

/** How long the channel may take to become ready. */
const READY_TIMEOUT_MS = 30_000
/** How long the expected events may take to arrive. */
const EVENT_TIMEOUT_MS = 10_000
/** How long the channel is watched after the last expected event. */
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

function createAction(
  user: TestUser,
  cycleId: string,
  fields: ActionFields,
): PromiseLike<DbResult<ActionIdRow[]>> {
  return user.client.rpc('create_action', {
    p_cycle_id: cycleId,
    p_description: fields.description,
    p_owner_id: fields.ownerId,
    p_due_date: fields.dueDate ?? null,
    p_cluster_id: fields.clusterId ?? null,
  })
}

async function created(
  user: TestUser,
  cycleId: string,
  fields: ActionFields,
): Promise<string> {
  const [row] = expectRows(await createAction(user, cycleId, fields), 1)
  return row.action_id
}

function updateAction(
  user: TestUser,
  actionId: string,
  fields: ActionFields,
): PromiseLike<DbResult<ActionIdRow[]>> {
  return user.client.rpc('update_action', {
    p_action_id: actionId,
    p_description: fields.description,
    p_owner_id: fields.ownerId,
    p_due_date: fields.dueDate ?? null,
    p_cluster_id: fields.clusterId ?? null,
  })
}

function setStatus(
  user: TestUser,
  actionId: string,
  status: string,
): PromiseLike<DbResult<ActionStatusRow[]>> {
  return user.client.rpc('set_action_status', {
    p_action_id: actionId,
    p_status: status,
  })
}

function deleteAction(
  user: TestUser,
  actionId: string,
): PromiseLike<DbResult<ActionIdRow[]>> {
  return user.client.rpc('delete_action', { p_action_id: actionId })
}

function readActions(
  user: TestUser,
  cycleId: string,
): PromiseLike<DbResult<CycleActions>> {
  return user.client.rpc('get_cycle_actions', { p_cycle_id: cycleId })
}

async function actions(user: TestUser, cycleId: string): Promise<CycleActions> {
  const result = await readActions(user, cycleId)
  expect(result.error).toBeNull()
  if (result.data === null) {
    throw new Error('no actions')
  }
  return result.data
}

/**
 * Manual action items (#26) through real anon-key clients: the RPCs are the
 * only path, the table is closed to every client, the owner and creator
 * rules hold, and every write broadcasts one id-free event.
 */
describe('actions', () => {
  let roleCast: RoleCast

  beforeAll(async () => {
    roleCast = await createRoleCast('actions')
  })

  /**
   * A new cycle of the project taken to discuss by the owner (the
   * facilitator) through the RPCs: clusters X and Y, vote, close_voting.
   */
  async function discussCycle(roles: ProjectWithRoles): Promise<{
    cycleId: string
    x: string
    y: string
  }> {
    const { owner } = roles
    const made: DbResult<CreatedCycleRow[]> = await owner.client.rpc(
      'create_cycle',
      {
        p_project_id: roles.project.id,
        p_title: 'Actions week',
        p_week_start: thisMonday(),
      },
    )
    const [cycle] = expectRows(made, 1)
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
      const cluster: DbResult<ClusterRow[]> = await owner.client.rpc(
        'create_cluster',
        { p_cycle_id: cycle.id, p_name: name },
      )
      clusterIds.push(expectRows(cluster, 1)[0].cluster_id)
    }
    const toVote: DbResult<StageRow[]> = await owner.client.rpc(
      'advance_stage',
      { p_cycle_id: cycle.id, p_from_status: 'cluster' },
    )
    expect(expectRows(toVote, 1)[0].status).toBe('vote')
    const closed: DbResult<StageRow[]> = await owner.client.rpc(
      'close_voting',
      { p_cycle_id: cycle.id },
    )
    expect(expectRows(closed, 1)[0].status).toBe('discuss')
    return { cycleId: cycle.id, x: clusterIds[0], y: clusterIds[1] }
  }

  async function endCycle(owner: TestUser, cycleId: string): Promise<void> {
    const closed = await owner.client.rpc('close_cycle', {
      p_cycle_id: cycleId,
    })
    expect(closed.error).toBeNull()
  }

  it('B creates actions and D marks one done through the RPCs; every direct access to actions is refused', async () => {
    const roles = await projectWithRoles(roleCast)
    const { owner: a, memberA: b, memberB: d, nonMember: c } = roles
    const { cycleId, x } = await discussCycle(roles)

    const forD = await created(b, cycleId, {
      description: 'Write the runbook',
      ownerId: d.id,
      dueDate: '2026-11-12',
      clusterId: x,
    })
    await created(b, cycleId, { description: 'Own it', ownerId: b.id })
    expect(expectRows(await setStatus(d, forD, 'done'), 1)).toEqual([
      { action_id: forD, status: 'done' },
    ])

    for (const client of [
      anonClient(),
      a.client,
      b.client,
      d.client,
      c.client,
    ]) {
      expectPgError(await client.from('actions').select(), '42501')
      expectPgError(
        await client
          .from('actions')
          .insert({
            cycle_id: cycleId,
            description: 'direct',
            owner_id: b.id,
            created_by: b.id,
          })
          .select(),
        '42501',
      )
      expectPgError(
        await client
          .from('actions')
          .update({ description: 'taken over' })
          .eq('id', forD)
          .select(),
        '42501',
      )
      expectPgError(
        await client.from('actions').delete().eq('id', forD).select(),
        '42501',
      )
    }

    // Nothing changed.
    const after = await actions(a, cycleId)
    expect(after.actions.map((action) => action.description)).toEqual([
      'Write the runbook',
      'Own it',
    ])
    expect(after.actions[0]).toMatchObject({ action_id: forD, status: 'done' })
    await endCycle(a, cycleId)
  })

  it("D reads B's actions with the owner flags; C is refused; B cannot change D's status and D cannot edit B's action", async () => {
    const roles = await projectWithRoles(roleCast)
    const { owner: a, memberA: b, memberB: d, nonMember: c } = roles
    const { cycleId, x } = await discussCycle(roles)
    const forD = await created(b, cycleId, {
      description: 'For D',
      ownerId: d.id,
      dueDate: '2026-11-12',
      clusterId: x,
    })
    const forB = await created(b, cycleId, {
      description: 'For B',
      ownerId: b.id,
    })

    const seenByD = await actions(d, cycleId)
    expect(Object.keys(seenByD).sort()).toEqual(['actions', 'cycle_id'])
    expect(seenByD.actions).toHaveLength(2)
    expect(Object.keys(seenByD.actions[0]).sort()).toEqual([
      'action_id',
      'cluster_id',
      'completed_at',
      'created_at',
      'created_by_me',
      'description',
      'due_date',
      'owner_id',
      'owner_is_me',
      'owner_name',
      'source',
      'status',
      'updated_at',
    ])
    expect(seenByD.actions[0]).toMatchObject({
      action_id: forD,
      cluster_id: x,
      description: 'For D',
      owner_id: d.id,
      owner_name: d.label,
      owner_is_me: true,
      created_by_me: false,
      due_date: '2026-11-12',
      status: 'open',
      completed_at: null,
      source: 'manual',
    })
    expect(seenByD.actions[1]).toMatchObject({
      action_id: forB,
      owner_is_me: false,
      created_by_me: false,
      owner_name: b.label,
    })
    const seenByB = await actions(b, cycleId)
    expect(seenByB.actions.map((action) => action.created_by_me)).toEqual([
      true,
      true,
    ])

    expectPgError(await readActions(c, cycleId), '42501', 'not_project_member')
    expectPgError(
      await createAction(c, cycleId, { description: 'x', ownerId: c.id }),
      '42501',
      'not_project_member',
    )
    expectPgError(
      await updateAction(c, forD, { description: 'x', ownerId: c.id }),
      'P0001',
      'action_not_found',
    )
    expectPgError(await setStatus(c, forD, 'done'), 'P0001', 'action_not_found')
    expectPgError(await deleteAction(c, forD), 'P0001', 'action_not_found')
    expectPgError(
      await deleteAction(c, unknownId()),
      'P0001',
      'action_not_found',
    )
    expectPgError(await setStatus(b, forD, 'done'), '42501', 'not_action_owner')
    expectPgError(
      await updateAction(d, forB, { description: 'mine', ownerId: d.id }),
      '42501',
      'not_action_editor',
    )
    expect(
      (await actions(a, cycleId)).actions.map((row) => row.status),
    ).toEqual(['open', 'open'])
    await endCycle(a, cycleId)
  })

  it('a malformed due date is refused and creates no row', async () => {
    const roles = await projectWithRoles(roleCast)
    const { owner: a, memberA: b } = roles
    const { cycleId } = await discussCycle(roles)

    const result = await createAction(b, cycleId, {
      description: 'Bad date',
      ownerId: b.id,
      dueDate: '2026-13-40',
    })
    expect(result.data).toBeNull()
    expect(result.error).not.toBeNull()
    expect((await actions(b, cycleId)).actions).toEqual([])
    await endCycle(a, cycleId)
  })

  it("after close_cycle, D can still mark D's action done and B's create_action gets cycle_not_discussing", async () => {
    const roles = await projectWithRoles(roleCast)
    const { owner: a, memberA: b, memberB: d } = roles
    const { cycleId } = await discussCycle(roles)
    const forD = await created(b, cycleId, {
      description: 'Follow up',
      ownerId: d.id,
    })
    await endCycle(a, cycleId)

    expect(expectRows(await setStatus(d, forD, 'done'), 1)).toEqual([
      { action_id: forD, status: 'done' },
    ])
    expectPgError(
      await createAction(b, cycleId, { description: 'Late', ownerId: b.id }),
      'P0001',
      'cycle_not_discussing',
    )
    const after = await actions(d, cycleId)
    expect(after.actions).toHaveLength(1)
    expect(after.actions[0].status).toBe('done')
    expect(after.actions[0].completed_at).not.toBeNull()
  })

  it('a Realtime subscriber gets one INSERT per action write and none for a no-op', async () => {
    const roles = await projectWithRoles(roleCast)
    const { owner: a, memberA: b, memberB: d } = roles
    const { cycleId } = await discussCycle(roles)

    const received: CycleEventPayload[] = []
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
          channel = d.client
            .channel(`rls-actions-${cycleId}`)
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

      const existing = await d.client
        .from('cycle_events')
        .select('id')
        .eq('cycle_id', cycleId)
      expect(existing.error).toBeNull()
      const setupIds = new Set((existing.data ?? []).map((row) => row.id))
      const fresh = () =>
        received.filter((payload) => !setupIds.has(payload.new.id))

      // create, edit, a no-op edit, done, a no-op done, delete: four events.
      const actionId = await created(b, cycleId, {
        description: 'First',
        ownerId: d.id,
      })
      expectRows(
        await updateAction(b, actionId, {
          description: 'Second',
          ownerId: d.id,
        }),
        1,
      )
      expectRows(
        await updateAction(b, actionId, {
          description: '  Second  ',
          ownerId: d.id,
        }),
        1,
      )
      expectRows(await setStatus(d, actionId, 'done'), 1)
      expectRows(await setStatus(d, actionId, 'done'), 1)
      expectRows(await deleteAction(b, actionId), 1)

      await withTimeout(
        (async () => {
          while (fresh().length < 4) {
            await delay(100)
          }
        })(),
        EVENT_TIMEOUT_MS,
        'the events did not arrive within 10 s',
      )
      await delay(QUIET_MS)

      const events = fresh().map((payload) => payload.new)
      expect(events).toHaveLength(4)
      for (const event of events) {
        expect(event).toMatchObject({
          type: 'actions_changed',
          from_status: 'discuss',
          to_status: 'discuss',
          actor_id: null,
          payload: {},
        })
      }
    } finally {
      if (channel) {
        await d.client.removeChannel(channel)
      }
    }
    await endCycle(a, cycleId)
  }, 60_000)

  it('limit race: with 198 actions, 5 parallel creates give exactly 2 successes and 3 action_limit_reached', async () => {
    const roles = await projectWithRoles(roleCast)
    const { owner: a, memberA: b, memberB: d } = roles
    const { cycleId } = await discussCycle(roles)

    // Test files never use the service role (_docs/testing.md), so the 198
    // actions go in through create_action, in batches.
    for (let start = 0; start < 198; start += 50) {
      const batch = Array.from(
        { length: Math.min(50, 198 - start) },
        (_unused, index) =>
          createAction(index % 2 === 0 ? b : d, cycleId, {
            description: `Filler ${start + index}`,
            ownerId: b.id,
          }),
      )
      for (const result of await Promise.all(batch)) {
        expectRows(result, 1)
      }
    }

    const results = await Promise.all([
      createAction(b, cycleId, { description: 'race 1', ownerId: b.id }),
      createAction(d, cycleId, { description: 'race 2', ownerId: d.id }),
      createAction(b, cycleId, { description: 'race 3', ownerId: b.id }),
      createAction(d, cycleId, { description: 'race 4', ownerId: d.id }),
      createAction(b, cycleId, { description: 'race 5', ownerId: b.id }),
    ])
    const succeeded = results.filter((result) => result.error === null)
    const refused = results.filter((result) => result.error !== null)
    expect(succeeded).toHaveLength(2)
    expect(refused).toHaveLength(3)
    for (const result of refused) {
      expectPgError(result, 'P0001', 'action_limit_reached')
    }
    expect((await actions(a, cycleId)).actions).toHaveLength(200)
    await endCycle(a, cycleId)
  }, 120_000)

  it('stage race: create_action racing close_cycle either succeeds or gets cycle_not_discussing, never another error', async () => {
    const roles = await projectWithRoles(roleCast)
    const { owner: a, memberA: b } = roles

    for (let round = 0; round < STAGE_RACE_ROUNDS; round += 1) {
      const { cycleId } = await discussCycle(roles)
      const [create, close] = await Promise.all([
        createAction(b, cycleId, {
          description: `Round ${round}`,
          ownerId: b.id,
        }),
        a.client.rpc('close_cycle', { p_cycle_id: cycleId }),
      ])
      expect(close.error).toBeNull()
      let successes = 0
      if (create.error !== null) {
        expectPgError(create, 'P0001', 'cycle_not_discussing')
      } else {
        expectRows(create, 1)
        successes = 1
      }
      expect((await actions(b, cycleId)).actions).toHaveLength(successes)
    }
  }, 120_000)
})
