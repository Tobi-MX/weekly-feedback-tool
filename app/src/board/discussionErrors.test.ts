import { describe, expect, it } from 'vitest'
import {
  DISCUSSION_ERROR_CODES,
  DISCUSSION_ERROR_MESSAGES,
  DiscussionApiError,
  discussionErrorCodeOf,
  discussionErrorMessage,
  toDiscussionErrorCode,
  type DiscussionErrorCode,
  type DiscussionWrite,
} from './discussionErrors'

const STATUS_UNKNOWN = 'Could not update the status.'
const SAVE_UNKNOWN = 'Could not save your note.'
const DELETE_UNKNOWN = 'Could not delete the note.'

// The issue's copy table, cell by cell. "(not raised)" cells use the
// column's unknown copy; Add and Edit share one column.
const TABLE: Record<
  DiscussionErrorCode,
  Record<DiscussionWrite, string | null>
> = {
  not_project_member: { status: null, add: null, edit: null, delete: null },
  not_project_facilitator: {
    status: 'Only the facilitator can change discussion statuses.',
    add: SAVE_UNKNOWN,
    edit: SAVE_UNKNOWN,
    delete: DELETE_UNKNOWN,
  },
  not_note_author: {
    status: STATUS_UNKNOWN,
    add: 'You can edit only your own notes.',
    edit: 'You can edit only your own notes.',
    delete: 'You can delete only your own notes.',
  },
  cycle_not_discussing: {
    status: 'Statuses can only be changed during the Discuss stage.',
    add: 'Notes can only be changed during the Discuss stage.',
    edit: 'Notes can only be changed during the Discuss stage.',
    delete: 'Notes can only be changed during the Discuss stage.',
  },
  cluster_not_found: {
    status: 'This cluster no longer exists.',
    add: 'This cluster no longer exists.',
    edit: 'This cluster no longer exists.',
    delete: DELETE_UNKNOWN,
  },
  note_not_found: {
    status: STATUS_UNKNOWN,
    add: 'This note no longer exists.',
    edit: 'This note no longer exists.',
    delete: 'This note no longer exists.',
  },
  invalid_note_text: {
    status: STATUS_UNKNOWN,
    add: 'Notes must be 1 to 2,000 characters.',
    edit: 'Notes must be 1 to 2,000 characters.',
    delete: DELETE_UNKNOWN,
  },
  note_limit_reached: {
    status: STATUS_UNKNOWN,
    add: 'This retrospective has reached its limit of 500 notes.',
    edit: 'This retrospective has reached its limit of 500 notes.',
    delete: DELETE_UNKNOWN,
  },
  invalid_discussion_status: {
    status: STATUS_UNKNOWN,
    add: SAVE_UNKNOWN,
    edit: SAVE_UNKNOWN,
    delete: DELETE_UNKNOWN,
  },
  unknown: {
    status: STATUS_UNKNOWN,
    add: SAVE_UNKNOWN,
    edit: SAVE_UNKNOWN,
    delete: DELETE_UNKNOWN,
  },
}

const WRITES: readonly DiscussionWrite[] = ['status', 'add', 'edit', 'delete']

describe('discussionErrors', () => {
  it('lists exactly the nine codes', () => {
    expect([...DISCUSSION_ERROR_CODES]).toEqual([
      'not_project_member',
      'not_project_facilitator',
      'not_note_author',
      'cycle_not_discussing',
      'cluster_not_found',
      'note_not_found',
      'invalid_note_text',
      'invalid_discussion_status',
      'note_limit_reached',
    ])
  })

  it.each(
    Object.entries(TABLE).flatMap(([code, copy]) =>
      WRITES.map((write) => [code, write, copy[write]] as const),
    ),
  )('%s / %s has the copy of the table', (code, write, copy) => {
    expect(discussionErrorMessage(code as DiscussionErrorCode, write)).toBe(
      copy,
    )
  })

  it('has a row for every code and unknown, and nothing else', () => {
    expect(Object.keys(DISCUSSION_ERROR_MESSAGES).sort()).toEqual(
      [...DISCUSSION_ERROR_CODES, 'unknown'].sort(),
    )
  })

  it.each(DISCUSSION_ERROR_CODES)('%s maps to itself', (code) => {
    expect(toDiscussionErrorCode(code)).toBe(code)
  })

  it.each([
    null,
    undefined,
    '',
    'NOT_PROJECT_MEMBER',
    ' note_not_found',
    'permission denied for table notes',
    'voting_not_closed',
    'cycle_not_voting',
  ])('maps %j to unknown', (message) => {
    expect(toDiscussionErrorCode(message)).toBe('unknown')
  })

  it('an error keeps only its code, never the server text', () => {
    const error = new DiscussionApiError(
      toDiscussionErrorCode('duplicate key value violates "notes_pkey"'),
    )
    expect(error.code).toBe('unknown')
    expect(error.message).toBe('unknown')
    expect(JSON.stringify(Object.entries(error))).not.toContain('notes_pkey')
    expect(discussionErrorCodeOf(error)).toBe('unknown')
    expect(
      discussionErrorCodeOf(new DiscussionApiError('note_not_found')),
    ).toBe('note_not_found')
    expect(discussionErrorCodeOf(new Error('note_not_found'))).toBe('unknown')
  })
})
