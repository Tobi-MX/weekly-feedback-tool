import { beforeAll, describe, expect, it } from 'vitest'
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
  type ProjectRow,
  type RoleCast,
  type TestUser,
} from './fixtures'

/** One row of `public.feedback_cycles`. */
interface CycleRow {
  readonly id: string
  readonly project_id: string
  readonly title: string
  readonly week_start: string
  readonly status: string
  readonly created_by: string | null
  readonly created_at: string
  readonly updated_at: string
  readonly revealed_at: string | null
  readonly voting_closed_at: string | null
  readonly closed_at: string | null
}

/** One row of `create_cycle`. */
interface CreatedCycleRow {
  readonly id: string
  readonly project_id: string
  readonly title: string
  readonly week_start: string
  readonly status: string
  readonly created_at: string
}

/** One row of `close_cycle`. */
interface ClosedCycleRow {
  readonly id: string
  readonly status: string
  readonly closed_at: string | null
}

/** The Monday of the current UTC week, as the database's current_date sees it. */
function thisMonday(): string {
  const now = new Date()
  const day = now.getUTCDay()
  const offset = (day + 6) % 7
  const monday = new Date(
    Date.UTC(
      now.getUTCFullYear(),
      now.getUTCMonth(),
      now.getUTCDate() - offset,
    ),
  )
  return monday.toISOString().slice(0, 10)
}

function callCreate(
  user: TestUser,
  project: ProjectRow,
  title = 'Week of this Monday',
): PromiseLike<DbResult<CreatedCycleRow[]>> {
  return user.client.rpc('create_cycle', {
    p_project_id: project.id,
    p_title: title,
    p_week_start: thisMonday(),
  })
}

function callClose(
  user: TestUser,
  cycleId: string,
): PromiseLike<DbResult<ClosedCycleRow[]>> {
  return user.client.rpc('close_cycle', { p_cycle_id: cycleId })
}

async function createCycle(
  user: TestUser,
  project: ProjectRow,
): Promise<CreatedCycleRow> {
  const [row] = expectRows(await callCreate(user, project), 1)
  return row
}

async function cyclesOf(
  reader: TestUser,
  project: ProjectRow,
): Promise<readonly CycleRow[]> {
  const result: DbResult<CycleRow[]> = await reader.client
    .from('feedback_cycles')
    .select()
    .eq('project_id', project.id)
  return expectRows(result, result.data?.length ?? 0)
}

describe('feedback cycles', () => {
  let cast: RoleCast

  beforeAll(async () => {
    cast = await createRoleCast('cycles')
  })

  it('facilitator creates a cycle that members read and non-members cannot', async () => {
    const { project, owner, memberA, nonMember } = await projectWithRoles(cast)

    const created = await createCycle(owner, project)
    expect(created.project_id).toBe(project.id)
    expect(created.status).toBe('collecting')
    expect(created.week_start).toBe(thisMonday())

    const [row] = expectRows<CycleRow>(
      await memberA.client
        .from('feedback_cycles')
        .select()
        .eq('project_id', project.id),
      1,
    )
    expect(row.id).toBe(created.id)
    expect(row.created_by).toBe(owner.id)

    expectNoRows(
      await nonMember.client
        .from('feedback_cycles')
        .select()
        .eq('project_id', project.id),
    )
    expectNoRows(
      await nonMember.client
        .from('feedback_cycles')
        .select()
        .eq('id', created.id),
    )
  })

  it('member and non-member cannot create a cycle', async () => {
    const { project, owner, memberA, nonMember } = await projectWithRoles(cast)

    expectPgError(
      await callCreate(memberA, project),
      '42501',
      'not_project_facilitator',
    )
    expectPgError(
      await callCreate(nonMember, project),
      '42501',
      'not_project_member',
    )

    expect(await cyclesOf(owner, project)).toHaveLength(0)
  })

  it('facilitator cannot open a second cycle while one is open', async () => {
    const { project, owner } = await projectWithRoles(cast)
    await createCycle(owner, project)

    expectPgError(
      await callCreate(owner, project, 'Second'),
      'P0001',
      'cycle_already_open',
    )

    const rows = await cyclesOf(owner, project)
    expect(rows.filter((row) => row.status !== 'closed')).toHaveLength(1)
  })

  it('facilitator cannot insert, update, or delete cycles directly', async () => {
    const { project, owner } = await projectWithRoles(cast)
    const created = await createCycle(owner, project)
    const [before] = await cyclesOf(owner, project)

    expectPgError(
      await owner.client
        .from('feedback_cycles')
        .insert({
          project_id: project.id,
          title: 'Direct',
          week_start: thisMonday(),
        })
        .select(),
      '42501',
    )
    expectPgError(
      await owner.client
        .from('feedback_cycles')
        .update({ status: 'closed', closed_at: new Date().toISOString() })
        .eq('id', created.id)
        .select(),
      '42501',
    )
    expectPgError(
      await owner.client
        .from('feedback_cycles')
        .delete()
        .eq('id', created.id)
        .select(),
      '42501',
    )

    expect(await cyclesOf(owner, project)).toEqual([before])
  })

  it('member and non-member cannot close a cycle', async () => {
    const { project, owner, memberA, nonMember } = await projectWithRoles(cast)
    const created = await createCycle(owner, project)

    expectPgError(
      await callClose(memberA, created.id),
      '42501',
      'not_project_facilitator',
    )
    expectPgError(
      await callClose(nonMember, created.id),
      '42501',
      'not_project_member',
    )

    const [row] = await cyclesOf(owner, project)
    expect(row.status).toBe('collecting')
    expect(row.closed_at).toBeNull()
  })

  it('new facilitator controls the open cycle and the owner loses control', async () => {
    const { project, owner, memberB } = await projectWithRoles(cast)
    const created = await createCycle(owner, project)

    await makeFacilitator(project, owner, memberB)

    expectPgError(
      await callClose(owner, created.id),
      '42501',
      'not_project_facilitator',
    )
    const [closed] = expectRows(await callClose(memberB, created.id), 1)
    expect(closed.id).toBe(created.id)
    expect(closed.status).toBe('closed')
    expect(closed.closed_at).not.toBeNull()

    const next = await createCycle(memberB, project)
    expect(next.status).toBe('collecting')

    const rows = await cyclesOf(owner, project)
    expect(rows).toHaveLength(2)
    expect(rows.find((row) => row.id === next.id)?.created_by).toBe(memberB.id)
    expect(rows.find((row) => row.id === created.id)?.created_by).toBe(owner.id)
  })

  it('anonymous client cannot read cycles or create one', async () => {
    const { project } = await projectWithRoles(cast)
    const anon = anonClient()

    expectPgError(await anon.from('feedback_cycles').select(), '42501')
    expectPgError(
      await anon.rpc('create_cycle', {
        p_project_id: project.id,
        p_title: 'Anonymous',
        p_week_start: thisMonday(),
      }),
      '42501',
    )
  })
})
