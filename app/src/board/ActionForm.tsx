import type { FormEvent, KeyboardEvent } from 'react'
import { focusRing } from '@/cards/CardForms'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import type { ProjectMember } from '@/projects/membersApi'
import {
  ACTION_DESCRIPTION_MAX_LENGTH,
  DUE_DATE_MAX,
  DUE_DATE_MIN,
  isIsoDate,
  type ActionInput,
} from './actionsApi'
import type { BoardCluster } from './boardApi'
import { wrapAnywhere } from './BoardCards'
import { codePointLength } from './discussionApi'
import { trimNote } from './TopicNotes'

export const ACTION_HINT = 'Action items show to the whole team.'
export const EMPTY_DESCRIPTION_MESSAGE = 'Write a description before saving.'
export const DESCRIPTION_TOO_LONG_MESSAGE =
  'Action items can be up to 500 characters.'
export const NO_OWNER_MESSAGE = 'Choose an owner.'
export const DUE_DATE_RANGE_MESSAGE = 'Enter a due date between 2000 and 2099.'
export const CHOOSE_OWNER = 'Choose an owner'
export const NO_RELATED_TOPIC = 'No related topic'

/** The client errors of one form, one per field. */
export interface ActionDraftErrors {
  readonly description: string | null
  readonly owner: string | null
  readonly dueDate: string | null
}

/**
 * An open form's fields. An empty `ownerId` is `Choose an owner`, an empty
 * `dueDate` is no date, and an empty `clusterId` is no related topic.
 */
export interface ActionDraft {
  readonly description: string
  readonly ownerId: string
  readonly dueDate: string
  readonly clusterId: string
  readonly errors: ActionDraftErrors | null
}

export const EMPTY_DRAFT: ActionDraft = {
  description: '',
  ownerId: '',
  dueDate: '',
  clusterId: '',
  errors: null,
}

/** The owner the select shows: the draft's, if still listed, else none. */
export function shownOwner(
  draft: ActionDraft,
  members: readonly ProjectMember[],
): string {
  return members.some((member) => member.userId === draft.ownerId)
    ? draft.ownerId
    : ''
}

/** The topic the select shows: the draft's, if still a topic, else none. */
export function shownTopic(
  draft: ActionDraft,
  topics: readonly BoardCluster[],
): string {
  return topics.some((topic) => topic.clusterId === draft.clusterId)
    ? draft.clusterId
    : ''
}

/**
 * The client check run on submit: the errors, or the input to send. Nothing
 * is sent while any field has an error.
 */
export function validateAction(
  draft: ActionDraft,
  members: readonly ProjectMember[],
  topics: readonly BoardCluster[],
): { readonly errors: ActionDraftErrors } | { readonly input: ActionInput } {
  const description = trimNote(draft.description)
  const ownerId = shownOwner(draft, members)
  const errors: ActionDraftErrors = {
    description:
      description === ''
        ? EMPTY_DESCRIPTION_MESSAGE
        : codePointLength(description) > ACTION_DESCRIPTION_MAX_LENGTH
          ? DESCRIPTION_TOO_LONG_MESSAGE
          : null,
    owner: ownerId === '' ? NO_OWNER_MESSAGE : null,
    dueDate:
      draft.dueDate !== '' &&
      (!isIsoDate(draft.dueDate) ||
        draft.dueDate < DUE_DATE_MIN ||
        draft.dueDate > DUE_DATE_MAX)
        ? DUE_DATE_RANGE_MESSAGE
        : null,
  }
  if (errors.description || errors.owner || errors.dueDate) {
    return { errors }
  }
  const clusterId = shownTopic(draft, topics)
  return {
    input: {
      description,
      ownerId,
      dueDate: draft.dueDate === '' ? null : draft.dueDate,
      clusterId: clusterId === '' ? null : clusterId,
    },
  }
}

const fieldClass = cn(
  'block w-full min-w-0 max-w-full rounded-md border border-input bg-background px-3 py-2 text-sm aria-invalid:border-destructive',
  focusRing,
)

function FieldError({ id, text }: { id: string; text: string | null }) {
  return text ? (
    <p
      id={id}
      role="alert"
      className={cn('text-sm text-destructive', wrapAnywhere)}
    >
      {text}
    </p>
  ) : null
}

export interface ActionFormProps {
  readonly idBase: string
  /** The form's accessible name. */
  readonly label: string
  readonly value: ActionDraft
  readonly members: readonly ProjectMember[]
  /** Every agenda topic, in #24's agenda order. */
  readonly topics: readonly BoardCluster[]
  /** The textarea's focus key. */
  readonly focusKey: string
  /** This form's own write is pending. */
  readonly pending: boolean
  /** Any action write is pending. */
  readonly busy: boolean
  readonly onChange: (patch: Partial<ActionDraft>) => void
  readonly onSubmit: () => void
  readonly onCancel: () => void
}

/**
 * The inline add or edit form for an action item (#26). Never a dialog.
 * Several can be open, each with its own draft. There is no `maxLength`, so
 * a paste is never cut short silently: the length is checked on submit.
 */
export function ActionForm({
  idBase,
  label,
  value,
  members,
  topics,
  focusKey,
  pending,
  busy,
  onChange,
  onSubmit,
  onCancel,
}: ActionFormProps) {
  const ids = {
    description: `${idBase}-description`,
    hint: `${idBase}-hint`,
    descriptionError: `${idBase}-description-error`,
    owner: `${idBase}-owner`,
    ownerError: `${idBase}-owner-error`,
    dueDate: `${idBase}-due`,
    dueDateError: `${idBase}-due-error`,
    topic: `${idBase}-topic`,
  }
  const errors = value.errors
  const describedBy = (base: string | null, error: string | null) =>
    [base, error].filter((id) => id !== null).join(' ') || undefined

  return (
    <form
      noValidate
      aria-label={label}
      className="min-w-0 space-y-3 rounded-md border p-3"
      onKeyDown={(event: KeyboardEvent) => {
        if (event.key === 'Escape' && !pending) {
          event.preventDefault()
          onCancel()
        }
      }}
      onSubmit={(event: FormEvent) => {
        event.preventDefault()
        onSubmit()
      }}
    >
      <div className="min-w-0 space-y-1">
        <label htmlFor={ids.description} className="block text-sm font-medium">
          Description
        </label>
        <textarea
          id={ids.description}
          rows={3}
          value={value.description}
          readOnly={pending}
          data-action-focus={focusKey}
          aria-invalid={errors?.description ? 'true' : undefined}
          aria-describedby={describedBy(
            ids.hint,
            errors?.description ? ids.descriptionError : null,
          )}
          className={cn('min-h-20 resize-y', fieldClass)}
          onChange={(event) => {
            onChange({ description: event.target.value })
          }}
        />
        <p id={ids.hint} className="text-sm text-muted-foreground">
          {ACTION_HINT}
        </p>
        <FieldError
          id={ids.descriptionError}
          text={errors?.description ?? null}
        />
      </div>
      <div className="min-w-0 space-y-1">
        <label htmlFor={ids.owner} className="block text-sm font-medium">
          Owner
        </label>
        <select
          id={ids.owner}
          value={shownOwner(value, members)}
          disabled={pending}
          aria-invalid={errors?.owner ? 'true' : undefined}
          aria-describedby={describedBy(
            null,
            errors?.owner ? ids.ownerError : null,
          )}
          className={cn('h-9 py-1', fieldClass)}
          onChange={(event) => {
            onChange({ ownerId: event.target.value })
          }}
        >
          <option value="">{CHOOSE_OWNER}</option>
          {members.map((member) => (
            <option key={member.userId} value={member.userId}>
              {member.displayName}
              {member.isMe ? ' (you)' : ''}
            </option>
          ))}
        </select>
        <FieldError id={ids.ownerError} text={errors?.owner ?? null} />
      </div>
      <div className="min-w-0 space-y-1">
        <label htmlFor={ids.dueDate} className="block text-sm font-medium">
          Due date (optional)
        </label>
        <input
          id={ids.dueDate}
          type="date"
          min={DUE_DATE_MIN}
          max={DUE_DATE_MAX}
          value={value.dueDate}
          readOnly={pending}
          aria-invalid={errors?.dueDate ? 'true' : undefined}
          aria-describedby={describedBy(
            null,
            errors?.dueDate ? ids.dueDateError : null,
          )}
          className={cn('h-9 py-1', fieldClass)}
          onChange={(event) => {
            onChange({ dueDate: event.target.value })
          }}
        />
        <FieldError id={ids.dueDateError} text={errors?.dueDate ?? null} />
      </div>
      <div className="min-w-0 space-y-1">
        <label htmlFor={ids.topic} className="block text-sm font-medium">
          Related topic
        </label>
        <select
          id={ids.topic}
          value={shownTopic(value, topics)}
          disabled={pending}
          className={cn('h-9 py-1', fieldClass)}
          onChange={(event) => {
            onChange({ clusterId: event.target.value })
          }}
        >
          <option value="">{NO_RELATED_TOPIC}</option>
          {topics.map((topic) => (
            <option key={topic.clusterId} value={topic.clusterId}>
              {topic.name}
            </option>
          ))}
        </select>
      </div>
      <div className="flex flex-wrap gap-2">
        <Button
          type="submit"
          size="sm"
          aria-disabled={busy ? 'true' : undefined}
          className="aria-disabled:opacity-50"
        >
          {pending ? 'Saving…' : 'Save action'}
        </Button>
        <Button
          type="button"
          size="sm"
          variant="outline"
          aria-disabled={pending ? 'true' : undefined}
          className="aria-disabled:opacity-50"
          onClick={() => {
            if (!pending) {
              onCancel()
            }
          }}
        >
          Cancel
        </Button>
      </div>
    </form>
  )
}
