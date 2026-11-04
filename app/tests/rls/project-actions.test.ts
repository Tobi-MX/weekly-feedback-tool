import { beforeAll, describe, expect, it } from 'vitest'
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

interface ProjectActionRow {
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
  readonly cycle_id: string
  readonly cycle_title: string
  readonly cycle_status: string
  readonly cluster_name: string | null
}

interface ProjectActions {
  readonly project_id: string
  readonly status: string
  readonly mine_only: boolean
  readonly open_count: number
  readonly done_count: number
  readonly open: readonly ProjectActionRow[]
  readonly done: readonly ProjectActionRow[]
}

const STATUSES = ['open', 'done', 'all'] as const

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

function readProjectActions(
  client: TestUser['client'],
  projectId: string,
  status: string,
  mineOnly: boolean,
): PromiseLike<DbResult<ProjectActions>> {
  return client.rpc('get_project_actions', {
    p_project_id: projectId,
    p_status: status,
    p_mine_only: mineOnly,
  })
}

async function projectActions(
  user: TestUser,
  projectId: string,
  status: string,
  mineOnly: boolean,
): Promise<ProjectActions> {
  const result = await readProjectActions(
    user.client,
    projectId,
    status,
    mineOnly,
  )
  expect(result.error).toBeNull()
  if (result.data === null) {
    throw new Error('no project actions')
  }
  return result.data
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

async function created(
  user: TestUser,
  cycleId: string,
  description: string,
  ownerId: string,
  dueDate: string | null,
  clusterId: string | null,
): Promise<string> {
  const result: DbResult<ActionIdRow[]> = await user.client.rpc(
    'create_action',
    {
      p_cycle_id: cycleId,
      p_description: description,
      p_owner_id: ownerId,
      p_due_date: dueDate,
      p_cluster_id: clusterId,
    },
  )
  return expectRows(result, 1)[0].action_id
}

/**
 * The project action list (#27) through real anon-key clients: every member
 * reads the project's actions through get_project_actions with every filter,
 * a non-member and a signed-out client are refused, a status change from a
 * closed cycle shows in the next read, and the table stays closed.
 */
describe('project actions', () => {
  let roleCast: RoleCast

  beforeAll(async () => {
    roleCast = await createRoleCast('projact')
  })

  /**
   * A new cycle taken to discuss by the owner (the facilitator) through the
   * RPCs: cluster X, vote, close_voting. Returns the cycle and cluster ids.
   */
  async function discussCycle(
    roles: ProjectWithRoles,
    title: string,
  ): Promise<{ cycleId: string; x: string }> {
    const { owner } = roles
    const made: DbResult<CreatedCycleRow[]> = await owner.client.rpc(
      'create_cycle',
      {
        p_project_id: roles.project.id,
        p_title: title,
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
    const cluster: DbResult<ClusterRow[]> = await owner.client.rpc(
      'create_cluster',
      { p_cycle_id: cycle.id, p_name: 'X' },
    )
    const x = expectRows(cluster, 1)[0].cluster_id
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
    return { cycleId: cycle.id, x }
  }

  async function endCycle(owner: TestUser, cycleId: string): Promise<void> {
    const closed = await owner.client.rpc('close_cycle', {
      p_cycle_id: cycleId,
    })
    expect(closed.error).toBeNull()
  }

  /**
   * Project P with a closed cycle (D's action, B's action) and a cycle in
   * discuss (A's action).
   */
  async function setUp() {
    const roles = await projectWithRoles(roleCast)
    const { owner: a, memberA: b, memberB: d } = roles
    const first = await discussCycle(roles, 'First retro')
    const forD = await created(
      b,
      first.cycleId,
      'Write the runbook',
      d.id,
      '2026-11-12',
      first.x,
    )
    const forB = await created(a, first.cycleId, 'Own it', b.id, null, null)
    await endCycle(a, first.cycleId)
    const second = await discussCycle(roles, 'Second retro')
    const forA = await created(
      a,
      second.cycleId,
      'Book the room',
      a.id,
      '2026-11-01',
      null,
    )
    return { roles, first, second, forD, forB, forA }
  }

  it('B, D and A read P with every filter; C and a signed-out client are refused', async () => {
    const { roles, first, second, forD, forB, forA } = await setUp()
    const { owner: a, memberA: b, memberB: d, nonMember: c } = roles
    const owners: Record<string, string> = {
      [forD]: d.id,
      [forB]: b.id,
      [forA]: a.id,
    }

    for (const user of [b, d, a]) {
      for (const status of STATUSES) {
        for (const mineOnly of [false, true]) {
          const body = await projectActions(
            user,
            roles.project.id,
            status,
            mineOnly,
          )
          expect(Object.keys(body).sort()).toEqual([
            'done',
            'done_count',
            'mine_only',
            'open',
            'open_count',
            'project_id',
            'status',
          ])
          expect(body).toMatchObject({
            project_id: roles.project.id,
            status,
            mine_only: mineOnly,
            open_count: mineOnly ? 1 : 3,
            done_count: 0,
            done: [],
          })
          const expected = Object.keys(owners).filter(
            (id) => !mineOnly || owners[id] === user.id,
          )
          const ids = body.open.map((row) => row.action_id)
          if (status === 'done') {
            expect(ids).toEqual([])
          } else {
            expect([...ids].sort()).toEqual([...expected].sort())
            for (const row of body.open) {
              expect(row.owner_is_me).toBe(row.owner_id === user.id)
              expect(Object.keys(row)).toHaveLength(17)
              expect(row).not.toHaveProperty('created_by')
            }
          }
        }
      }
    }

    // The open list across both cycles, by due date with no date last.
    const all = await projectActions(b, roles.project.id, 'all', false)
    expect(all.open.map((row) => row.action_id)).toEqual([forA, forD, forB])
    expect(all.open[1]).toMatchObject({
      cycle_id: first.cycleId,
      cycle_title: 'First retro',
      cycle_status: 'closed',
      cluster_id: first.x,
      cluster_name: 'X',
      owner_name: d.label,
      due_date: '2026-11-12',
    })
    expect(all.open[0]).toMatchObject({
      cycle_id: second.cycleId,
      cycle_status: 'discuss',
      cluster_name: null,
    })

    for (const status of STATUSES) {
      expectPgError(
        await readProjectActions(c.client, roles.project.id, status, false),
        '42501',
        'not_project_member',
      )
      const signedOut = await readProjectActions(
        anonClient(),
        roles.project.id,
        status,
        false,
      )
      expect(signedOut.data).toBeNull()
      expect(signedOut.error).not.toBeNull()
    }
    expectPgError(
      await readProjectActions(b.client, roles.project.id, 'closed', false),
      'P0001',
      'invalid_action_filter',
    )

    await endCycle(a, second.cycleId)
  })

  it("D marks D's action in the closed cycle done and B's next read shows it; B cannot change it", async () => {
    const { roles, second, forD } = await setUp()
    const { owner: a, memberA: b, memberB: d } = roles

    expectPgError(await setStatus(b, forD, 'done'), '42501', 'not_action_owner')
    expect(expectRows(await setStatus(d, forD, 'done'), 1)).toEqual([
      { action_id: forD, status: 'done' },
    ])

    const after = await projectActions(b, roles.project.id, 'all', false)
    expect(after.open_count).toBe(2)
    expect(after.done_count).toBe(1)
    expect(after.open.map((row) => row.action_id)).not.toContain(forD)
    expect(after.done).toHaveLength(1)
    expect(after.done[0]).toMatchObject({
      action_id: forD,
      status: 'done',
      cycle_status: 'closed',
      owner_is_me: false,
    })
    expect(after.done[0].completed_at).not.toBeNull()

    const mine = await projectActions(d, roles.project.id, 'done', true)
    expect(mine.done.map((row) => row.action_id)).toEqual([forD])
    expect(mine.done[0].owner_is_me).toBe(true)

    await endCycle(a, second.cycleId)
  })

  it('a direct select on actions is still refused for every anon-key client', async () => {
    const { roles, second } = await setUp()
    const { owner: a, memberA: b, memberB: d, nonMember: c } = roles

    for (const client of [
      anonClient(),
      a.client,
      b.client,
      d.client,
      c.client,
    ]) {
      const result = await client.from('actions').select()
      expectPgError(result, '42501')
      expect(result.data).toBeNull()
    }

    await endCycle(a, second.cycleId)
  })
})
