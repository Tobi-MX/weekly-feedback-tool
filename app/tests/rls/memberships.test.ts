import { beforeAll, describe, expect, it } from 'vitest'
import { expectNoRows, expectPgError, expectRows } from './assertions'
import {
  createProject,
  createRoleCast,
  getMembers,
  makeFacilitator,
  projectWithRoles,
  unknownId,
  type MemberRpcRow,
  type ProjectMemberRow,
  type RoleCast,
  type TestUser,
} from './fixtures'

/** The members as `[user_id, role]` pairs, sorted, read by an allowed user. */
async function roles(
  reader: TestUser,
  projectId: string,
): Promise<Array<[string, string]>> {
  const result = await getMembers(reader, projectId)
  const rows = expectRows(result, result.data?.length ?? 0)
  return rows
    .map((row): [string, string] => [row.user_id, row.role])
    .sort(([a], [b]) => a.localeCompare(b))
}

function facilitators(rows: readonly MemberRpcRow[]): string[] {
  return rows.filter((row) => row.role === 'facilitator').map((r) => r.user_id)
}

describe('memberships and roles', () => {
  let cast: RoleCast

  beforeAll(async () => {
    cast = await createRoleCast('members')
  })

  it('member can read every membership row of their project', async () => {
    const { project, owner, memberA, memberB } = await projectWithRoles(cast)
    const rows = expectRows<ProjectMemberRow>(
      await memberA.client
        .from('project_members')
        .select()
        .eq('project_id', project.id),
      3,
    )
    expect(rows.map((row) => row.user_id).sort()).toEqual(
      [owner.id, memberA.id, memberB.id].sort(),
    )
  })

  it('non-member cannot read project members', async () => {
    const { project, nonMember } = await projectWithRoles(cast)
    expectNoRows(
      await nonMember.client
        .from('project_members')
        .select()
        .eq('project_id', project.id),
    )
  })

  it('owner cannot insert, update, or delete membership rows directly', async () => {
    const { project, owner, memberA, nonMember } = await projectWithRoles(cast)
    const before = await roles(owner, project.id)

    expectPgError(
      await owner.client
        .from('project_members')
        .insert({
          project_id: project.id,
          user_id: nonMember.id,
          role: 'member',
        })
        .select(),
      '42501',
    )
    expectPgError(
      await owner.client
        .from('project_members')
        .update({ role: 'facilitator' })
        .eq('project_id', project.id)
        .eq('user_id', memberA.id)
        .select(),
      '42501',
    )
    expectPgError(
      await owner.client
        .from('project_members')
        .delete()
        .eq('project_id', project.id)
        .eq('user_id', memberA.id)
        .select(),
      '42501',
    )

    expect(await roles(owner, project.id)).toEqual(before)
  })

  it('member cannot add themselves to another project', async () => {
    const { owner, memberA } = cast
    const other = await createProject(owner)
    expectPgError(
      await memberA.client
        .from('project_members')
        .insert({ project_id: other.id, user_id: memberA.id, role: 'member' })
        .select(),
      '42501',
    )
    expect(await roles(owner, other.id)).toEqual([[owner.id, 'facilitator']])
  })

  it('member cannot promote themselves to facilitator or delete their row', async () => {
    const { project, owner, memberA } = await projectWithRoles(cast)
    const before = await roles(owner, project.id)

    expectPgError(
      await memberA.client
        .from('project_members')
        .update({ role: 'facilitator' })
        .eq('project_id', project.id)
        .eq('user_id', memberA.id)
        .select(),
      '42501',
    )
    expectPgError(
      await memberA.client
        .from('project_members')
        .delete()
        .eq('project_id', project.id)
        .eq('user_id', memberA.id)
        .select(),
      '42501',
    )

    expect(await roles(memberA, project.id)).toEqual(before)
  })

  it('member can list members with exactly the public keys and no email', async () => {
    const { project, owner, memberA, memberB } = await projectWithRoles(cast)
    const rows = expectRows(await getMembers(memberA, project.id), 3)

    for (const row of rows) {
      expect(Object.keys(row).sort()).toEqual(
        [
          'display_name',
          'is_me',
          'is_owner',
          'joined_at',
          'role',
          'user_id',
        ].sort(),
      )
      expect(JSON.stringify(row)).not.toContain('@')
    }

    const byId = new Map(rows.map((row) => [row.user_id, row]))
    expect(byId.get(owner.id)).toMatchObject({
      role: 'facilitator',
      is_owner: true,
      is_me: false,
      display_name: owner.label,
    })
    expect(byId.get(memberA.id)).toMatchObject({
      role: 'member',
      is_owner: false,
      is_me: true,
    })
    expect(byId.get(memberB.id)).toMatchObject({ role: 'member', is_me: false })
  })

  it('non-member cannot list members of a project or of an unknown project', async () => {
    const { project, owner, nonMember } = await projectWithRoles(cast)
    expectPgError(
      await getMembers(nonMember, project.id),
      '42501',
      'not_project_member',
    )
    expectPgError(
      await getMembers(owner, unknownId()),
      '42501',
      'not_project_member',
    )
  })

  it('member, non-member, and non-owner facilitator cannot transfer the facilitator role', async () => {
    const { project, owner, memberA, memberB, nonMember } =
      await projectWithRoles(cast)
    await makeFacilitator(project, owner, memberB)
    const before = await roles(owner, project.id)

    for (const caller of [memberA, nonMember, memberB]) {
      expectPgError(
        await caller.client.rpc('transfer_facilitator', {
          p_project_id: project.id,
          p_user_id: caller.id,
        }),
        '42501',
        'not_project_owner',
      )
    }

    expect(await roles(owner, project.id)).toEqual(before)
  })

  it('owner can transfer the facilitator role to a member and take it back', async () => {
    const { project, owner, memberB } = await projectWithRoles(cast)

    for (const target of [memberB, owner]) {
      const result = await owner.client.rpc('transfer_facilitator', {
        p_project_id: project.id,
        p_user_id: target.id,
      })
      expect(result).toMatchObject({ data: null, error: null })

      const rows = expectRows(await getMembers(owner, project.id), 3)
      expect(facilitators(rows)).toEqual([target.id])
    }
  })

  it('owner cannot transfer the facilitator role to a non-member', async () => {
    const { project, owner, nonMember } = await projectWithRoles(cast)
    expectPgError(
      await owner.client.rpc('transfer_facilitator', {
        p_project_id: project.id,
        p_user_id: nonMember.id,
      }),
      'P0001',
      'target_not_member',
    )
    const rows = expectRows(await getMembers(owner, project.id), 3)
    expect(facilitators(rows)).toEqual([owner.id])
  })
})
