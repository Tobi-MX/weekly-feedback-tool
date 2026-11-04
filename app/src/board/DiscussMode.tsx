import { useEffect, useRef, useState } from 'react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import type { ProjectMember } from '@/projects/membersApi'
import { ActionItems } from './ActionItems'
import type { BoardCard, BoardCluster, CycleBoard } from './boardApi'
import { ClusterCardItem, ClusterHeading } from './BoardCards'
import {
  discussionByTopic,
  rankedAgenda,
  ungroupedCards,
  type AgendaItem,
  type DiscussionByTopic,
} from './boardModel'
import type { DiscussionNote, DiscussionStatus } from './discussionApi'
import {
  discussionErrorCodeOf,
  discussionErrorMessage,
  type DiscussionWrite,
} from './discussionErrors'
import {
  DiscussionStatusControl,
  DiscussionStatusLine,
  statusAnnouncement,
} from './DiscussionStatusControl'
import {
  focusAttr,
  GENERAL_KEY,
  GENERAL_NOTE_ADDED,
  NOTE_DELETED,
  NOTE_DELETED_ELSEWHERE_MESSAGE,
  NOTE_UPDATED,
  TopicNotes,
  trimNote,
  validateNote,
  type NoteDraft,
  type NotesController,
  type PendingNoteWrite,
} from './TopicNotes'
import {
  useDiscussionQuery,
  useNoteWrite,
  useSetDiscussionStatus,
} from './useDiscussion'
import { useVoteTotalsQuery } from './useVoteTotals'
import { voteTotalsErrorCodeOf } from './voteTotalsApi'

export const DISCUSS_INTRO =
  'Voting has closed. Topics are listed by total votes, most votes first.'
export const NO_VOTES_CAST =
  'No votes were cast. Topics are listed in their cluster-board order.'
export const TIES_IN_BOARD_ORDER =
  'Topics with the same number of votes are listed in their cluster-board order.'
export const NO_TOPICS = 'There were no topics to vote on.'
export const RESULTS_LOADING = 'Loading results…'
export const RESULTS_LOAD_ERROR = 'Could not load the vote results.'
export const DISCUSSION_LOAD_ERROR = 'Could not load the discussion notes.'
export const UNGROUPED_NOT_VOTED = 'Ungrouped cards were not part of the vote.'
export const NO_CARDS_IN_CLUSTER = 'No cards in this cluster.'

const MODE_HEADING_ID = 'board-mode-heading'

/** A total as text: `1 vote` or `N votes`. */
export function totalVotesText(total: number): string {
  return total === 1 ? '1 vote' : `${total} votes`
}

/**
 * The line under the intro: the all-zero line, the tie line (two topics share
 * a total, unless every total is 0), or nothing.
 */
function orderNote(items: readonly AgendaItem[]): string | null {
  if (items.every((item) => item.totalVotes === 0)) {
    return NO_VOTES_CAST
  }
  const totals = items.map((item) => item.totalVotes)
  return new Set(totals).size < totals.length ? TIES_IN_BOARD_ORDER : null
}

function cardsOf(
  cluster: BoardCluster,
  cardsById: ReadonlyMap<string, BoardCard>,
): BoardCard[] {
  return cluster.cardIds.flatMap((cardId) => {
    const card = cardsById.get(cardId)
    return card ? [card] : []
  })
}

interface AgendaTopicProps {
  readonly item: AgendaItem
  readonly cards: readonly BoardCard[]
  readonly status: DiscussionStatus
  readonly notes: readonly DiscussionNote[]
  readonly isFacilitator: boolean
  readonly statusBusy: boolean
  readonly onStatus: (cluster: BoardCluster, status: DiscussionStatus) => void
  readonly controller: NotesController
}

function AgendaTopic({
  item,
  cards,
  status,
  notes,
  isFacilitator,
  statusBusy,
  onStatus,
  controller,
}: AgendaTopicProps) {
  const { cluster, totalVotes } = item
  const headingId = `discuss-cluster-${cluster.clusterId}-heading`
  return (
    <li className="min-w-0 pl-1">
      <section
        aria-labelledby={headingId}
        className="min-w-0 space-y-3 rounded-lg border bg-card p-4 text-card-foreground"
      >
        <ClusterHeading
          id={headingId}
          cluster={cluster}
          cardCount={cards.length}
        />
        <p className="text-sm font-medium">{totalVotesText(totalVotes)}</p>
        <DiscussionStatusLine status={status} />
        {isFacilitator ? (
          <DiscussionStatusControl
            clusterName={cluster.name}
            status={status}
            busy={statusBusy}
            onSelect={(next) => {
              onStatus(cluster, next)
            }}
          />
        ) : null}
        {cards.length === 0 ? (
          <p className="text-sm text-muted-foreground">{NO_CARDS_IN_CLUSTER}</p>
        ) : (
          <ul aria-label={`Cards in ${cluster.name}`} className="space-y-2">
            {cards.map((card) => (
              <ClusterCardItem key={card.cardId} card={card} />
            ))}
          </ul>
        )}
        <TopicNotes
          topicKey={cluster.clusterId}
          topicName={cluster.name}
          notes={notes}
          controller={controller}
        />
      </section>
    </li>
  )
}

function GeneralNotes({
  notes,
  controller,
}: {
  notes: readonly DiscussionNote[]
  controller: NotesController
}) {
  return (
    <section
      aria-labelledby="discuss-general-notes-heading"
      className="min-w-0 space-y-3 rounded-lg border bg-card p-4 text-card-foreground"
    >
      <h3
        id="discuss-general-notes-heading"
        className="text-base font-semibold"
      >
        General notes ({notes.length})
      </h3>
      <TopicNotes
        topicKey={GENERAL_KEY}
        topicName={null}
        notes={notes}
        controller={controller}
      />
    </section>
  )
}

function LoadAlert({ text, onRetry }: { text: string; onRetry: () => void }) {
  return (
    <div
      role="alert"
      className="space-y-3 rounded-lg border border-destructive/30 bg-card p-4 text-card-foreground"
    >
      <p className="text-sm">{text}</p>
      <Button type="button" variant="outline" onClick={onRetry}>
        Retry
      </Button>
    </div>
  )
}

function without<T>(
  record: Readonly<Record<string, T>>,
  key: string,
): Record<string, T> {
  const next = { ...record }
  delete next[key]
  return next
}

/** The topic key (cluster id or GENERAL_KEY) of every shown note. */
function noteTopics(discussion: DiscussionByTopic): Map<string, string> {
  const map = new Map<string, string>()
  for (const [clusterId, topic] of discussion.topics) {
    for (const note of topic.notes) {
      map.set(note.noteId, clusterId)
    }
  }
  for (const note of discussion.general) {
    map.set(note.noteId, GENERAL_KEY)
  }
  return map
}

/** A focus request: the first matching target that exists gets focus. */
interface FocusRequest {
  readonly targets: readonly string[]
}

export interface DiscussModeProps {
  readonly board: CycleBoard
  /** From the caller's own member row; false while the members load. */
  readonly isFacilitator: boolean
  /** The board's poll interval: a number only while Realtime is down. */
  readonly refetchInterval: number | false
  /** Called when a read or write says the caller is no longer a member. */
  readonly onLostAccess: () => void
  /** A status write was refused with not_project_facilitator. */
  readonly onNotFacilitator: () => void
  /** Re-reads the project members (a refused moderation delete). */
  readonly onRefetchMembers: () => void
  /**
   * The project's current members for the action owner picker (#26), or
   * undefined while the members query is loading or has failed.
   */
  readonly members: readonly ProjectMember[] | undefined
}

/**
 * The Discuss stage: #24's ranked agenda, plus #25's discussion statuses and
 * notes. Topics stay in the order `get_vote_totals` returns them; a status
 * never moves, hides, or collapses a topic. Every member sees the status
 * line and the notes and can add notes; the facilitator also sets statuses
 * and can delete any note. #26's Action items section follows General
 * notes. Writes are not optimistic: a change shows once the refetch it
 * starts is in. It never shows the caller's own votes
 * (`myVotes`, `votesRemaining`), and no control is ever inside a card.
 */
export function DiscussMode({
  board,
  isFacilitator,
  refetchInterval,
  onLostAccess,
  onNotFacilitator,
  onRefetchMembers,
  members,
}: DiscussModeProps) {
  const { cycleId } = board
  const totalsQuery = useVoteTotalsQuery(cycleId, true)
  const discussionQuery = useDiscussionQuery(
    cycleId,
    board.status === 'discuss',
    refetchInterval,
  )
  const lostAccess =
    voteTotalsErrorCodeOf(totalsQuery.error) === 'not_project_member' ||
    discussionErrorCodeOf(discussionQuery.error) === 'not_project_member'

  useEffect(() => {
    if (lostAccess) {
      onLostAccess()
    }
  }, [lostAccess, onLostAccess])

  // The toast for a failed write. It lives on the mutation, so a write that
  // fails after discuss mode unmounted still shows it, and nothing else.
  const onFailure = (error: unknown, write: DiscussionWrite) => {
    const code = discussionErrorCodeOf(error)
    const message = discussionErrorMessage(code, write)
    if (message === null) {
      onLostAccess()
      return
    }
    toast.error(message)
    if (write === 'status' && code === 'not_project_facilitator') {
      onNotFacilitator()
    } else if (write === 'delete' && code === 'not_note_author') {
      onRefetchMembers()
    }
  }
  const statusMutation = useSetDiscussionStatus(cycleId, onFailure)
  const noteMutation = useNoteWrite(cycleId, onFailure)

  const mountedRef = useRef(false)
  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
    }
  }, [])
  // A double click or a held Enter must not send a second write before
  // React re-renders.
  const statusWritingRef = useRef(false)
  const noteWritingRef = useRef(false)
  const [pendingNote, setPendingNote] = useState<PendingNoteWrite | null>(null)

  const [addForms, setAddForms] = useState<Record<string, NoteDraft>>({})
  const [editForms, setEditForms] = useState<Record<string, NoteDraft>>({})
  const [deleteConfirms, setDeleteConfirms] = useState<ReadonlySet<string>>(
    () => new Set(),
  )
  const [focusRequest, setFocusRequest] = useState<FocusRequest | null>(null)
  const [headingFocus, setHeadingFocus] = useState<object | null>(null)
  const [notice, setNotice] = useState<{ readonly id: number } | null>(null)
  const rootRef = useRef<HTMLDivElement>(null)

  // Each announcement gets a new id, which remounts the live region's text,
  // so the same message twice is read twice.
  const [announcement, setAnnouncementState] = useState({ text: '', id: 0 })
  const announce = (text: string) => {
    setAnnouncementState((current) => ({ text, id: current.id + 1 }))
  }
  const requestFocus = (...targets: string[]) => {
    setFocusRequest({ targets })
  }

  const cardsById = new Map(board.cards.map((card) => [card.cardId, card]))
  const ungrouped = ungroupedCards(board)
  const agenda =
    totalsQuery.data === undefined
      ? undefined
      : rankedAgenda(board, totalsQuery.data)
  const discussion =
    discussionQuery.data === undefined
      ? undefined
      : discussionByTopic(board, discussionQuery.data)

  // The role the controls were last drawn for. Losing it hides the status
  // groups and the Delete buttons on others' notes (and their
  // confirmations); focus moves to the mode heading only if it was on one of
  // them. Gaining it moves nothing.
  const [shownRole, setShownRole] = useState(isFacilitator)
  if (shownRole !== isFacilitator) {
    setShownRole(isFacilitator)
    if (!isFacilitator) {
      const active = document.activeElement
      if (active?.closest('[data-facilitator-control]')) {
        setHeadingFocus({})
      }
      if (discussion) {
        const mine = new Set<string>()
        for (const topic of [
          ...[...discussion.topics.values()].map((t) => t.notes),
          discussion.general,
        ]) {
          for (const note of topic) {
            if (note.isMine) {
              mine.add(note.noteId)
            }
          }
        }
        const kept = new Set([...deleteConfirms].filter((id) => mine.has(id)))
        if (kept.size !== deleteConfirms.size) {
          setDeleteConfirms(kept)
        }
      }
    }
  }

  // A refetch that removes a note (deleted elsewhere, or by this tab): close
  // its edit form and confirmation. Focus moves to the topic's Add note only
  // if it was on that note. A note whose own edit is pending is left to that
  // write's error.
  const [shownNotes, setShownNotes] = useState<ReadonlyMap<
    string,
    string
  > | null>(null)
  if (discussion) {
    const current = noteTopics(discussion)
    const changed =
      shownNotes === null ||
      shownNotes.size !== current.size ||
      [...shownNotes.keys()].some((id) => !current.has(id))
    if (changed) {
      setShownNotes(current)
      if (shownNotes !== null) {
        let nextEdit = editForms
        let nextConfirms = deleteConfirms
        let draftLost = false
        let focusTopic: string | null = null
        const active = document.activeElement
        for (const [noteId, topicKey] of shownNotes) {
          if (current.has(noteId)) {
            continue
          }
          const ownEdit =
            pendingNote?.kind === 'edit' && pendingNote.key === noteId
          if (noteId in nextEdit) {
            nextEdit = without(nextEdit, noteId)
            if (!ownEdit) {
              draftLost = true
            }
          }
          if (nextConfirms.has(noteId)) {
            nextConfirms = new Set(
              [...nextConfirms].filter((id) => id !== noteId),
            )
          }
          if (active?.closest(`[data-note-id="${noteId}"]`)) {
            focusTopic = topicKey
          }
        }
        if (nextEdit !== editForms) {
          setEditForms(nextEdit)
        }
        if (nextConfirms !== deleteConfirms) {
          setDeleteConfirms(nextConfirms)
        }
        if (draftLost) {
          setNotice((current) => ({ id: (current?.id ?? 0) + 1 }))
        }
        if (focusTopic !== null) {
          setFocusRequest({
            targets: [
              focusAttr('add', focusTopic),
              focusAttr('add-input', focusTopic),
            ],
          })
        }
      }
    }
  }

  useEffect(() => {
    if (notice !== null) {
      toast.error(NOTE_DELETED_ELSEWHERE_MESSAGE)
    }
  }, [notice])

  useEffect(() => {
    if (headingFocus === null) {
      return
    }
    const active = document.activeElement
    if (active === null || active === document.body || !active.isConnected) {
      document.getElementById(MODE_HEADING_ID)?.focus()
    }
  }, [headingFocus])

  useEffect(() => {
    if (focusRequest === null) {
      return
    }
    for (const target of focusRequest.targets) {
      const element = rootRef.current?.querySelector<HTMLElement>(
        `[data-discussion-focus="${target}"]`,
      )
      if (element) {
        element.focus()
        return
      }
    }
  }, [focusRequest])

  const statusBusy = statusMutation.isPending
  const noteBusy = noteMutation.isPending || pendingNote !== null

  const onStatus = (cluster: BoardCluster, next: DiscussionStatus) => {
    if (statusWritingRef.current || statusBusy || discussion == null) {
      return
    }
    if (discussion.topics.get(cluster.clusterId)?.status === next) {
      return
    }
    statusWritingRef.current = true
    const name = cluster.name
    statusMutation
      .mutateAsync({ clusterId: cluster.clusterId, status: next })
      .then(
        () => {
          if (mountedRef.current) {
            announce(statusAnnouncement(name, next))
          }
        },
        () => {
          // The toast was shown by onFailure, and the discussion re-read.
        },
      )
      .finally(() => {
        statusWritingRef.current = false
      })
  }

  const topicName = (topicKey: string): string | null =>
    topicKey === GENERAL_KEY
      ? null
      : (board.clusters.find((cluster) => cluster.clusterId === topicKey)
          ?.name ?? null)

  const sendNote = (
    pending: PendingNoteWrite,
    run: () => Promise<void>,
    onSuccess: () => void,
    onError: (error: unknown) => void,
  ) => {
    noteWritingRef.current = true
    setPendingNote(pending)
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
        noteWritingRef.current = false
        if (mountedRef.current) {
          setPendingNote(null)
        }
      })
  }

  const controller: NotesController = {
    isFacilitator,
    addForms,
    editForms,
    deleteConfirms,
    noteBusy,
    pending: pendingNote,
    openAdd: (topicKey) => {
      setAddForms((forms) =>
        topicKey in forms
          ? forms
          : { ...forms, [topicKey]: { draft: '', error: null } },
      )
      requestFocus(focusAttr('add-input', topicKey))
    },
    changeAdd: (topicKey, draft) => {
      setAddForms((forms) =>
        topicKey in forms
          ? { ...forms, [topicKey]: { draft, error: forms[topicKey].error } }
          : forms,
      )
    },
    submitAdd: (topicKey) => {
      const form = addForms[topicKey]
      if (form === undefined || noteWritingRef.current || noteBusy) {
        return
      }
      const error = validateNote(form.draft)
      if (error !== null) {
        setAddForms((forms) => ({
          ...forms,
          [topicKey]: { draft: form.draft, error },
        }))
        return
      }
      const name = topicName(topicKey)
      const clusterId = topicKey === GENERAL_KEY ? null : topicKey
      sendNote(
        { kind: 'add', key: topicKey },
        () =>
          noteMutation.mutateAsync({
            kind: 'add',
            clusterId,
            text: trimNote(form.draft),
          }),
        () => {
          setAddForms((forms) => without(forms, topicKey))
          announce(
            name === null ? GENERAL_NOTE_ADDED : `Note added to ${name}.`,
          )
          requestFocus(focusAttr('add', topicKey))
        },
        () => {
          // The form stays open with its text.
        },
      )
    },
    cancelAdd: (topicKey) => {
      setAddForms((forms) => without(forms, topicKey))
      requestFocus(focusAttr('add', topicKey))
    },
    openEdit: (note) => {
      setEditForms((forms) =>
        note.noteId in forms
          ? forms
          : { ...forms, [note.noteId]: { draft: note.text, error: null } },
      )
      requestFocus(focusAttr('edit-input', note.noteId))
    },
    changeEdit: (noteId, draft) => {
      setEditForms((forms) =>
        noteId in forms
          ? { ...forms, [noteId]: { draft, error: forms[noteId].error } }
          : forms,
      )
    },
    submitEdit: (note, topicKey) => {
      const { noteId } = note
      const form = editForms[noteId]
      if (form === undefined || noteWritingRef.current || noteBusy) {
        return
      }
      const error = validateNote(form.draft)
      if (error !== null) {
        setEditForms((forms) => ({
          ...forms,
          [noteId]: { draft: form.draft, error },
        }))
        return
      }
      sendNote(
        { kind: 'edit', key: noteId },
        () =>
          noteMutation.mutateAsync({
            kind: 'edit',
            noteId,
            text: trimNote(form.draft),
          }),
        () => {
          setEditForms((forms) => without(forms, noteId))
          announce(NOTE_UPDATED)
          requestFocus(
            focusAttr('edit', noteId),
            focusAttr('add', topicKey),
            focusAttr('add-input', topicKey),
          )
        },
        (failure) => {
          // The note is gone: the edit form closes. Otherwise it stays open
          // with its text.
          if (discussionErrorCodeOf(failure) === 'note_not_found') {
            setEditForms((forms) => without(forms, noteId))
            requestFocus(
              focusAttr('edit', noteId),
              focusAttr('add', topicKey),
              focusAttr('add-input', topicKey),
            )
          }
        },
      )
    },
    cancelEdit: (noteId) => {
      setEditForms((forms) => without(forms, noteId))
      requestFocus(focusAttr('edit', noteId))
    },
    openDelete: (noteId) => {
      setDeleteConfirms((ids) => new Set([...ids, noteId]))
      requestFocus(focusAttr('delete-cancel', noteId))
    },
    cancelDelete: (noteId) => {
      setDeleteConfirms(
        (ids) => new Set([...ids].filter((id) => id !== noteId)),
      )
      requestFocus(focusAttr('delete', noteId))
    },
    confirmDelete: (note, topicKey) => {
      const { noteId } = note
      if (noteWritingRef.current || noteBusy) {
        return
      }
      sendNote(
        { kind: 'delete', key: noteId },
        () => noteMutation.mutateAsync({ kind: 'delete', noteId }),
        () => {
          setDeleteConfirms(
            (ids) => new Set([...ids].filter((id) => id !== noteId)),
          )
          announce(NOTE_DELETED)
          requestFocus(
            focusAttr('add', topicKey),
            focusAttr('add-input', topicKey),
          )
        },
        (failure) => {
          if (discussionErrorCodeOf(failure) === 'note_not_found') {
            setDeleteConfirms(
              (ids) => new Set([...ids].filter((id) => id !== noteId)),
            )
            requestFocus(
              focusAttr('add', topicKey),
              focusAttr('add-input', topicKey),
            )
          }
        },
      )
    },
  }

  const retryDiscussion = () => {
    void discussionQuery.refetch()
  }
  const discussionFailed =
    discussion === null || (discussion === undefined && discussionQuery.isError)

  let results: React.ReactNode
  if (board.clusters.length === 0) {
    let general: React.ReactNode
    if (discussionFailed) {
      general = (
        <LoadAlert text={DISCUSSION_LOAD_ERROR} onRetry={retryDiscussion} />
      )
    } else if (discussion === undefined) {
      general = (
        <p role="status" className="text-sm text-muted-foreground">
          {RESULTS_LOADING}
        </p>
      )
    } else {
      general = (
        <GeneralNotes notes={discussion.general} controller={controller} />
      )
    }
    results = (
      <>
        <p className="text-sm">{NO_TOPICS}</p>
        {general}
      </>
    )
  } else if (agenda === null || (agenda === undefined && totalsQuery.isError)) {
    results = (
      <LoadAlert
        text={RESULTS_LOAD_ERROR}
        onRetry={() => {
          void totalsQuery.refetch()
        }}
      />
    )
  } else if (discussionFailed) {
    results = (
      <LoadAlert text={DISCUSSION_LOAD_ERROR} onRetry={retryDiscussion} />
    )
  } else if (agenda === undefined || discussion === undefined) {
    results = (
      <p role="status" className="text-sm text-muted-foreground">
        {RESULTS_LOADING}
      </p>
    )
  } else {
    const note = orderNote(agenda)
    results = (
      <>
        {note !== null ? <p className="text-sm">{note}</p> : null}
        <ol
          aria-label="Agenda"
          className="min-w-0 list-outside list-decimal space-y-4 pl-6 marker:font-semibold"
        >
          {agenda.map((item) => {
            const topic = discussion.topics.get(item.cluster.clusterId)
            return (
              <AgendaTopic
                key={item.cluster.clusterId}
                item={item}
                cards={cardsOf(item.cluster, cardsById)}
                status={topic?.status ?? 'pending'}
                notes={topic?.notes ?? []}
                isFacilitator={isFacilitator}
                statusBusy={statusBusy}
                onStatus={onStatus}
                controller={controller}
              />
            )
          })}
        </ol>
        <GeneralNotes notes={discussion.general} controller={controller} />
      </>
    )
  }

  return (
    <div
      ref={rootRef}
      data-testid="discuss-board"
      className="min-w-0 space-y-4"
    >
      <p className="text-sm">{DISCUSS_INTRO}</p>
      <p
        role="status"
        aria-live="polite"
        aria-atomic="true"
        className="sr-only"
      >
        <span key={announcement.id}>{announcement.text}</span>
      </p>
      {results}
      <ActionItems
        board={board}
        topics={agenda ? agenda.map((item) => item.cluster) : board.clusters}
        members={members}
        isFacilitator={isFacilitator}
        refetchInterval={refetchInterval}
        announce={announce}
        onLostAccess={onLostAccess}
        onNotFacilitator={onNotFacilitator}
        onRefetchMembers={onRefetchMembers}
      />
      {ungrouped.length === 0 ? null : (
        <section
          aria-labelledby="discuss-ungrouped-heading"
          className="min-w-0 space-y-3 rounded-lg border bg-card p-4 text-card-foreground"
        >
          <h3
            id="discuss-ungrouped-heading"
            className="text-base font-semibold"
          >
            Ungrouped ({ungrouped.length})
          </h3>
          <p className="text-sm text-muted-foreground">{UNGROUPED_NOT_VOTED}</p>
          <ul
            aria-label="Ungrouped cards"
            className="grid min-w-0 grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-3"
          >
            {ungrouped.map((card) => (
              <ClusterCardItem key={card.cardId} card={card} />
            ))}
          </ul>
        </section>
      )}
    </div>
  )
}
