/**
 * Stable error codes raised by the membership RPCs. The database raises them as
 * the exception message; nothing else from a Postgres error is ever shown.
 */
export const MEMBERS_ERROR_CODES = [
  'not_project_owner',
  'not_project_member',
  'invite_invalid',
  'invite_expired',
  'target_not_member',
] as const

export type MembersErrorCode = (typeof MEMBERS_ERROR_CODES)[number] | 'unknown'

const MESSAGES: Record<Exclude<MembersErrorCode, 'unknown'>, string> = {
  not_project_owner: 'Only the project owner can do that.',
  not_project_member: 'Project not found or you do not have access.',
  invite_invalid:
    'This invite link is not valid. Ask the project owner for a new link.',
  invite_expired:
    'This invite link has expired. Ask the project owner for a new link.',
  target_not_member: 'That person is not a member of this project.',
}

/** An error whose message is always a fixed, user-safe sentence. */
export class MembersApiError extends Error {
  readonly code: MembersErrorCode

  constructor(
    code: MembersErrorCode,
    fallbackMessage = 'Something went wrong.',
  ) {
    super(code === 'unknown' ? fallbackMessage : MESSAGES[code])
    this.name = 'MembersApiError'
    this.code = code
  }
}

/** Maps a raw RPC error message to one of the stable codes, else `unknown`. */
export function toMembersErrorCode(
  message: string | null | undefined,
): MembersErrorCode {
  const match = MEMBERS_ERROR_CODES.find((code) => code === message)
  return match ?? 'unknown'
}

export function isMembersErrorCode(
  error: unknown,
  code: MembersErrorCode,
): boolean {
  return error instanceof MembersApiError && error.code === code
}

// Invite tokens are 32 random bytes from the database, hex-encoded.
const INVITE_TOKEN_PATTERN = /^[0-9a-f]{64}$/

export function isInviteToken(value: string): boolean {
  return INVITE_TOKEN_PATTERN.test(value)
}

/** The shareable URL for an invite token on this origin. */
export function buildInviteUrl(token: string, origin: string): string {
  return `${origin}/join/${token}`
}
