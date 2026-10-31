import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import type { RlsEnv } from './env'

/**
 * The only service-role client in the harness. It is used to create and
 * delete users, to delete fixture rows in teardown, and to change state that
 * has no product RPC yet. It is never used for an allow or deny assertion,
 * and test files never import this module.
 */
export function createAdminClient(env: RlsEnv): SupabaseClient {
  return createClient(env.url, env.serviceRoleKey, {
    auth: {
      persistSession: false,
      autoRefreshToken: false,
      detectSessionInUrl: false,
    },
  })
}

const PAGE_SIZE = 1000

/** Ids of every auth user whose email starts with `prefix` and ends with `suffix`. */
export async function findUserIds(
  admin: SupabaseClient,
  prefix: string,
  suffix: string,
): Promise<string[]> {
  const ids: string[] = []
  for (let page = 1; ; page += 1) {
    const { data, error } = await admin.auth.admin.listUsers({
      page,
      perPage: PAGE_SIZE,
    })
    if (error) {
      throw new Error(`Could not list auth users: ${error.message}`)
    }
    for (const user of data.users) {
      const email = user.email ?? ''
      if (email.startsWith(prefix) && email.endsWith(suffix)) {
        ids.push(user.id)
      }
    }
    if (data.users.length < PAGE_SIZE) {
      return ids
    }
  }
}

/**
 * Deletes every project owned by the given users and then the users. The
 * order matters: `projects.owner_id` is `on delete restrict`. Member and
 * invite rows go with the projects through their cascades.
 */
export async function deleteUsersAndProjects(
  admin: SupabaseClient,
  userIds: readonly string[],
): Promise<void> {
  if (userIds.length === 0) {
    return
  }

  const { error: projectsError } = await admin
    .from('projects')
    .delete()
    .in('owner_id', [...userIds])
  if (projectsError) {
    throw new Error(
      `Could not delete fixture projects: ${projectsError.code} ${projectsError.message}`,
    )
  }

  for (const id of userIds) {
    const { error } = await admin.auth.admin.deleteUser(id)
    if (error) {
      throw new Error(`Could not delete fixture user ${id}: ${error.message}`)
    }
  }
}

/** Deletes the matching users and the projects they own. */
export async function sweepUsers(
  admin: SupabaseClient,
  prefix: string,
  suffix: string,
): Promise<void> {
  const ids = await findUserIds(admin, prefix, suffix)
  await deleteUsersAndProjects(admin, ids)
}

/**
 * Moves the project's invite into the past. There is no product RPC for this
 * yet, so it is one of the few service-role writes the harness makes.
 */
export async function expireProjectInvite(
  admin: SupabaseClient,
  projectId: string,
): Promise<void> {
  const { data, error } = await admin
    .from('project_invites')
    .update({ expires_at: new Date(Date.now() - 60_000).toISOString() })
    .eq('project_id', projectId)
    .select('project_id')
  if (error) {
    throw new Error(`Could not expire invite: ${error.code} ${error.message}`)
  }
  if (data.length !== 1) {
    throw new Error('Could not expire invite: the project has no invite')
  }
}
