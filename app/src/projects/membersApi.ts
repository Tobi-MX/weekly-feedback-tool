import { z } from 'zod'
import { supabase } from '@/auth/supabaseClient'
import {
  MembersApiError,
  isInviteToken,
  toMembersErrorCode,
} from './membersErrors'
import { isProjectId } from './projectId'

export type MemberRole = 'facilitator' | 'member'
export type InviteStatus = 'active' | 'expired' | 'revoked'

export interface ProjectMember {
  readonly userId: string
  readonly displayName: string
  readonly role: MemberRole
  readonly isOwner: boolean
  readonly isMe: boolean
  readonly joinedAt: string
}

export interface ProjectInvite {
  readonly token: string
  readonly expiresAt: string
  readonly status: InviteStatus
}

export interface CreatedInvite {
  readonly token: string
  readonly expiresAt: string
}

export interface JoinProjectResult {
  readonly projectId: string
  readonly projectName: string
  readonly alreadyMember: boolean
}

// Narrow schemas for the RPC rows. A row that does not match is treated as an
// unknown failure rather than rendered.
const memberRowSchema = z.object({
  user_id: z.string(),
  display_name: z.string(),
  role: z.enum(['facilitator', 'member']),
  is_owner: z.boolean(),
  is_me: z.boolean(),
  joined_at: z.string(),
})

const inviteRowSchema = z.object({
  token: z.string(),
  expires_at: z.string(),
  status: z.enum(['active', 'expired', 'revoked']),
})

const createdInviteRowSchema = z.object({
  token: z.string(),
  expires_at: z.string(),
})

const joinRowSchema = z.object({
  project_id: z.string(),
  project_name: z.string(),
  already_member: z.boolean(),
})

interface RpcError {
  readonly message: string
}

interface RpcResult {
  readonly data: unknown
  readonly error: RpcError | null
}

const LOAD_MEMBERS_ERROR = 'Could not load the members.'
const LOAD_INVITE_ERROR = 'Could not load the invite link.'
const UPDATE_INVITE_ERROR = 'Could not update the invite link.'
const JOIN_ERROR = 'Could not join the project.'
const TRANSFER_ERROR = 'Could not change the facilitator.'

async function callRpc(
  name: string,
  args: Record<string, unknown>,
  fallbackMessage: string,
): Promise<unknown> {
  if (!supabase) {
    throw new MembersApiError('unknown', fallbackMessage)
  }

  const { data, error }: RpcResult = await supabase.rpc(name, args)

  if (error) {
    // Only the stable code survives; raw Postgres text is never kept.
    throw new MembersApiError(
      toMembersErrorCode(error.message),
      fallbackMessage,
    )
  }

  return data
}

function parseRows<T>(
  schema: z.ZodType<T>,
  data: unknown,
  fallbackMessage: string,
): T[] {
  const parsed = z.array(schema).safeParse(data ?? [])
  if (!parsed.success) {
    throw new MembersApiError('unknown', fallbackMessage)
  }
  return parsed.data
}

/**
 * Lists the members of a project. A non-member, an unknown id, and a non-UUID
 * id all resolve to `null`, the not-found state.
 */
export async function fetchProjectMembers(
  projectId: string,
): Promise<ProjectMember[] | null> {
  if (!isProjectId(projectId)) {
    return null
  }

  let data: unknown
  try {
    data = await callRpc(
      'get_project_members',
      { p_project_id: projectId },
      LOAD_MEMBERS_ERROR,
    )
  } catch (error) {
    if (
      error instanceof MembersApiError &&
      error.code === 'not_project_member'
    ) {
      return null
    }
    throw error
  }

  return parseRows(memberRowSchema, data, LOAD_MEMBERS_ERROR).map((row) => ({
    userId: row.user_id,
    displayName: row.display_name,
    role: row.role,
    isOwner: row.is_owner,
    isMe: row.is_me,
    joinedAt: row.joined_at,
  }))
}

/** Owner only: the project's invite, or `null` if none was ever created. */
export async function fetchProjectInvite(
  projectId: string,
): Promise<ProjectInvite | null> {
  const data = await callRpc(
    'get_project_invite',
    { p_project_id: projectId },
    LOAD_INVITE_ERROR,
  )
  const [row] = parseRows(inviteRowSchema, data, LOAD_INVITE_ERROR)
  if (!row) {
    return null
  }
  return { token: row.token, expiresAt: row.expires_at, status: row.status }
}

/** Owner only: creates the invite or rotates its token. */
export async function createProjectInvite(
  projectId: string,
): Promise<CreatedInvite> {
  const data = await callRpc(
    'create_project_invite',
    { p_project_id: projectId },
    UPDATE_INVITE_ERROR,
  )
  const [row] = parseRows(createdInviteRowSchema, data, UPDATE_INVITE_ERROR)
  if (!row) {
    throw new MembersApiError('unknown', UPDATE_INVITE_ERROR)
  }
  return { token: row.token, expiresAt: row.expires_at }
}

/** Owner only: disables the current invite link. */
export async function revokeProjectInvite(projectId: string): Promise<void> {
  await callRpc(
    'revoke_project_invite',
    { p_project_id: projectId },
    UPDATE_INVITE_ERROR,
  )
}

/** Joins the project behind an invite token as a member. */
export async function joinProject(token: string): Promise<JoinProjectResult> {
  if (!isInviteToken(token)) {
    throw new MembersApiError('invite_invalid')
  }

  const data = await callRpc('join_project', { p_token: token }, JOIN_ERROR)
  const [row] = parseRows(joinRowSchema, data, JOIN_ERROR)
  if (!row) {
    throw new MembersApiError('unknown', JOIN_ERROR)
  }
  return {
    projectId: row.project_id,
    projectName: row.project_name,
    alreadyMember: row.already_member,
  }
}

/** Owner only: hands the single facilitator role to a member. */
export async function transferFacilitator(
  projectId: string,
  userId: string,
): Promise<void> {
  await callRpc(
    'transfer_facilitator',
    { p_project_id: projectId, p_user_id: userId },
    TRANSFER_ERROR,
  )
}
