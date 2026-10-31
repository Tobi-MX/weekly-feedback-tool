import { beforeAll, describe, expect, it } from 'vitest'
import { expectNoRows, expectPgError, expectRows } from './assertions'
import {
  anonClient,
  createProject,
  createRoleCast,
  getMembers,
  projectWithRoles,
  unknownId,
  type ProjectRow,
  type RoleCast,
  type TestUser,
} from './fixtures'

async function readProject(
  user: TestUser,
  projectId: string,
): Promise<ProjectRow> {
  const [row] = expectRows<ProjectRow>(
    await user.client.from('projects').select().eq('id', projectId),
    1,
  )
  return row
}

describe('projects', () => {
  let cast: RoleCast

  beforeAll(async () => {
    cast = await createRoleCast('projects')
  })

  it('owner can create, read, and rename a project and is its only facilitator', async () => {
    const { owner } = cast
    const project = await createProject(owner, 'Owner project')
    expect(project.owner_id).toBe(owner.id)

    expect((await readProject(owner, project.id)).name).toBe('Owner project')

    const [renamed] = expectRows<ProjectRow>(
      await owner.client
        .from('projects')
        .update({ name: 'Renamed project' })
        .eq('id', project.id)
        .select(),
      1,
    )
    expect(renamed.name).toBe('Renamed project')
    expect((await readProject(owner, project.id)).name).toBe('Renamed project')

    const members = expectRows(await getMembers(owner, project.id), 1)
    expect(members[0].user_id).toBe(owner.id)
    expect(members[0].role).toBe('facilitator')
  })

  it('user cannot create a project owned by another user', async () => {
    const { owner, nonMember } = cast
    expectPgError(
      await nonMember.client
        .from('projects')
        .insert({ name: 'Not mine', owner_id: owner.id })
        .select(),
      '42501',
    )
  })

  it('user cannot create a project with id, created_at, or updated_at set', async () => {
    const { owner } = cast
    const timestamp = new Date().toISOString()
    for (const extra of [
      { id: unknownId() },
      { created_at: timestamp },
      { updated_at: timestamp },
    ]) {
      expectPgError(
        await owner.client
          .from('projects')
          .insert({ name: 'Bad columns', owner_id: owner.id, ...extra })
          .select(),
        '42501',
      )
    }
  })

  it('non-member cannot read, rename, or delete a project', async () => {
    const { project, owner, nonMember } = await projectWithRoles(cast)

    expectNoRows(
      await nonMember.client.from('projects').select().eq('id', project.id),
    )
    expectNoRows(
      await nonMember.client
        .from('projects')
        .update({ name: 'Taken over' })
        .eq('id', project.id)
        .select(),
    )
    expectPgError(
      await nonMember.client
        .from('projects')
        .delete()
        .eq('id', project.id)
        .select(),
      '42501',
    )

    expect((await readProject(owner, project.id)).name).toBe(project.name)
  })

  it('member can read but not rename or delete a project', async () => {
    const { project, owner, memberA } = await projectWithRoles(cast)

    expect((await readProject(memberA, project.id)).id).toBe(project.id)
    expectNoRows(
      await memberA.client
        .from('projects')
        .update({ name: 'Member rename' })
        .eq('id', project.id)
        .select(),
    )
    expectPgError(
      await memberA.client
        .from('projects')
        .delete()
        .eq('id', project.id)
        .select(),
      '42501',
    )

    expect((await readProject(owner, project.id)).name).toBe(project.name)
  })

  it('owner cannot delete their project', async () => {
    const { owner } = cast
    const project = await createProject(owner)
    expectPgError(
      await owner.client
        .from('projects')
        .delete()
        .eq('id', project.id)
        .select(),
      '42501',
    )
    await readProject(owner, project.id)
  })

  it('anonymous client cannot read or create projects', async () => {
    const { owner } = cast
    const anon = anonClient()
    expectPgError(await anon.from('projects').select(), '42501')
    expectPgError(
      await anon
        .from('projects')
        .insert({ name: 'Anonymous', owner_id: owner.id })
        .select(),
      '42501',
    )
  })
})
