import { randomBytes } from 'node:crypto'
import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import { inject } from 'vitest'
import { createAdminClient, expireProjectInvite } from './admin'
import type { DbResult } from './assertions'
import { RLS_EMAIL_DOMAIN, RLS_EMAIL_PREFIX, type RlsEnv } from './env'

/**
 * Fixtures for the multi-user RLS suite. Users sign in on their own anon-key
 * clients; projects and roles are built through the real product paths. The
 * service-role client is used only to create users and to expire invites.
 */

export interface TestUser {
  readonly id: string
  readonly email: string
  readonly label: string
  readonly client: SupabaseClient
}

export interface ProjectRow {
  readonly id: string
  readonly name: string
  readonly owner_id: string
  readonly created_at: string
  readonly updated_at: string
}

export interface ProfileRow {
  readonly id: string
  readonly display_name: string
  readonly avatar_url: string | null
  readonly created_at: string
  readonly updated_at: string
}

export interface ProjectMemberRow {
  readonly project_id: string
  readonly user_id: string
  readonly role: 'facilitator' | 'member'
  readonly created_at: string
  readonly updated_at: string
}

/** One row of `get_project_members`. */
export interface MemberRpcRow {
  readonly user_id: string
  readonly display_name: string
  readonly role: 'facilitator' | 'member'
  readonly is_owner: boolean
  readonly is_me: boolean
  readonly joined_at: string
}

/** One row of `create_project_invite`. */
export interface CreatedInviteRow {
  readonly token: string
  readonly expires_at: string
}

/** One row of `get_project_invite`. */
export interface InviteRpcRow {
  readonly token: string
  readonly expires_at: string
  readonly status: 'active' | 'expired' | 'revoked'
}

/** One row of `join_project`. */
export interface JoinRpcRow {
  readonly project_id: string
  readonly project_name: string
  readonly already_member: boolean
}

export interface RoleCast {
  readonly owner: TestUser
  readonly memberA: TestUser
  readonly memberB: TestUser
  readonly nonMember: TestUser
}

export interface ProjectWithRoles extends RoleCast {
  readonly project: ProjectRow
}

const LABEL_PATTERN = /^[a-z0-9][a-z0-9-]{0,40}$/

const CLIENT_OPTIONS = {
  auth: {
    persistSession: false,
    autoRefreshToken: false,
    detectSessionInUrl: false,
  },
} as const

let adminClient: SupabaseClient | undefined

function env(): RlsEnv {
  return inject('rlsEnv')
}

function admin(): SupabaseClient {
  adminClient ??= createAdminClient(env())
  return adminClient
}

/** The email for a label in this run: `rls-<runId>-<label>@example.test`. */
export function emailFor(label: string): string {
  return `${RLS_EMAIL_PREFIX}${inject('rlsRunId')}-${label}${RLS_EMAIL_DOMAIN}`
}

/** The message for a failed sign-in. A 429 names the local rate limit. */
export function signInFailureMessage(
  label: string,
  status: number | undefined,
  message: string,
): string {
  if (status === 429) {
    return (
      `Sign-in for "${label}" was rejected with HTTP 429 by the local auth ` +
      'rate limit. Raise [auth.rate_limit] sign_in_sign_ups in ' +
      'supabase/config.toml, then run `supabase stop && supabase start`.'
    )
  }
  return `Sign-in for "${label}" failed (HTTP ${status ?? 'unknown'}): ${message}`
}

/** A fresh anon-key client with no shared or persisted session. */
function newAnonKeyClient(): SupabaseClient {
  const { url, anonKey } = env()
  return createClient(url, anonKey, CLIENT_OPTIONS)
}

/** An anon-key client with no session: the signed-out browser. */
export function anonClient(): SupabaseClient {
  return newAnonKeyClient()
}

/**
 * Creates a confirmed user through the admin API and signs it in on its own
 * anon-key client with an admin-set random password. No email is sent, and
 * the password never leaves this function.
 */
export async function createUser(label: string): Promise<TestUser> {
  if (!LABEL_PATTERN.test(label)) {
    throw new Error(
      `Invalid user label "${label}": use lowercase letters, digits, and dashes`,
    )
  }

  const email = emailFor(label)
  const password = randomBytes(24).toString('base64url')

  const created = await admin().auth.admin.createUser({
    email,
    password,
    email_confirm: true,
    user_metadata: { display_name: label },
  })
  if (created.error) {
    throw new Error(
      `Could not create user "${label}" (labels must be unique per run): ${created.error.message}`,
    )
  }

  const client = newAnonKeyClient()
  const signedIn = await client.auth.signInWithPassword({ email, password })
  if (signedIn.error) {
    throw new Error(
      signInFailureMessage(
        label,
        signedIn.error.status,
        signedIn.error.message,
      ),
    )
  }

  return { id: created.data.user.id, email, label, client }
}

/** Creates `<prefix>-owner`, `-member-a`, `-member-b`, and `-non-member`. */
export async function createRoleCast(prefix: string): Promise<RoleCast> {
  const [owner, memberA, memberB, nonMember] = await Promise.all([
    createUser(`${prefix}-owner`),
    createUser(`${prefix}-member-a`),
    createUser(`${prefix}-member-b`),
    createUser(`${prefix}-non-member`),
  ])
  return { owner, memberA, memberB, nonMember }
}

function setupFailure(step: string, result: DbResult<unknown>): Error {
  const detail = result.error
    ? `${result.error.code} ${result.error.message}`
    : 'unexpected result'
  return new Error(`Fixture step "${step}" failed: ${detail}`)
}

let projectCounter = 0

/** Inserts a project through the owner's own client. */
export async function createProject(
  owner: TestUser,
  name = `RLS project ${++projectCounter}`,
): Promise<ProjectRow> {
  const result: DbResult<ProjectRow[]> = await owner.client
    .from('projects')
    .insert({ name, owner_id: owner.id })
    .select()
  const [row] = result.data ?? []
  if (result.error || row === undefined) {
    throw setupFailure('createProject', result)
  }
  return row
}

/** Creates or rotates the project's invite as the owner and returns the token. */
export async function createInvite(
  project: ProjectRow,
  owner: TestUser,
): Promise<string> {
  const result: DbResult<CreatedInviteRow[]> = await owner.client.rpc(
    'create_project_invite',
    { p_project_id: project.id },
  )
  const [row] = result.data ?? []
  if (result.error || row === undefined) {
    throw setupFailure('create_project_invite', result)
  }
  return row.token
}

/** Joins with a token as the given user. */
export async function joinWithToken(
  user: TestUser,
  token: string,
): Promise<DbResult<JoinRpcRow[]>> {
  return user.client.rpc('join_project', { p_token: token })
}

/** Adds a member the product way: the owner invites, the user joins. */
export async function addMember(
  project: ProjectRow,
  owner: TestUser,
  user: TestUser,
): Promise<void> {
  const token = await createInvite(project, owner)
  const result = await joinWithToken(user, token)
  if (result.error || result.data?.length !== 1) {
    throw setupFailure('join_project', result)
  }
}

/** Hands the facilitator role to a member through `transfer_facilitator`. */
export async function makeFacilitator(
  project: ProjectRow,
  owner: TestUser,
  user: TestUser,
): Promise<void> {
  const result: DbResult<unknown> = await owner.client.rpc(
    'transfer_facilitator',
    { p_project_id: project.id, p_user_id: user.id },
  )
  if (result.error) {
    throw setupFailure('transfer_facilitator', result)
  }
}

/**
 * A new project owned by `cast.owner` (its facilitator after creation) with
 * member A and member B joined through an invite. The non-member stays out.
 */
export async function projectWithRoles(
  cast: RoleCast,
): Promise<ProjectWithRoles> {
  const project = await createProject(cast.owner)
  await addMember(project, cast.owner, cast.memberA)
  await addMember(project, cast.owner, cast.memberB)
  return { project, ...cast }
}

/** Calls `get_project_members` as the given user. */
export async function getMembers(
  user: TestUser,
  projectId: string,
): Promise<DbResult<MemberRpcRow[]>> {
  return user.client.rpc('get_project_members', { p_project_id: projectId })
}

/**
 * Moves the project's invite `expires_at` into the past. There is no product
 * RPC for this yet, so it uses the service role.
 */
export async function expireInvite(projectId: string): Promise<void> {
  await expireProjectInvite(admin(), projectId)
}

/** A random UUID that names no row. */
export function unknownId(): string {
  return crypto.randomUUID()
}
