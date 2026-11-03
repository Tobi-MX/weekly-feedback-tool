import { CLUSTER_GONE_MESSAGE } from './clusterErrors'

/**
 * The stable codes the discussion RPCs raise (#25). Anything else (a network
 * failure, a reply that does not match the strict schema) is `unknown`.
 * Nothing else from a Postgres error is ever kept, shown, or logged.
 */
export const DISCUSSION_ERROR_CODES = [
  'not_project_member',
  'not_project_facilitator',
  'not_note_author',
  'cycle_not_discussing',
  'cluster_not_found',
  'note_not_found',
  'invalid_note_text',
  'invalid_discussion_status',
  'note_limit_reached',
] as const

export type DiscussionErrorCode =
  (typeof DISCUSSION_ERROR_CODES)[number] | 'unknown'

/** Which discussion write failed; the copy depends on it. */
export type DiscussionWrite = 'status' | 'add' | 'edit' | 'delete'

export const NOT_FACILITATOR_STATUS_MESSAGE =
  'Only the facilitator can change discussion statuses.'
export const NOT_AUTHOR_EDIT_MESSAGE = 'You can edit only your own notes.'
export const NOT_AUTHOR_DELETE_MESSAGE = 'You can delete only your own notes.'
export const STATUS_NOT_DISCUSSING_MESSAGE =
  'Statuses can only be changed during the Discuss stage.'
export const NOTES_NOT_DISCUSSING_MESSAGE =
  'Notes can only be changed during the Discuss stage.'
export const NOTE_GONE_MESSAGE = 'This note no longer exists.'
export const INVALID_NOTE_TEXT_MESSAGE = 'Notes must be 1 to 2,000 characters.'
export const NOTE_LIMIT_MESSAGE =
  'This retrospective has reached its limit of 500 notes.'
export const STATUS_FAILED_MESSAGE = 'Could not update the status.'
export const SAVE_NOTE_FAILED_MESSAGE = 'Could not save your note.'
export const DELETE_NOTE_FAILED_MESSAGE = 'Could not delete the note.'

const unknownCopy: Record<DiscussionWrite, string> = {
  status: STATUS_FAILED_MESSAGE,
  add: SAVE_NOTE_FAILED_MESSAGE,
  edit: SAVE_NOTE_FAILED_MESSAGE,
  delete: DELETE_NOTE_FAILED_MESSAGE,
}

/**
 * The toast for every code and write. `null` means no toast: the board
 * switches to its not-found state instead. A code a write never raises uses
 * that write's `unknown` copy. A `Record` over every code, so a code without
 * copy fails the typecheck.
 */
export const DISCUSSION_ERROR_MESSAGES: Record<
  DiscussionErrorCode,
  Record<DiscussionWrite, string | null>
> = {
  not_project_member: { status: null, add: null, edit: null, delete: null },
  not_project_facilitator: {
    ...unknownCopy,
    status: NOT_FACILITATOR_STATUS_MESSAGE,
  },
  not_note_author: {
    status: STATUS_FAILED_MESSAGE,
    add: NOT_AUTHOR_EDIT_MESSAGE,
    edit: NOT_AUTHOR_EDIT_MESSAGE,
    delete: NOT_AUTHOR_DELETE_MESSAGE,
  },
  cycle_not_discussing: {
    status: STATUS_NOT_DISCUSSING_MESSAGE,
    add: NOTES_NOT_DISCUSSING_MESSAGE,
    edit: NOTES_NOT_DISCUSSING_MESSAGE,
    delete: NOTES_NOT_DISCUSSING_MESSAGE,
  },
  cluster_not_found: {
    status: CLUSTER_GONE_MESSAGE,
    add: CLUSTER_GONE_MESSAGE,
    edit: CLUSTER_GONE_MESSAGE,
    delete: DELETE_NOTE_FAILED_MESSAGE,
  },
  note_not_found: {
    status: STATUS_FAILED_MESSAGE,
    add: NOTE_GONE_MESSAGE,
    edit: NOTE_GONE_MESSAGE,
    delete: NOTE_GONE_MESSAGE,
  },
  invalid_note_text: {
    ...unknownCopy,
    add: INVALID_NOTE_TEXT_MESSAGE,
    edit: INVALID_NOTE_TEXT_MESSAGE,
  },
  note_limit_reached: {
    ...unknownCopy,
    add: NOTE_LIMIT_MESSAGE,
    edit: NOTE_LIMIT_MESSAGE,
  },
  invalid_discussion_status: unknownCopy,
  unknown: unknownCopy,
}

/**
 * The toast for a failed discussion write, or null for `not_project_member`,
 * which switches the board to its not-found state instead.
 */
export function discussionErrorMessage(
  code: DiscussionErrorCode,
  write: DiscussionWrite,
): string | null {
  return DISCUSSION_ERROR_MESSAGES[code][write]
}

/** An error that carries only a stable code, never the server's text. */
export class DiscussionApiError extends Error {
  readonly code: DiscussionErrorCode

  constructor(code: DiscussionErrorCode) {
    super(code)
    this.name = 'DiscussionApiError'
    this.code = code
  }
}

/** Maps a raw RPC error message to a stable code, else `unknown`. */
export function toDiscussionErrorCode(
  message: string | null | undefined,
): DiscussionErrorCode {
  return DISCUSSION_ERROR_CODES.find((code) => code === message) ?? 'unknown'
}

export function discussionErrorCodeOf(error: unknown): DiscussionErrorCode {
  return error instanceof DiscussionApiError ? error.code : 'unknown'
}
