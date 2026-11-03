import type { FormEvent, KeyboardEvent } from 'react'
import { focusRing } from '@/cards/CardForms'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import { wrapAnywhere } from './BoardCards'
import {
  codePointLength,
  NOTE_MAX_LENGTH,
  type DiscussionNote,
} from './discussionApi'

export const NOTES_HINT = 'Notes show your name to the whole team.'
export const NO_NOTES = 'No notes yet.'
export const NO_GENERAL_NOTES = 'No general notes yet.'
export const DELETED_ACCOUNT = 'Deleted account'
export const DELETE_NOTE_QUESTION = 'Delete this note? This cannot be undone.'
export const EMPTY_NOTE_MESSAGE = 'Write something before saving.'
export const NOTE_TOO_LONG_MESSAGE = 'Notes can be up to 2,000 characters.'
export const NOTE_DELETED_ELSEWHERE_MESSAGE = 'This note was deleted.'
export const GENERAL_NOTE_ADDED = 'General note added.'
export const NOTE_UPDATED = 'Note updated.'
export const NOTE_DELETED = 'Note deleted.'

/** The key of the general notes block; topic keys are cluster ids. */
export const GENERAL_KEY = 'general'

/** Trims with the card trim set, as the server does. */
export function trimNote(text: string): string {
  return text.replace(/^[ \t\n\r]+|[ \t\n\r]+$/g, '')
}

/** The client check run on submit; null when the text can be sent. */
export function validateNote(text: string): string | null {
  const trimmed = trimNote(text)
  if (trimmed === '') {
    return EMPTY_NOTE_MESSAGE
  }
  if (codePointLength(trimmed) > NOTE_MAX_LENGTH) {
    return NOTE_TOO_LONG_MESSAGE
  }
  return null
}

/** The first 40 characters of a note, plus `…` when it is longer. */
export function noteExcerpt(text: string): string {
  const points = Array.from(text)
  return points.length > 40 ? `${points.slice(0, 40).join('')}…` : text
}

/** The note's byline: name, ` (you)`, and ` (edited)`. No clock time. */
export function noteByline(note: DiscussionNote): string {
  return `${note.authorName ?? DELETED_ACCOUNT}${note.isMine ? ' (you)' : ''}${
    note.editedAt !== null ? ' (edited)' : ''
  }`
}

/** Focus targets inside the notes blocks. */
export function focusAttr(
  kind:
    'add' | 'add-input' | 'edit' | 'edit-input' | 'delete' | 'delete-cancel',
  key: string,
): string {
  return `${kind}:${key}`
}

/** An open form's text and its client error. */
export interface NoteDraft {
  readonly draft: string
  readonly error: string | null
}

/** The note write in flight, and the form or confirmation that sent it. */
export interface PendingNoteWrite {
  readonly kind: 'add' | 'edit' | 'delete'
  /** The topic key for an add, the note id otherwise. */
  readonly key: string
}

/** What a notes block needs from discuss mode. */
export interface NotesController {
  readonly isFacilitator: boolean
  readonly addForms: Readonly<Record<string, NoteDraft>>
  readonly editForms: Readonly<Record<string, NoteDraft>>
  readonly deleteConfirms: ReadonlySet<string>
  /** A note write is pending somewhere on the board. */
  readonly noteBusy: boolean
  readonly pending: PendingNoteWrite | null
  readonly openAdd: (topicKey: string) => void
  readonly changeAdd: (topicKey: string, draft: string) => void
  readonly submitAdd: (topicKey: string) => void
  readonly cancelAdd: (topicKey: string) => void
  readonly openEdit: (note: DiscussionNote) => void
  readonly changeEdit: (noteId: string, draft: string) => void
  readonly submitEdit: (note: DiscussionNote, topicKey: string) => void
  readonly cancelEdit: (noteId: string) => void
  readonly openDelete: (noteId: string) => void
  readonly cancelDelete: (noteId: string) => void
  readonly confirmDelete: (note: DiscussionNote, topicKey: string) => void
}

const textareaClass = cn(
  'block min-h-20 w-full min-w-0 resize-y rounded-md border border-input bg-background px-3 py-2 text-sm aria-invalid:border-destructive',
  focusRing,
)

interface NoteFormProps {
  readonly idBase: string
  readonly label: string
  readonly value: NoteDraft
  readonly focusKey: string
  /** This form's own write is pending. */
  readonly pending: boolean
  /** Any note write is pending. */
  readonly busy: boolean
  readonly onChange: (draft: string) => void
  readonly onSubmit: () => void
  readonly onCancel: () => void
}

/** An inline add or edit form. Several can be open, each with its draft. */
function NoteForm({
  idBase,
  label,
  value,
  focusKey,
  pending,
  busy,
  onChange,
  onSubmit,
  onCancel,
}: NoteFormProps) {
  const inputId = `${idBase}-input`
  const hintId = `${idBase}-hint`
  const errorId = `${idBase}-error`
  return (
    <form
      noValidate
      className="min-w-0 space-y-2"
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
      <label
        htmlFor={inputId}
        className={cn('block text-sm font-medium', wrapAnywhere)}
      >
        {label}
      </label>
      <textarea
        id={inputId}
        rows={3}
        value={value.draft}
        readOnly={pending}
        data-discussion-focus={focusKey}
        aria-invalid={value.error ? 'true' : undefined}
        aria-describedby={value.error ? `${hintId} ${errorId}` : hintId}
        className={textareaClass}
        onChange={(event) => {
          onChange(event.target.value)
        }}
      />
      <p id={hintId} className="text-sm text-muted-foreground">
        {NOTES_HINT}
      </p>
      {value.error ? (
        <p
          id={errorId}
          role="alert"
          className={cn('text-sm text-destructive', wrapAnywhere)}
        >
          {value.error}
        </p>
      ) : null}
      <div className="flex flex-wrap gap-2">
        <Button
          type="submit"
          size="sm"
          aria-disabled={busy ? 'true' : undefined}
          className="aria-disabled:opacity-50"
        >
          {pending ? 'Saving…' : 'Save note'}
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

interface NoteItemProps {
  readonly note: DiscussionNote
  readonly topicKey: string
  readonly controller: NotesController
}

function NoteItem({ note, topicKey, controller }: NoteItemProps) {
  const { noteId } = note
  const edit = controller.editForms[noteId]
  const confirming = controller.deleteConfirms.has(noteId)
  const excerpt = noteExcerpt(note.text)
  const canDelete = note.isMine || controller.isFacilitator
  // A Delete shown only because the caller is the facilitator disappears
  // with the role.
  const moderation = !note.isMine
  const pending = controller.pending
  const deletePending = pending?.kind === 'delete' && pending.key === noteId
  const questionId = `note-${noteId}-delete-question`

  return (
    <li
      data-note-id={noteId}
      className="min-w-0 space-y-2 rounded-md border p-3"
    >
      {edit !== undefined ? (
        <NoteForm
          idBase={`note-${noteId}-edit`}
          label="Edit note"
          value={edit}
          focusKey={focusAttr('edit-input', noteId)}
          pending={pending?.kind === 'edit' && pending.key === noteId}
          busy={controller.noteBusy}
          onChange={(draft) => {
            controller.changeEdit(noteId, draft)
          }}
          onSubmit={() => {
            controller.submitEdit(note, topicKey)
          }}
          onCancel={() => {
            controller.cancelEdit(noteId)
          }}
        />
      ) : (
        <>
          <p className={cn('text-sm whitespace-pre-wrap', wrapAnywhere)}>
            {note.text}
          </p>
          <p className={cn('text-xs text-muted-foreground', wrapAnywhere)}>
            {noteByline(note)}
          </p>
          {/* Always present, so every viewer's DOM has the same shape. */}
          <div className="flex flex-wrap gap-2 empty:hidden">
            {note.isMine ? (
              <Button
                type="button"
                size="sm"
                variant="outline"
                aria-label={`Edit note: ${excerpt}`}
                data-discussion-focus={focusAttr('edit', noteId)}
                onClick={() => {
                  controller.openEdit(note)
                }}
              >
                Edit
              </Button>
            ) : null}
            {canDelete ? (
              <Button
                type="button"
                size="sm"
                variant="outline"
                aria-label={`Delete note: ${excerpt}`}
                data-discussion-focus={focusAttr('delete', noteId)}
                data-facilitator-control={moderation ? '' : undefined}
                onClick={() => {
                  controller.openDelete(noteId)
                }}
              >
                Delete
              </Button>
            ) : null}
          </div>
          {confirming && canDelete ? (
            <div
              role="group"
              aria-labelledby={questionId}
              data-facilitator-control={moderation ? '' : undefined}
              className="space-y-3 rounded-md border border-destructive/30 p-3"
              onKeyDown={(event: KeyboardEvent) => {
                if (event.key === 'Escape' && !deletePending) {
                  event.preventDefault()
                  controller.cancelDelete(noteId)
                }
              }}
            >
              <p id={questionId} className="text-sm">
                {DELETE_NOTE_QUESTION}
              </p>
              <div className="flex flex-wrap gap-2">
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  data-discussion-focus={focusAttr('delete-cancel', noteId)}
                  aria-disabled={deletePending ? 'true' : undefined}
                  className="aria-disabled:opacity-50"
                  onClick={() => {
                    if (!deletePending) {
                      controller.cancelDelete(noteId)
                    }
                  }}
                >
                  Cancel
                </Button>
                <Button
                  type="button"
                  size="sm"
                  variant="destructive"
                  aria-disabled={controller.noteBusy ? 'true' : undefined}
                  className="aria-disabled:opacity-50"
                  onClick={() => {
                    controller.confirmDelete(note, topicKey)
                  }}
                >
                  {deletePending ? 'Deleting…' : 'Delete'}
                </Button>
              </div>
            </div>
          ) : null}
        </>
      )}
    </li>
  )
}

export interface TopicNotesProps {
  /** The cluster id, or `GENERAL_KEY`. */
  readonly topicKey: string
  /** The cluster name; null for the general notes. */
  readonly topicName: string | null
  readonly notes: readonly DiscussionNote[]
  readonly controller: NotesController
}

/**
 * A topic's notes block (#25): `Notes (N)`, the notes in server order or the
 * empty line, and Add note or its inline form. The general notes use the
 * same block under their own h3. Never inside a card.
 */
export function TopicNotes({
  topicKey,
  topicName,
  notes,
  controller,
}: TopicNotesProps) {
  const general = topicName === null
  const add = controller.addForms[topicKey]
  const pending = controller.pending
  const listLabel = general ? 'General notes' : `Notes on ${topicName}`
  return (
    <div className="min-w-0 space-y-3">
      {general ? null : (
        <h4 className="text-sm font-semibold">Notes ({notes.length})</h4>
      )}
      {notes.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          {general ? NO_GENERAL_NOTES : NO_NOTES}
        </p>
      ) : (
        <ul aria-label={listLabel} className="min-w-0 space-y-2">
          {notes.map((note) => (
            <NoteItem
              key={note.noteId}
              note={note}
              topicKey={topicKey}
              controller={controller}
            />
          ))}
        </ul>
      )}
      {add !== undefined ? (
        <NoteForm
          idBase={`notes-${topicKey}-add`}
          label={general ? 'General note' : `Note on ${topicName}`}
          value={add}
          focusKey={focusAttr('add-input', topicKey)}
          pending={pending?.kind === 'add' && pending.key === topicKey}
          busy={controller.noteBusy}
          onChange={(draft) => {
            controller.changeAdd(topicKey, draft)
          }}
          onSubmit={() => {
            controller.submitAdd(topicKey)
          }}
          onCancel={() => {
            controller.cancelAdd(topicKey)
          }}
        />
      ) : (
        <Button
          type="button"
          size="sm"
          variant="outline"
          aria-label={
            general ? 'Add a general note' : `Add note to ${topicName}`
          }
          data-discussion-focus={focusAttr('add', topicKey)}
          onClick={() => {
            controller.openAdd(topicKey)
          }}
        >
          Add note
        </Button>
      )}
    </div>
  )
}
