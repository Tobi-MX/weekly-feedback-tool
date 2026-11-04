import { describe, expect, it } from 'vitest'
import {
  ACTION_ERROR_CODES,
  ACTION_ERROR_MESSAGES,
  ActionApiError,
  actionErrorCodeOf,
  actionErrorMessage,
  toActionErrorCode,
  type ActionErrorCode,
  type ActionWrite,
} from './actionErrors'

const CREATE_UNKNOWN = 'Could not add the action item.'
const EDIT_UNKNOWN = 'Could not save the action item.'
const STATUS_UNKNOWN = 'Could not update the action item.'
const DELETE_UNKNOWN = 'Could not delete the action item.'

// The issue's copy table, cell by cell. "(not raised)" cells use the
// column's unknown copy.
const TABLE: Record<ActionErrorCode, Record<ActionWrite, string | null>> = {
  not_project_member: { create: null, edit: null, status: null, delete: null },
  not_action_editor: {
    create: CREATE_UNKNOWN,
    edit: 'You can edit only action items you added.',
    status: STATUS_UNKNOWN,
    delete: 'You can delete only action items you added.',
  },
  not_action_owner: {
    create: CREATE_UNKNOWN,
    edit: EDIT_UNKNOWN,
    status: "Only the action's owner or the facilitator can change its status.",
    delete: DELETE_UNKNOWN,
  },
  cycle_not_discussing: {
    create: 'Action items can only be added during the Discuss stage.',
    edit: 'Action items can only be changed during the Discuss stage.',
    status: STATUS_UNKNOWN,
    delete: 'Action items can only be changed during the Discuss stage.',
  },
  cluster_not_found: {
    create: 'This cluster no longer exists.',
    edit: 'This cluster no longer exists.',
    status: STATUS_UNKNOWN,
    delete: DELETE_UNKNOWN,
  },
  action_not_found: {
    create: CREATE_UNKNOWN,
    edit: 'This action item no longer exists.',
    status: 'This action item no longer exists.',
    delete: 'This action item no longer exists.',
  },
  invalid_action_description: {
    create: 'Action items must be 1 to 500 characters.',
    edit: 'Action items must be 1 to 500 characters.',
    status: STATUS_UNKNOWN,
    delete: DELETE_UNKNOWN,
  },
  invalid_action_owner: {
    create: 'Choose an owner who is a member of this project.',
    edit: 'Choose an owner who is a member of this project.',
    status: STATUS_UNKNOWN,
    delete: DELETE_UNKNOWN,
  },
  invalid_due_date: {
    create: 'Enter a due date between 2000 and 2099.',
    edit: 'Enter a due date between 2000 and 2099.',
    status: STATUS_UNKNOWN,
    delete: DELETE_UNKNOWN,
  },
  action_limit_reached: {
    create: 'This retrospective has reached its limit of 200 action items.',
    edit: EDIT_UNKNOWN,
    status: STATUS_UNKNOWN,
    delete: DELETE_UNKNOWN,
  },
  invalid_action_status: {
    create: CREATE_UNKNOWN,
    edit: EDIT_UNKNOWN,
    status: STATUS_UNKNOWN,
    delete: DELETE_UNKNOWN,
  },
  unknown: {
    create: CREATE_UNKNOWN,
    edit: EDIT_UNKNOWN,
    status: STATUS_UNKNOWN,
    delete: DELETE_UNKNOWN,
  },
}

const WRITES: readonly ActionWrite[] = ['create', 'edit', 'status', 'delete']

describe('actionErrors', () => {
  it('lists exactly the eleven codes', () => {
    expect([...ACTION_ERROR_CODES]).toEqual([
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
    ])
  })

  it.each(
    Object.entries(TABLE).flatMap(([code, copy]) =>
      WRITES.map((write) => [code, write, copy[write]] as const),
    ),
  )('%s / %s has the copy of the table', (code, write, copy) => {
    expect(actionErrorMessage(code as ActionErrorCode, write)).toBe(copy)
  })

  it('has a row for every code and unknown, and nothing else', () => {
    expect(Object.keys(ACTION_ERROR_MESSAGES).sort()).toEqual(
      [...ACTION_ERROR_CODES, 'unknown'].sort(),
    )
  })

  it.each(ACTION_ERROR_CODES)('%s maps to itself', (code) => {
    expect(toActionErrorCode(code)).toBe(code)
  })

  it.each([
    null,
    undefined,
    '',
    'NOT_PROJECT_MEMBER',
    ' action_not_found',
    'permission denied for table actions',
    'invalid input syntax for type date: "2026-13-40"',
    'note_not_found',
    'not_project_facilitator',
  ])('maps %j to unknown', (message) => {
    expect(toActionErrorCode(message)).toBe('unknown')
  })

  it('an error keeps only its code, never the server text', () => {
    const error = new ActionApiError(
      toActionErrorCode('duplicate key value violates "actions_pkey"'),
    )
    expect(error.code).toBe('unknown')
    expect(error.message).toBe('unknown')
    expect(JSON.stringify(Object.entries(error))).not.toContain('actions_pkey')
    expect(actionErrorCodeOf(error)).toBe('unknown')
    expect(actionErrorCodeOf(new ActionApiError('action_not_found'))).toBe(
      'action_not_found',
    )
    expect(actionErrorCodeOf(new Error('action_not_found'))).toBe('unknown')
  })
})
