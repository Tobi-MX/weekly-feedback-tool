import { useEffect, useRef, useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { Link } from 'react-router-dom'
import { toast } from 'sonner'
import { useAuth } from '@/auth/AuthProvider'
import {
  actionErrorCodeOf,
  actionErrorMessage,
  actionLoadErrorMessage,
} from '@/board/actionErrors'
import { NO_RELATED_TOPIC } from '@/board/ActionForm'
import { formatDueDate, isOverdue, localDateIso } from '@/board/actionModel'
import type { ActionStatus } from '@/board/actionsApi'
import { wrapAnywhere } from '@/board/BoardCards'
import { DELETED_ACCOUNT, noteExcerpt } from '@/board/TopicNotes'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import { formatProjectDate } from './projectDate'
import type {
  ProjectAction,
  ProjectActionFilters,
  ProjectActionStatusFilter,
} from './projectActionsApi'
import { projectMembersQueryKey, useProjectMembersQuery } from './useMembers'
import {
  projectActionsPrefix,
  useProjectActionsQuery,
  useSetProjectActionStatus,
} from './useProjectActions'
import { projectQueryKey } from './useProjects'

export const PROJECT_ACTIONS_HEADING = 'Action items'
export const PROJECT_ACTIONS_LOADING = 'Loading action items…'
export const PROJECT_ACTION_MARKED_DONE = 'Action item marked done.'
export const PROJECT_ACTION_REOPENED = 'Action item reopened.'
export const NO_ACTIONS_YET =
  'No action items yet. They are added on the retrospective board during the Discuss stage.'
export const NO_ACTIONS_ASSIGNED = 'No action items are assigned to you.'

const HEADING_ID = 'project-actions-heading'

type ListKey = 'open' | 'done'

const FILTER_LABELS: Record<ProjectActionStatusFilter, string> = {
  open: 'Open',
  done: 'Done',
  all: 'All',
}

const FILTER_ORDER: readonly ProjectActionStatusFilter[] = [
  'open',
  'done',
  'all',
]

function emptyCopy(list: ListKey, mineOnly: boolean): string {
  if (list === 'open') {
    return mineOnly
      ? 'No open action items are assigned to you.'
      : 'No open action items.'
  }
  return mineOnly
    ? 'No completed action items are assigned to you.'
    : 'No completed action items yet.'
}

function ownerLine(action: ProjectAction): string {
  return `Owner: ${action.ownerName ?? DELETED_ACCOUNT}${
    action.ownerIsMe ? ' (you)' : ''
  }`
}

function dueLine(action: ProjectAction, todayIso: string): string {
  if (action.dueDate === null) {
    return 'No due date'
  }
  const due = `Due ${formatDueDate(action.dueDate)}`
  return isOverdue(action, todayIso) ? `${due} · Overdue` : due
}

function statusLine(action: ProjectAction): string {
  return action.status === 'done' && action.completedAt !== null
    ? `Status: Done · Completed ${formatProjectDate(action.completedAt)}`
    : 'Status: Open'
}

/** Where focus goes after a write or when a focused control vanishes. */
type FocusRequest =
  | {
      readonly kind: 'toggle'
      readonly actionId: string
      readonly list: ListKey
    }
  | { readonly kind: 'list'; readonly list: ListKey }

/** What each shown item is: its list, and whether it has a toggle. */
type Shown = ReadonlyMap<
  string,
  { readonly list: ListKey; readonly toggle: boolean }
>

function sameShown(a: Shown | null, b: Shown): boolean {
  if (a === null || a.size !== b.size) {
    return false
  }
  for (const [id, item] of b) {
    const before = a.get(id)
    if (before?.list !== item.list || before.toggle !== item.toggle) {
      return false
    }
  }
  return true
}

/**
 * The project page's Action items section (#27): every action of every
 * retrospective in the project, read through `get_project_actions` with the
 * filters applied in the database. The action's owner or the facilitator
 * marks it done or reopens it with #26's `set_action_status`; the server
 * decides, and hiding a toggle is only a convenience. Writes are not
 * optimistic: a change shows once the refetch it starts is in.
 */
export function ProjectActions({ projectId }: { projectId: string }) {
  const { user } = useAuth()
  const userId = user?.id ?? null
  const queryClient = useQueryClient()
  const [filters, setFilters] = useState<ProjectActionFilters>({
    status: 'open',
    mineOnly: false,
  })
  const query = useProjectActionsQuery(projectId, filters)
  const membersQuery = useProjectMembersQuery(projectId)
  // The role always comes from the caller's own member row; while the
  // members load or have failed, only the caller's own actions get a toggle.
  const isFacilitator =
    membersQuery.data?.some(
      (member) => member.isMe && member.role === 'facilitator',
    ) ?? false
  const mutation = useSetProjectActionStatus(projectId)

  const lostAccess = actionErrorCodeOf(query.error) === 'not_project_member'
  useEffect(() => {
    if (lostAccess) {
      void queryClient.invalidateQueries({
        queryKey: projectQueryKey(userId, projectId),
      })
    }
  }, [lostAccess, queryClient, userId, projectId])

  // TanStack re-reads on visibilitychange; also re-read when the window
  // itself regains focus, as the cycles sections do.
  useEffect(() => {
    const onFocus = () => {
      void queryClient.refetchQueries(
        { queryKey: projectActionsPrefix(userId, projectId), type: 'active' },
        { cancelRefetch: false },
      )
    }
    window.addEventListener('focus', onFocus)
    return () => {
      window.removeEventListener('focus', onFocus)
    }
  }, [queryClient, userId, projectId])

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
  const [pending, setPending] = useState<string | null>(null)
  const [focusRequest, setFocusRequest] = useState<FocusRequest | null>(null)
  const [announcement, setAnnouncement] = useState({ text: '', id: 0 })
  const sectionRef = useRef<HTMLElement>(null)

  const announce = (text: string) => {
    setAnnouncement((current) => ({ text, id: current.id + 1 }))
  }

  const data = query.data
  const showOpen = filters.status !== 'done'
  const showDone = filters.status !== 'open'
  const canToggle = (action: ProjectAction) => action.ownerIsMe || isFacilitator

  // A refetch (or a role change) that removes an item, moves it to the
  // other list, or hides its toggle while one of its controls has focus:
  // focus moves to the heading of the list it was in, or to the section
  // heading when that list is gone. Read during render, while the old DOM
  // still holds focus.
  const [shown, setShown] = useState<Shown | null>(null)
  if (data !== undefined) {
    const current = new Map<string, { list: ListKey; toggle: boolean }>()
    for (const action of data.open) {
      current.set(action.actionId, { list: 'open', toggle: canToggle(action) })
    }
    for (const action of data.done) {
      current.set(action.actionId, { list: 'done', toggle: canToggle(action) })
    }
    if (!sameShown(shown, current)) {
      setShown(current)
      const active = document.activeElement
      const host = active?.closest<HTMLElement>('[data-project-action-id]')
      const id = host?.dataset.projectActionId
      // A write's own move (pending, or just settled with its focus request
      // for the list it left) is left to that write's focus rule.
      const ownMove =
        id !== undefined &&
        (pending === id ||
          (focusRequest?.kind === 'toggle' &&
            focusRequest.actionId === id &&
            focusRequest.list === shown?.get(id)?.list))
      if (shown !== null && id !== undefined && !ownMove) {
        const before = shown.get(id)
        const after = current.get(id)
        const onToggle = Boolean(
          active?.closest('[data-project-action-toggle]'),
        )
        if (
          before !== undefined &&
          (after === undefined ||
            after.list !== before.list ||
            (onToggle && !after.toggle))
        ) {
          setFocusRequest({ kind: 'list', list: before.list })
        }
      }
    }
  }

  useEffect(() => {
    if (focusRequest === null) {
      return
    }
    const section = sectionRef.current
    if (section === null) {
      return
    }
    if (focusRequest.kind === 'toggle') {
      const toggle = section.querySelector<HTMLElement>(
        `[data-project-action-toggle="${focusRequest.actionId}"]`,
      )
      if (toggle) {
        toggle.focus()
        return
      }
    }
    const heading =
      section.querySelector<HTMLElement>(
        `[data-project-actions-list="${focusRequest.list}"]`,
      ) ?? document.getElementById(HEADING_ID)
    heading?.focus()
  }, [focusRequest])

  const busy = pending !== null || mutation.isPending

  const toggle = (action: ProjectAction, list: ListKey) => {
    if (writingRef.current || busy) {
      return
    }
    writingRef.current = true
    const { actionId, cycleId } = action
    const status: ActionStatus = action.status === 'open' ? 'done' : 'open'
    setPending(actionId)
    mutation
      .mutateAsync({ actionId, cycleId, status })
      .then(
        () => {
          if (!mountedRef.current) {
            return
          }
          announce(
            status === 'done'
              ? PROJECT_ACTION_MARKED_DONE
              : PROJECT_ACTION_REOPENED,
          )
          // Focus follows the item only if it was still on its toggle (or
          // nowhere); a user who moved on keeps their place.
          const active = document.activeElement
          if (
            active === null ||
            active === document.body ||
            active.closest(`[data-project-action-toggle="${actionId}"]`) !==
              null
          ) {
            setFocusRequest({ kind: 'toggle', actionId, list })
          }
        },
        (error: unknown) => {
          if (!mountedRef.current) {
            return
          }
          const code = actionErrorCodeOf(error)
          const message = actionErrorMessage(code, 'status')
          if (message === null) {
            void queryClient.invalidateQueries({
              queryKey: projectQueryKey(userId, projectId),
            })
            return
          }
          toast.error(message)
          if (code === 'not_action_owner') {
            void queryClient.invalidateQueries({
              queryKey: projectMembersQueryKey(userId, projectId),
            })
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

  // The query re-renders on every read (the poll included), so an action
  // due "today" gains its Overdue label once the local date moves on.
  const todayIso = localDateIso(new Date())

  const renderItem = (action: ProjectAction, list: ListKey) => {
    const { actionId } = action
    const excerpt = noteExcerpt(action.description)
    const isPending = pending === actionId
    const verb = action.status === 'open' ? 'Mark done' : 'Reopen'
    return (
      <li
        key={actionId}
        data-project-action-id={actionId}
        className="min-w-0 space-y-2 rounded-md border p-3"
      >
        <p className={cn('text-sm whitespace-pre-wrap', wrapAnywhere)}>
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
            {action.clusterName === null
              ? NO_RELATED_TOPIC
              : `Topic: ${action.clusterName}`}
          </p>
          <p>
            Retrospective:{' '}
            {action.cycleStatus === 'discuss' ? (
              <Link
                to={`/cycles/${action.cycleId}/board`}
                className="font-medium text-foreground underline underline-offset-4"
              >
                {action.cycleTitle}
              </Link>
            ) : (
              action.cycleTitle
            )}
          </p>
          <p>{statusLine(action)}</p>
        </div>
        {canToggle(action) ? (
          <div className="flex flex-wrap gap-2">
            <Button
              type="button"
              size="sm"
              variant="outline"
              aria-label={`${verb}: ${excerpt}`}
              aria-disabled={busy ? 'true' : undefined}
              data-project-action-toggle={actionId}
              className="aria-disabled:opacity-50"
              onClick={() => {
                toggle(action, list)
              }}
            >
              {isPending ? 'Updating…' : verb}
            </Button>
          </div>
        ) : null}
      </li>
    )
  }

  const renderList = (
    list: ListKey,
    items: readonly ProjectAction[],
    total: number,
  ) => {
    const headingId = `project-actions-${list}-heading`
    const note =
      total > items.length
        ? list === 'open'
          ? `Showing ${items.length} of ${total} open action items.`
          : `Showing the ${items.length} most recently completed of ${total}.`
        : null
    return (
      <div key={list} className="min-w-0 space-y-2">
        <h3
          id={headingId}
          tabIndex={-1}
          data-project-actions-list={list}
          className="rounded-sm text-base font-semibold outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50"
        >
          {list === 'open' ? `Open (${total})` : `Done (${total})`}
        </h3>
        {items.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            {emptyCopy(list, filters.mineOnly)}
          </p>
        ) : (
          <ul aria-labelledby={headingId} className="min-w-0 space-y-2">
            {items.map((action) => renderItem(action, list))}
          </ul>
        )}
        {note !== null ? (
          <p className="text-sm text-muted-foreground">{note}</p>
        ) : null}
      </div>
    )
  }

  let body: React.ReactNode
  if (data === undefined && query.isError) {
    body = (
      <div
        role="alert"
        className="space-y-3 rounded-lg border border-destructive/30 bg-card p-4 text-card-foreground"
      >
        <p className="text-sm">
          {actionLoadErrorMessage(actionErrorCodeOf(query.error))}
        </p>
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
  } else if (data === undefined) {
    body = (
      <p role="status" className="text-sm text-muted-foreground">
        {PROJECT_ACTIONS_LOADING}
      </p>
    )
  } else if (
    filters.status === 'all' &&
    data.openCount === 0 &&
    data.doneCount === 0
  ) {
    body = (
      <p className="text-sm text-muted-foreground">
        {filters.mineOnly ? NO_ACTIONS_ASSIGNED : NO_ACTIONS_YET}
      </p>
    )
  } else {
    body = (
      <div className="min-w-0 space-y-4">
        {showOpen ? renderList('open', data.open, data.openCount) : null}
        {showDone ? renderList('done', data.done, data.doneCount) : null}
      </div>
    )
  }

  return (
    <section
      ref={sectionRef}
      aria-labelledby={HEADING_ID}
      className="min-w-0 space-y-3"
    >
      <h2
        id={HEADING_ID}
        tabIndex={-1}
        className="rounded-sm text-lg font-semibold outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50"
      >
        {PROJECT_ACTIONS_HEADING}
      </h2>
      <p
        role="status"
        aria-live="polite"
        aria-atomic="true"
        className="sr-only"
      >
        <span key={announcement.id}>{announcement.text}</span>
      </p>
      <div className="flex min-w-0 flex-wrap items-center gap-x-4 gap-y-2">
        <div role="group" aria-label="Show" className="flex flex-wrap gap-2">
          {FILTER_ORDER.map((status) => (
            <Button
              key={status}
              type="button"
              size="sm"
              variant={filters.status === status ? 'default' : 'outline'}
              aria-pressed={filters.status === status}
              onClick={() => {
                setFilters((current) => ({ ...current, status }))
              }}
            >
              {FILTER_LABELS[status]}
            </Button>
          ))}
        </div>
        <label className="inline-flex min-h-8 cursor-pointer items-center gap-2 text-sm">
          <input
            type="checkbox"
            className="size-6 accent-primary"
            checked={filters.mineOnly}
            onChange={(event) => {
              const mineOnly = event.currentTarget.checked
              setFilters((current) => ({ ...current, mineOnly }))
            }}
          />
          Assigned to me
        </label>
      </div>
      {body}
    </section>
  )
}
