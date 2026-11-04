import { CLUSTER_GONE_MESSAGE } from './clusterErrors'

/**
 * The stable codes the action RPCs raise (#26). Anything else (a network
 * failure, a reply that does not match the strict schema) is `unknown`.
 * Nothing else from a Postgres error is ever kept, shown, or logged.
 */
export const ACTION_ERROR_CODES = [
  'not_project_member',
  'not_action_editor',
  'not_action_owner',
  'cycle_not_discussing',
  'cluster_not_found',
  'action_not_found',
  'invalid_action_description',
  'invalid_action_owner',
  'invalid_due_date',
  'invalid_action_status',
  'action_limit_reached',
  // #27: get_project_actions with a filter it does not accept.
  'invalid_action_filter',
] as const

export type ActionErrorCode = (typeof ACTION_ERROR_CODES)[number] | 'unknown'

/** Which action write failed; the copy depends on it. */
export type ActionWrite = 'create' | 'edit' | 'status' | 'delete'

export const NOT_EDITOR_EDIT_MESSAGE =
  'You can edit only action items you added.'
export const NOT_EDITOR_DELETE_MESSAGE =
  'You can delete only action items you added.'
export const NOT_OWNER_STATUS_MESSAGE =
  "Only the action's owner or the facilitator can change its status."
export const ACTIONS_NOT_DISCUSSING_ADD_MESSAGE =
  'Action items can only be added during the Discuss stage.'
export const ACTIONS_NOT_DISCUSSING_CHANGE_MESSAGE =
  'Action items can only be changed during the Discuss stage.'
export const ACTION_GONE_MESSAGE = 'This action item no longer exists.'
export const INVALID_DESCRIPTION_MESSAGE =
  'Action items must be 1 to 500 characters.'
export const INVALID_OWNER_MESSAGE =
  'Choose an owner who is a member of this project.'
export const INVALID_DUE_DATE_MESSAGE =
  'Enter a due date between 2000 and 2099.'
export const ACTION_LIMIT_MESSAGE =
  'This retrospective has reached its limit of 200 action items.'
export const ADD_ACTION_FAILED_MESSAGE = 'Could not add the action item.'
export const SAVE_ACTION_FAILED_MESSAGE = 'Could not save the action item.'
export const STATUS_ACTION_FAILED_MESSAGE = 'Could not update the action item.'
export const DELETE_ACTION_FAILED_MESSAGE = 'Could not delete the action item.'
/** The copy for a failed action read (#26's board and #27's project page). */
export const LOAD_ACTIONS_FAILED_MESSAGE = 'Could not load the action items.'

const unknownCopy: Record<ActionWrite, string> = {
  create: ADD_ACTION_FAILED_MESSAGE,
  edit: SAVE_ACTION_FAILED_MESSAGE,
  status: STATUS_ACTION_FAILED_MESSAGE,
  delete: DELETE_ACTION_FAILED_MESSAGE,
}

/**
 * The toast for every code and write. `null` means no toast: the board
 * switches to its not-found state instead. A code a write never raises uses
 * that write's `unknown` copy. A `Record` over every code, so a code without
 * copy fails the typecheck.
 */
export const ACTION_ERROR_MESSAGES: Record<
  ActionErrorCode,
  Record<ActionWrite, string | null>
> = {
  not_project_member: { create: null, edit: null, status: null, delete: null },
  not_action_editor: {
    ...unknownCopy,
    edit: NOT_EDITOR_EDIT_MESSAGE,
    delete: NOT_EDITOR_DELETE_MESSAGE,
  },
  not_action_owner: { ...unknownCopy, status: NOT_OWNER_STATUS_MESSAGE },
  cycle_not_discussing: {
    ...unknownCopy,
    create: ACTIONS_NOT_DISCUSSING_ADD_MESSAGE,
    edit: ACTIONS_NOT_DISCUSSING_CHANGE_MESSAGE,
    delete: ACTIONS_NOT_DISCUSSING_CHANGE_MESSAGE,
  },
  cluster_not_found: {
    ...unknownCopy,
    create: CLUSTER_GONE_MESSAGE,
    edit: CLUSTER_GONE_MESSAGE,
  },
  action_not_found: {
    ...unknownCopy,
    edit: ACTION_GONE_MESSAGE,
    status: ACTION_GONE_MESSAGE,
    delete: ACTION_GONE_MESSAGE,
  },
  invalid_action_description: {
    ...unknownCopy,
    create: INVALID_DESCRIPTION_MESSAGE,
    edit: INVALID_DESCRIPTION_MESSAGE,
  },
  invalid_action_owner: {
    ...unknownCopy,
    create: INVALID_OWNER_MESSAGE,
    edit: INVALID_OWNER_MESSAGE,
  },
  invalid_due_date: {
    ...unknownCopy,
    create: INVALID_DUE_DATE_MESSAGE,
    edit: INVALID_DUE_DATE_MESSAGE,
  },
  action_limit_reached: { ...unknownCopy, create: ACTION_LIMIT_MESSAGE },
  invalid_action_status: unknownCopy,
  // Only get_project_actions raises it (#27); no write does.
  invalid_action_filter: unknownCopy,
  unknown: unknownCopy,
}

/**
 * The copy for a failed action read. Every code, `invalid_action_filter`
 * (#27) included, gets `unknown`'s load copy; `not_project_member`
 * additionally switches the page to its not-found state.
 */
export function actionLoadErrorMessage(code: ActionErrorCode): string {
  void code
  return LOAD_ACTIONS_FAILED_MESSAGE
}

/**
 * The toast for a failed action write, or null for `not_project_member`,
 * which switches the board to its not-found state instead.
 */
export function actionErrorMessage(
  code: ActionErrorCode,
  write: ActionWrite,
): string | null {
  return ACTION_ERROR_MESSAGES[code][write]
}

/** An error that carries only a stable code, never the server's text. */
export class ActionApiError extends Error {
  readonly code: ActionErrorCode

  constructor(code: ActionErrorCode) {
    super(code)
    this.name = 'ActionApiError'
    this.code = code
  }
}

/** Maps a raw RPC error message to a stable code, else `unknown`. */
export function toActionErrorCode(
  message: string | null | undefined,
): ActionErrorCode {
  return ACTION_ERROR_CODES.find((code) => code === message) ?? 'unknown'
}

export function actionErrorCodeOf(error: unknown): ActionErrorCode {
  return error instanceof ActionApiError ? error.code : 'unknown'
}
