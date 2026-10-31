import { beforeAll, describe, expect, it } from 'vitest'
import { expectNoRows, expectPgError, expectRows } from './assertions'
import {
  addMember,
  anonClient,
  createProject,
  createUser,
  unknownId,
  type ProfileRow,
  type TestUser,
} from './fixtures'

async function readOwnProfile(user: TestUser): Promise<ProfileRow> {
  const [row] = expectRows<ProfileRow>(
    await user.client.from('profiles').select().eq('id', user.id),
    1,
  )
  return row
}

describe('profiles', () => {
  let alice: TestUser
  let bob: TestUser

  beforeAll(async () => {
    ;[alice, bob] = await Promise.all([
      createUser('profiles-alice'),
      createUser('profiles-bob'),
    ])
  })

  it('user can read and rename their own profile', async () => {
    const before = await readOwnProfile(alice)
    expect(before.id).toBe(alice.id)

    const newName = `Alice ${Date.now()}`
    const [updated] = expectRows<ProfileRow>(
      await alice.client
        .from('profiles')
        .update({ display_name: newName })
        .eq('id', alice.id)
        .select(),
      1,
    )
    expect(updated.display_name).toBe(newName)

    const after = await readOwnProfile(alice)
    expect(after.display_name).toBe(newName)
  })

  it('co-member cannot read or update another user profile', async () => {
    const project = await createProject(alice)
    await addMember(project, alice, bob)
    const before = await readOwnProfile(alice)

    expectNoRows(await bob.client.from('profiles').select().eq('id', alice.id))
    expectNoRows(
      await bob.client
        .from('profiles')
        .update({ display_name: 'Hijacked' })
        .eq('id', alice.id)
        .select(),
    )

    const after = await readOwnProfile(alice)
    expect(after.display_name).toBe(before.display_name)
    expect(after.updated_at).toBe(before.updated_at)
  })

  it('user cannot update the id of their own profile', async () => {
    expectPgError(
      await alice.client
        .from('profiles')
        .update({ id: unknownId() })
        .eq('id', alice.id)
        .select(),
      '42501',
    )
    expect((await readOwnProfile(alice)).id).toBe(alice.id)
  })

  it('user cannot insert a profile row', async () => {
    expectPgError(
      await alice.client
        .from('profiles')
        .insert({ id: alice.id, display_name: 'Duplicate' })
        .select(),
      '42501',
    )
  })

  it('user cannot delete their own profile row', async () => {
    expectPgError(
      await alice.client.from('profiles').delete().eq('id', alice.id).select(),
      '42501',
    )
    await readOwnProfile(alice)
  })

  it('anonymous client cannot read profiles', async () => {
    expectPgError(await anonClient().from('profiles').select(), '42501')
  })
})
