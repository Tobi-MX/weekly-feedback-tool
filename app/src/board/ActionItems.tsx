import { useEffect, useRef, useState, type KeyboardEvent } from 'react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import type { ProjectMember } from '@/projects/membersApi'
import {
  actionErrorCodeOf,
  actionErrorMessage,
  type ActionWrite,
} from './actionErrors'
import {
  ActionForm,
  EMPTY_DRAFT,
  NO_RELATED_TOPIC,
  validateAction,
  type ActionDraft,
} from './ActionForm'
import {
  actionsWithTopics,
  formatDueDate,
  isOverdue,
  localDateIso,
  type ActionWithTopic,
} from './actionModel'
import type { ActionInput, ActionStatus, CycleAction } from './actionsApi'
import type { BoardCluster, CycleBoard } from './boardApi'
import { wrapAnywhere } from './BoardCards'
import { DELETED_ACCOUNT, noteExcerpt } from './TopicNotes'
import { useActionWrite, useCycleActionsQuery } from './useActions'

export const ACTIONS_LOADING = 'Loading action items…'
export const ACTIONS_LOAD_ERROR = 'Could not load the action items.'
export const NO_ACTIONS = 'No action items yet.'
export const DELETE_ACTION_QUESTION =
  'Delete this action item? This cannot be undone.'
export const ACTION_DELETED_ELSEWHERE_MESSAGE = 'This action item was deleted.'
export const ACTION_ADDED = 'Action item added.'
export const ACTION_UPDATED = 'Action item updated.'
export const ACTION_MARKED_DONE = 'Action item marked done.'
export const ACTION_REOPENED = 'Action item reopened.'
export const ACTION_DELETED = 'Action item deleted.'

export const ACTIONS_HEADING_ID = 'discuss-actions-heading'
const ADD_KEY = 'add'

type FocusTarget =
  | 'add'
  | 'add-input'
  | 'edit'
  | 'edit-input'
  | 'toggle'
  | 'delete'
  | 'delete-cancel'

function focusKey(kind: FocusTarget, key: string = ADD_KEY): string {
  return `${kind}:${key}`
}

/** The action write in flight, and the control that sent it. */
interface PendingAction {
  readonly kind: ActionWrite
  /** `add` for a create, the action id otherwise. */
  readonly key: string
}

function without<T>(
  record: Readonly<Record<string, T>>,
  key: string,
): Record<string, T> {
  const next = { ...record }
  delete next[key]
  return next
}

function withoutId(set: ReadonlySet<string>, id: string): ReadonlySet<string> {
  return new Set([...set].filter((item) => item !== id))
}

/** A draft pre-filled from a stored action. */
function draftOf(action: CycleAction): ActionDraft {
  return {
    description: action.description,
    ownerId: action.ownerId ?? '',
    dueDate: action.dueDate ?? '',
    clusterId: action.clusterId ?? '',
    errors: null,
  }
}

function ownerLine(action: CycleAction): string {
  return `Owner: ${action.ownerName ?? DELETED_ACCOUNT}${
    action.ownerIsMe ? ' (you)' : ''
  }`
}

function dueLine(action: CycleAction, todayIso: string): string {
  if (action.dueDate === null) {
    return 'No due date'
  }
  const due = `Due ${formatDueDate(action.dueDate)}`
  return isOverdue(action, todayIso) ? `${due} · Overdue` : due
}

export interface ActionItemsProps {
  readonly board: CycleBoard
  /** Every agenda topic, in #24's agenda order. */
  readonly topics: readonly BoardCluster[]
  /**
   * The project's current members, or undefined while the members query is
   * loading or has failed.
   */
  readonly members: readonly ProjectMember[] | undefined
  /** From the caller's own member row; false while the members load. */
  readonly isFacilitator: boolean
  /** The board's poll interval: a number only while Realtime is down. */
  readonly refetchInterval: number | false
  /** Says a message in #25's keyed sr-only status region. */
  readonly announce: (text: string) => void
  readonly onLostAccess: () => void
  readonly onNotFacilitator: () => void
  readonly onRefetchMembers: () => void
}

/**
 * The Action items section of discuss mode (#26). Any member adds an action
 * item; its creator or the facilitator edits and deletes it; its owner or
 * the facilitator marks it done or reopens it. The server decides every
 * rule; hiding a control is only a convenience. Writes are not optimistic:
 * a change shows once the refetch it starts is in. Never inside a card.
 */
export function ActionItems({
  board,
  topics,
  members,
  isFacilitator,
  refetchInterval,
  announce,
  onLostAccess,
  onNotFacilitator,
  onRefetchMembers,
}: ActionItemsProps) {
  const { cycleId } = board
  const query = useCycleActionsQuery(
    cycleId,
    board.status === 'discuss',
    refetchInterval,
  )
  const lostAccess = actionErrorCodeOf(query.error) === 'not_project_member'
  useEffect(() => {
    if (lostAccess) {
      onLostAccess()
    }
  }, [lostAccess, onLostAccess])

  // The toast for a failed write. It lives on the mutation, so a write that
  // fails after discuss mode unmounted still shows it, and nothing else.
  const onFailure = (error: unknown, write: ActionWrite) => {
    const code = actionErrorCodeOf(error)
    const message = actionErrorMessage(code, write)
    if (message === null) {
      onLostAccess()
      return
    }
    toast.error(message)
    if (
      (code === 'not_action_editor' &&
        (write === 'edit' || write === 'delete')) ||
      (code === 'not_action_owner' && write === 'status')
    ) {
      onNotFacilitator()
    } else if (code === 'invalid_action_owner') {
      onRefetchMembers()
    }
  }
  const mutation = useActionWrite(cycleId, onFailure)

  const mountedRef = useRef(false)
  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
    }
  }, [])
  // A double click or a held Enter must not send a second write before
  // React re-renders.
  const writingRef = useRef(false)
  const [pending, setPending] = useState<PendingAction | null>(null)
  const [addForm, setAddForm] = useState<ActionDraft | null>(null)
  const [editForms, setEditForms] = useState<Record<string, ActionDraft>>({})
  const [deleteConfirms, setDeleteConfirms] = useState<ReadonlySet<string>>(
    () => new Set(),
  )
  const [focusRequest, setFocusRequest] = useState<{
    readonly targets: readonly string[]
  } | null>(null)
  const [headingFocus, setHeadingFocus] = useState<object | null>(null)
  const [notice, setNotice] = useState<{ readonly id: number } | null>(null)
  const sectionRef = useRef<HTMLElement>(null)

  const requestFocus = (...targets: string[]) => {
    setFocusRequest({ targets })
  }

  const items: readonly ActionWithTopic[] | null | undefined =
    query.data === undefined
      ? undefined
      : actionsWithTopics(board, query.data.actions)
  const membersReady = members !== undefined
  const ownerOptions = members ?? []

  // The role the controls were last drawn for. Losing it hides Edit, Delete
  // and the toggle on others' actions (and their forms and confirmations);
  // focus moves to the section heading only if it was on one of them.
  const [shownRole, setShownRole] = useState(isFacilitator)
  if (shownRole !== isFacilitator) {
    setShownRole(isFacilitator)
    if (!isFacilitator) {
      const active = document.activeElement
      if (active?.closest('[data-action-facilitator-control]')) {
        setHeadingFocus({})
      }
      if (items) {
        const mine = new Set(
          items
            .filter(({ action }) => action.createdByMe)
            .map(({ action }) => action.actionId),
        )
        const keptEdits = Object.fromEntries(
          Object.entries(editForms).filter(([id]) => mine.has(id)),
        )
        if (Object.keys(keptEdits).length !== Object.keys(editForms).length) {
          setEditForms(keptEdits)
        }
        const keptConfirms = new Set(
          [...deleteConfirms].filter((id) => mine.has(id)),
        )
        if (keptConfirms.size !== deleteConfirms.size) {
          setDeleteConfirms(keptConfirms)
        }
      }
    }
  }

  // A refetch that removes an action (deleted elsewhere, or by this tab):
  // close its edit form and confirmation. Focus moves to Add action item
  // only if it was on that action. An action whose own write is pending is
  // left to that write's result.
  const [shownIds, setShownIds] = useState<ReadonlySet<string> | null>(null)
  if (items) {
    const current = new Set(items.map(({ action }) => action.actionId))
    const changed =
      shownIds === null ||
      shownIds.size !== current.size ||
      [...shownIds].some((id) => !current.has(id))
    if (changed) {
      setShownIds(current)
      if (shownIds !== null) {
        let nextEdits = editForms
        let nextConfirms = deleteConfirms
        let draftLost = false
        let focusLost = false
        const active = document.activeElement
        for (const id of shownIds) {
          if (current.has(id)) {
            continue
          }
          const ownWrite = pending !== null && pending.key === id
          if (id in nextEdits) {
            nextEdits = without(nextEdits, id)
            if (!ownWrite) {
              draftLost = true
            }
          }
          if (nextConfirms.has(id)) {
            nextConfirms = withoutId(nextConfirms, id)
          }
          if (active?.closest(`[data-action-id="${id}"]`)) {
            focusLost = true
          }
        }
        if (nextEdits !== editForms) {
          setEditForms(nextEdits)
        }
        if (nextConfirms !== deleteConfirms) {
          setDeleteConfirms(nextConfirms)
        }
        if (draftLost) {
          setNotice((current) => ({ id: (current?.id ?? 0) + 1 }))
        }
        if (focusLost) {
          setFocusRequest({
            targets: [focusKey('add'), focusKey('add-input')],
          })
        }
      }
    }
  }

  useEffect(() => {
    if (notice !== null) {
      toast.error(ACTION_DELETED_ELSEWHERE_MESSAGE)
    }
  }, [notice])

  useEffect(() => {
    if (headingFocus === null) {
      return
    }
    const active = document.activeElement
    if (active === null || active === document.body || !active.isConnected) {
      document.getElementById(ACTIONS_HEADING_ID)?.focus()
    }
  }, [headingFocus])

  useEffect(() => {
    if (focusRequest === null) {
      return
    }
    for (const target of focusRequest.targets) {
      const element = sectionRef.current?.querySelector<HTMLElement>(
        `[data-action-focus="${target}"]`,
      )
      if (element) {
        element.focus()
        return
      }
    }
  }, [focusRequest])

  const busy = mutation.isPending || pending !== null

  const send = (
    next: PendingAction,
    run: () => Promise<void>,
    onSuccess: () => void,
    onError: (error: unknown) => void,
  ) => {
    writingRef.current = true
    setPending(next)
    run()
      .then(
        () => {
          if (mountedRef.current) {
            onSuccess()
          }
        },
        (error: unknown) => {
          if (mountedRef.current) {
            onError(error)
          }
        },
      )
      .finally(() => {
        writingRef.current = false
        if (mountedRef.current) {
          setPending(null)
        }
      })
  }

  const submitAdd = () => {
    if (addForm === null || writingRef.current || busy) {
      return
    }
    const checked = validateAction(addForm, ownerOptions, topics)
    if ('errors' in checked) {
      setAddForm({ ...addForm, errors: checked.errors })
      return
    }
    const input: ActionInput = checked.input
    setAddForm({ ...addForm, errors: null })
    send(
      { kind: 'create', key: ADD_KEY },
      () => mutation.mutateAsync({ kind: 'create', input }),
      () => {
        setAddForm(null)
        announce(ACTION_ADDED)
        requestFocus(focusKey('add'))
      },
      () => {
        // The form stays open with its input.
      },
    )
  }

  const submitEdit = (action: CycleAction) => {
    const { actionId } = action
    const form = editForms[actionId]
    if (form === undefined || writingRef.current || busy) {
      return
    }
    const checked = validateAction(form, ownerOptions, topics)
    if ('errors' in checked) {
      setEditForms((forms) => ({
        ...forms,
        [actionId]: { ...form, errors: checked.errors },
      }))
      return
    }
    const input = checked.input
    setEditForms((forms) =>
      actionId in forms
        ? { ...forms, [actionId]: { ...forms[actionId], errors: null } }
        : forms,
    )
    send(
      { kind: 'edit', key: actionId },
      () => mutation.mutateAsync({ kind: 'edit', actionId, input }),
      () => {
        setEditForms((forms) => without(forms, actionId))
        announce(ACTION_UPDATED)
        requestFocus(focusKey('edit', actionId), focusKey('add'))
      },
      (failure) => {
        // The action is gone: the edit form closes. Otherwise it stays open
        // with its input.
        if (actionErrorCodeOf(failure) === 'action_not_found') {
          setEditForms((forms) => without(forms, actionId))
          requestFocus(focusKey('edit', actionId), focusKey('add'))
        }
      },
    )
  }

  const toggle = (action: CycleAction) => {
    if (writingRef.current || busy) {
      return
    }
    const { actionId } = action
    const status: ActionStatus = action.status === 'open' ? 'done' : 'open'
    send(
      { kind: 'status', key: actionId },
      () => mutation.mutateAsync({ kind: 'status', actionId, status }),
      () => {
        announce(status === 'done' ? ACTION_MARKED_DONE : ACTION_REOPENED)
        requestFocus(focusKey('toggle', actionId), focusKey('add'))
      },
      () => {
        // The toast was shown by onFailure, and the actions re-read.
      },
    )
  }

  const confirmDelete = (action: CycleAction) => {
    if (writingRef.current || busy) {
      return
    }
    const { actionId } = action
    send(
      { kind: 'delete', key: actionId },
      () => mutation.mutateAsync({ kind: 'delete', actionId }),
      () => {
        setDeleteConfirms((ids) => withoutId(ids, actionId))
        announce(ACTION_DELETED)
        requestFocus(focusKey('add'))
      },
      (failure) => {
        if (actionErrorCodeOf(failure) === 'action_not_found') {
          setDeleteConfirms((ids) => withoutId(ids, actionId))
          requestFocus(focusKey('add'))
        }
      },
    )
  }

  const todayIso = localDateIso(new Date())
  const count = items ? items.length : null

  let body: React.ReactNode
  if (items === null || (items === undefined && query.isError)) {
    body = (
      <div
        role="alert"
        className="space-y-3 rounded-md border border-destructive/30 p-3"
      >
        <p className="text-sm">{ACTIONS_LOAD_ERROR}</p>
        <Button
          type="button"
          variant="outline"
          onClick={() => {
            void query.refetch()
          }}
        >
          Retry
        </Button>
      </div>
    )
  } else if (items === undefined) {
    body = (
      <p role="status" className="text-sm text-muted-foreground">
        {ACTIONS_LOADING}
      </p>
    )
  } else {
    body = (
      <>
        {items.length === 0 ? (
          <p className="text-sm text-muted-foreground">{NO_ACTIONS}</p>
        ) : (
          <ul aria-label="Action items" className="min-w-0 space-y-2">
            {items.map(({ action, topic }) => {
              const { actionId } = action
              const excerpt = noteExcerpt(action.description)
              const edit = editForms[actionId]
              const canToggle = action.ownerIsMe || isFacilitator
              const canEdit =
                membersReady && (action.createdByMe || isFacilitator)
              const confirming = deleteConfirms.has(actionId) && canEdit
              const togglePending =
                pending?.kind === 'status' && pending.key === actionId
              const deletePending =
                pending?.kind === 'delete' && pending.key === actionId
              const questionId = `action-${actionId}-delete-question`
              return (
                <li
                  key={actionId}
                  data-action-id={actionId}
                  className="min-w-0 space-y-2 rounded-md border p-3"
                >
                  {edit !== undefined ? (
                    <div
                      data-action-facilitator-control={
                        action.createdByMe ? undefined : ''
                      }
                    >
                      <ActionForm
                        idBase={`action-${actionId}-edit`}
                        label={`Editing action: ${excerpt}`}
                        value={edit}
                        members={ownerOptions}
                        topics={topics}
                        focusKey={focusKey('edit-input', actionId)}
                        pending={
                          pending?.kind === 'edit' && pending.key === actionId
                        }
                        busy={busy}
                        onChange={(patch) => {
                          setEditForms((forms) =>
                            actionId in forms
                              ? {
                                  ...forms,
                                  [actionId]: { ...forms[actionId], ...patch },
                                }
                              : forms,
                          )
                        }}
                        onSubmit={() => {
                          submitEdit(action)
                        }}
                        onCancel={() => {
                          setEditForms((forms) => without(forms, actionId))
                          requestFocus(focusKey('edit', actionId))
                        }}
                      />
                    </div>
                  ) : (
                    <>
                      <p
                        className={cn(
                          'text-sm whitespace-pre-wrap',
                          wrapAnywhere,
                        )}
                      >
                        {action.description}
                      </p>
                      <div
                        className={cn(
                          'space-y-0.5 text-xs text-muted-foreground',
                          wrapAnywhere,
                        )}
                      >
                        <p>{ownerLine(action)}</p>
                        <p>{dueLine(action, todayIso)}</p>
                        <p>
                          {topic === null
                            ? NO_RELATED_TOPIC
                            : `Topic: ${topic.name}`}
                        </p>
                        <p>
                          Status: {action.status === 'done' ? 'Done' : 'Open'}
                        </p>
                      </div>
                      <div className="flex flex-wrap gap-2 empty:hidden">
                        {canToggle ? (
                          <Button
                            type="button"
                            size="sm"
                            variant="outline"
                            aria-label={`${
                              action.status === 'open' ? 'Mark done' : 'Reopen'
                            }: ${excerpt}`}
                            aria-disabled={busy ? 'true' : undefined}
                            data-action-focus={focusKey('toggle', actionId)}
                            data-action-facilitator-control={
                              action.ownerIsMe ? undefined : ''
                            }
                            className="aria-disabled:opacity-50"
                            onClick={() => {
                              toggle(action)
                            }}
                          >
                            {togglePending
                              ? 'Updating…'
                              : action.status === 'open'
                                ? 'Mark done'
                                : 'Reopen'}
                          </Button>
                        ) : null}
                        {canEdit ? (
                          <>
                            <Button
                              type="button"
                              size="sm"
                              variant="outline"
                              aria-label={`Edit action: ${excerpt}`}
                              data-action-focus={focusKey('edit', actionId)}
                              data-action-facilitator-control={
                                action.createdByMe ? undefined : ''
                              }
                              onClick={() => {
                                setEditForms((forms) =>
                                  actionId in forms
                                    ? forms
                                    : { ...forms, [actionId]: draftOf(action) },
                                )
                                requestFocus(focusKey('edit-input', actionId))
                              }}
                            >
                              Edit
                            </Button>
                            <Button
                              type="button"
                              size="sm"
                              variant="outline"
                              aria-label={`Delete action: ${excerpt}`}
                              data-action-focus={focusKey('delete', actionId)}
                              data-action-facilitator-control={
                                action.createdByMe ? undefined : ''
                              }
                              onClick={() => {
                                setDeleteConfirms(
                                  (ids) => new Set([...ids, actionId]),
                                )
                                requestFocus(
                                  focusKey('delete-cancel', actionId),
                                )
                              }}
                            >
                              Delete
                            </Button>
                          </>
                        ) : null}
                      </div>
                      {confirming ? (
                        <div
                          role="group"
                          aria-labelledby={questionId}
                          data-action-facilitator-control={
                            action.createdByMe ? undefined : ''
                          }
                          className="space-y-3 rounded-md border border-destructive/30 p-3"
                          onKeyDown={(event: KeyboardEvent) => {
                            if (event.key === 'Escape' && !deletePending) {
                              event.preventDefault()
                              setDeleteConfirms((ids) =>
                                withoutId(ids, actionId),
                              )
                              requestFocus(focusKey('delete', actionId))
                            }
                          }}
                        >
                          <p id={questionId} className="text-sm">
                            {DELETE_ACTION_QUESTION}
                          </p>
                          <div className="flex flex-wrap gap-2">
                            <Button
                              type="button"
                              size="sm"
                              variant="outline"
                              data-action-focus={focusKey(
                                'delete-cancel',
                                actionId,
                              )}
                              aria-disabled={deletePending ? 'true' : undefined}
                              className="aria-disabled:opacity-50"
                              onClick={() => {
                                if (!deletePending) {
                                  setDeleteConfirms((ids) =>
                                    withoutId(ids, actionId),
                                  )
                                  requestFocus(focusKey('delete', actionId))
                                }
                              }}
                            >
                              Cancel
                            </Button>
                            <Button
                              type="button"
                              size="sm"
                              variant="destructive"
                              aria-disabled={busy ? 'true' : undefined}
                              className="aria-disabled:opacity-50"
                              onClick={() => {
                                confirmDelete(action)
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
            })}
          </ul>
        )}
        {addForm !== null ? (
          <ActionForm
            idBase="action-add"
            label="New action item"
            value={addForm}
            members={ownerOptions}
            topics={topics}
            focusKey={focusKey('add-input')}
            pending={pending?.kind === 'create'}
            busy={busy}
            onChange={(patch) => {
              setAddForm((form) =>
                form === null ? form : { ...form, ...patch },
              )
            }}
            onSubmit={submitAdd}
            onCancel={() => {
              setAddForm(null)
              requestFocus(focusKey('add'))
            }}
          />
        ) : membersReady ? (
          <Button
            type="button"
            size="sm"
            variant="outline"
            aria-label="Add action item"
            data-action-focus={focusKey('add')}
            onClick={() => {
              setAddForm(EMPTY_DRAFT)
              requestFocus(focusKey('add-input'))
            }}
          >
            Add action item
          </Button>
        ) : null}
      </>
    )
  }

  return (
    <section
      ref={sectionRef}
      aria-labelledby={ACTIONS_HEADING_ID}
      className="min-w-0 space-y-3 rounded-lg border bg-card p-4 text-card-foreground"
    >
      <h3
        id={ACTIONS_HEADING_ID}
        tabIndex={-1}
        className="rounded-sm text-base font-semibold outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50"
      >
        {count === null ? 'Action items' : `Action items (${count})`}
      </h3>
      {body}
    </section>
  )
}
