import { randomBytes } from 'node:crypto'
import { beforeAll, describe, expect, it } from 'vitest'
import { expectPgError, expectRows, type DbResult } from './assertions'
import {
  anonClient,
  createInvite,
  createProject,
  createRoleCast,
  expireInvite,
  getMembers,
  joinWithToken,
  makeFacilitator,
  projectWithRoles,
  unknownId,
  type InviteRpcRow,
  type MemberRpcRow,
  type RoleCast,
  type TestUser,
} from './fixtures'

const OWNER_ONLY_RPCS = [
  'create_project_invite',
  'get_project_invite',
  'revoke_project_invite',
] as const

function membershipsOf(
  rows: readonly MemberRpcRow[],
  user: TestUser,
): MemberRpcRow[] {
  return rows.filter((row) => row.user_id === user.id)
}

/** Asserts a join failed with exactly `code`, and the message omits the token. */
function expectJoinError(
  result: DbResult<unknown>,
  code: 'invite_invalid' | 'invite_expired',
  token: string,
): void {
  expectPgError(result, 'P0001', code)
  expect(result.error?.message).not.toContain(token)
}

describe('invites and joining', () => {
  let cast: RoleCast

  beforeAll(async () => {
    cast = await createRoleCast('invites')
  })

  it('owner cannot select project_invites directly', async () => {
    const { owner } = cast
    const project = await createProject(owner)
    await createInvite(project, owner)
    expectPgError(
      await owner.client
        .from('project_invites')
        .select()
        .eq('project_id', project.id),
      '42501',
    )
  })

  it('member, non-owner facilitator, and non-member cannot manage invites', async () => {
    const { project, owner, memberA, memberB, nonMember } =
      await projectWithRoles(cast)
    await makeFacilitator(project, owner, memberB)
    const token = await createInvite(project, owner)

    for (const caller of [memberA, memberB, nonMember]) {
      for (const fn of OWNER_ONLY_RPCS) {
        expectPgError(
          await caller.client.rpc(fn, { p_project_id: project.id }),
          '42501',
          'not_project_owner',
        )
      }
    }

    // The owner's invite is untouched by the denied calls.
    const [invite] = expectRows<InviteRpcRow>(
      await owner.client.rpc('get_project_invite', {
        p_project_id: project.id,
      }),
      1,
    )
    expect(invite).toMatchObject({ token, status: 'active' })
  })

  it('owner cannot manage invites of an unknown project', async () => {
    const { owner } = cast
    for (const fn of OWNER_ONLY_RPCS) {
      expectPgError(
        await owner.client.rpc(fn, { p_project_id: unknownId() }),
        '42501',
        'not_project_owner',
      )
    }
  })

  it('user can join with an active token, and joining again changes nothing', async () => {
    const { owner, memberA, memberB } = cast
    const project = await createProject(owner)
    const token = await createInvite(project, owner)

    const [first] = expectRows(await joinWithToken(memberA, token), 1)
    expect(first).toEqual({
      project_id: project.id,
      project_name: project.name,
      already_member: false,
    })
    let rows = expectRows(await getMembers(owner, project.id), 2)
    expect(membershipsOf(rows, memberA)).toMatchObject([{ role: 'member' }])

    const [again] = expectRows(await joinWithToken(memberA, token), 1)
    expect(again.already_member).toBe(true)
    rows = expectRows(await getMembers(owner, project.id), 2)
    expect(membershipsOf(rows, memberA)).toMatchObject([{ role: 'member' }])

    const [second] = expectRows(await joinWithToken(memberB, token), 1)
    expect(second.already_member).toBe(false)
    expectRows(await getMembers(owner, project.id), 3)
  })

  it('facilitator joining again keeps their role', async () => {
    const { owner, memberA } = cast
    const project = await createProject(owner)
    const token = await createInvite(project, owner)
    expectRows(await joinWithToken(memberA, token), 1)
    await makeFacilitator(project, owner, memberA)

    const [again] = expectRows(await joinWithToken(memberA, token), 1)
    expect(again.already_member).toBe(true)
    const rows = expectRows(await getMembers(owner, project.id), 2)
    expect(membershipsOf(rows, memberA)).toMatchObject([
      { role: 'facilitator' },
    ])
  })

  it('user cannot join with a rotated-out token but can with the new one', async () => {
    const { owner, nonMember } = cast
    const project = await createProject(owner)
    const oldToken = await createInvite(project, owner)
    const newToken = await createInvite(project, owner)
    expect(newToken).not.toBe(oldToken)

    expectJoinError(
      await joinWithToken(nonMember, oldToken),
      'invite_invalid',
      oldToken,
    )
    const [joined] = expectRows(await joinWithToken(nonMember, newToken), 1)
    expect(joined.already_member).toBe(false)
  })

  it('user cannot join with a revoked token', async () => {
    const { owner, nonMember } = cast
    const project = await createProject(owner)
    const token = await createInvite(project, owner)
    expect(
      await owner.client.rpc('revoke_project_invite', {
        p_project_id: project.id,
      }),
    ).toMatchObject({ data: null, error: null })

    expectJoinError(
      await joinWithToken(nonMember, token),
      'invite_invalid',
      token,
    )
    expectRows(await getMembers(owner, project.id), 1)
  })

  it('user cannot join with an expired token', async () => {
    const { owner, nonMember } = cast
    const project = await createProject(owner)
    const token = await createInvite(project, owner)
    await expireInvite(project.id)

    expectJoinError(
      await joinWithToken(nonMember, token),
      'invite_expired',
      token,
    )
    expectRows(await getMembers(owner, project.id), 1)
  })

  it('user cannot join with an unknown token', async () => {
    const { nonMember } = cast
    const token = randomBytes(32).toString('hex')
    expectJoinError(
      await joinWithToken(nonMember, token),
      'invite_invalid',
      token,
    )
  })

  it('anonymous client cannot join with a valid token', async () => {
    const { owner } = cast
    const project = await createProject(owner)
    const token = await createInvite(project, owner)

    const result = await anonClient().rpc('join_project', { p_token: token })
    expectPgError(result, '42501')
    expect(result.error?.message).not.toContain(token)
    expectRows(await getMembers(owner, project.id), 1)
  })
})
