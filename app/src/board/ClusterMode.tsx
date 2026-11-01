import {
  useEffect,
  useId,
  useRef,
  useState,
  type DragEvent,
  type FormEvent,
  type KeyboardEvent,
  type ReactNode,
} from 'react'
import { toast } from 'sonner'
import { focusRing, wrapText } from '@/cards/CardForms'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import type { BoardCard, BoardCluster, CycleBoard } from './boardApi'
import { ClusterCardItem } from './BoardCards'
import { ungroupedCards } from './boardModel'
import {
  applyPendingMove,
  CARD_DRAG_TYPE,
  cardAnchor,
  cardLocation,
  cardMovedItself,
  dropPosition,
  isNoOpMove,
  locationKey,
  moveAnnouncement,
  moveButtonLabel,
  moveMenuItems,
  type CardAnchor,
  type CardMove,
  type MoveMenuItem,
} from './cardMove'
import {
  clusterErrorCodeOf,
  clusterErrorMessage,
  moveErrorMessage,
  NAME_REQUIRED_MESSAGE,
  NAME_TAKEN_MESSAGE,
  NAME_TOO_LONG_MESSAGE,
  NAME_UNGROUPED_MESSAGE,
  type ClusterErrorCode,
  type ClusterOperation,
} from './clusterErrors'
import { MoveMenu, useFinePointer } from './MoveMenu'
import {
  useCreateCluster,
  useDeleteCluster,
  useMoveCard,
  useRenameCluster,
} from './useClusters'

export const CLUSTER_INTRO =
  'Group related cards into clusters. Everyone in the project can add, rename and delete clusters until voting starts.'

const MAX_NAME_LENGTH = 100

const inputClass = cn(
  'block h-9 w-full min-w-0 rounded-md border border-input bg-background px-3 py-1 text-sm aria-invalid:border-destructive',
  focusRing,
)

/** The server's trim set: space, tab, line feed, carriage return. */
export function trimClusterName(raw: string): string {
  return raw.replace(/^[ \t\n\r]+|[ \t\n\r]+$/g, '')
}

/**
 * The client's check of a name against the current board, mirroring the
 * server's rules, plus "Ungrouped". Returns the trimmed name or the inline
 * message. `ownId` is the cluster being renamed, whose own name does not
 * count as taken.
 */
export function validateClusterName(
  raw: string,
  clusters: readonly BoardCluster[],
  ownId?: string,
): { readonly name: string } | { readonly error: string } {
  const name = trimClusterName(raw)
  if (name === '') {
    return { error: NAME_REQUIRED_MESSAGE }
  }
  // Code points, as the server's char_length counts them.
  if ([...name].length > MAX_NAME_LENGTH) {
    return { error: NAME_TOO_LONG_MESSAGE }
  }
  const lower = name.toLowerCase()
  if (
    clusters.some(
      (cluster) =>
        cluster.clusterId !== ownId && cluster.name.toLowerCase() === lower,
    )
  ) {
    return { error: NAME_TAKEN_MESSAGE }
  }
  if (lower === 'ungrouped') {
    return { error: NAME_UNGROUPED_MESSAGE }
  }
  return { name }
}

/** The form a cluster has open: at most one on the board at a time. */
type OpenForm =
  | {
      readonly kind: 'rename'
      readonly clusterId: string
      readonly draft: string
      readonly error: string | null
    }
  | { readonly kind: 'delete'; readonly clusterId: string }

/** Where focus goes after the next render. */
type FocusTarget =
  | { readonly kind: 'new-input' }
  | {
      readonly kind:
        'rename-button' | 'delete-button' | 'rename-input' | 'delete-cancel'
      readonly clusterId: string
    }

function focusSelector(target: FocusTarget): string | null {
  return target.kind === 'new-input'
    ? null
    : `[data-cluster-focus="${target.kind}:${target.clusterId}"]`
}

function deleteQuestion(cluster: BoardCluster): string {
  const count = cluster.cardIds.length
  const question = `Delete the cluster "${cluster.name}"?`
  if (count === 0) {
    return `${question} It has no cards.`
  }
  return count === 1
    ? `${question} Its 1 card goes back to Ungrouped.`
    : `${question} Its ${count} cards go back to Ungrouped.`
}

/** A card the board wants focused once it is shown at `at` (#18). */
interface MoveFocus {
  readonly cardId: string
  readonly at: string
}

/** The open Move menu, and where its card was when it opened. */
interface OpenMenu {
  readonly cardId: string
  readonly anchor: CardAnchor
}

/** An ongoing drag over the board. */
interface DragState {
  /** The dragged card when the drag started on this board. */
  readonly cardId: string | null
  /** The cluster id, or "ungrouped", under the pointer. */
  readonly over: string | null
  /** The insertion index inside the cluster's list, or null to append. */
  readonly index: number | null
}

const UNGROUPED_TARGET = 'ungrouped'

function sameAnchor(a: CardAnchor, b: CardAnchor): boolean {
  return (
    a.group === b.group &&
    a.before.join() === b.before.join() &&
    a.after.join() === b.after.join()
  )
}

function carriesCard(event: DragEvent): boolean {
  return Array.from(event.dataTransfer.types).includes(CARD_DRAG_TYPE)
}

/**
 * The insertion index inside the cluster list under the pointer: the number
 * of cards whose vertical midpoint is above it. Null outside the list
 * (heading, empty area), which appends.
 */
function insertionIndex(event: DragEvent<HTMLElement>): number | null {
  const target = event.target
  if (!(target instanceof Element)) {
    return null
  }
  const list = target.closest('ul[data-drop-list]')
  if (list === null || !event.currentTarget.contains(list)) {
    return null
  }
  const items = Array.from(list.querySelectorAll('li[data-card-id]'))
  const index = items.findIndex((item) => {
    const rect = item.getBoundingClientRect()
    return event.clientY < rect.top + rect.height / 2
  })
  return index === -1 ? items.length : index
}

/** Drop-target props for a section; `target` is a cluster id or null. */
interface DropTargetProps {
  readonly onDragOver: (event: DragEvent<HTMLElement>) => void
  readonly onDragLeave: (event: DragEvent<HTMLElement>) => void
  readonly onDrop: (event: DragEvent<HTMLElement>) => void
}

function InlineError({ id, text }: { id: string; text: string }) {
  return (
    <p id={id} role="alert" className="text-sm text-destructive">
      {text}
    </p>
  )
}

interface ClusterSectionProps {
  readonly cluster: BoardCluster
  readonly cards: readonly BoardCard[]
  readonly renderCard: (card: BoardCard, index: number) => ReactNode
  readonly dropTarget: DropTargetProps
  readonly dropActive: boolean
  readonly form: OpenForm | null
  readonly renamePending: boolean
  readonly deletePending: boolean
  readonly onOpenRename: () => void
  readonly onOpenDelete: () => void
  readonly onDraftChange: (draft: string) => void
  readonly onCancel: () => void
  readonly onSaveRename: () => void
  readonly onConfirmDelete: () => void
}

function ClusterSection({
  cluster,
  cards,
  renderCard,
  dropTarget,
  dropActive,
  form,
  renamePending,
  deletePending,
  onOpenRename,
  onOpenDelete,
  onDraftChange,
  onCancel,
  onSaveRename,
  onConfirmDelete,
}: ClusterSectionProps) {
  const baseId = useId()
  const headingId = `${baseId}-heading`
  const inputId = `${baseId}-name`
  const errorId = `${baseId}-error`
  const { clusterId, name } = cluster

  const onEscape = (pending: boolean) => (event: KeyboardEvent) => {
    if (event.key === 'Escape' && !pending) {
      event.preventDefault()
      onCancel()
    }
  }

  let header: React.ReactNode
  if (form?.kind === 'rename') {
    header = (
      <form
        aria-label={`Rename cluster ${name}`}
        className="min-w-0 space-y-2"
        noValidate
        onKeyDown={onEscape(renamePending)}
        onSubmit={(event: FormEvent) => {
          event.preventDefault()
          onSaveRename()
        }}
      >
        <label htmlFor={inputId} className="block text-sm font-medium">
          Cluster name
        </label>
        <input
          id={inputId}
          type="text"
          autoComplete="off"
          value={form.draft}
          data-cluster-focus={`rename-input:${clusterId}`}
          aria-invalid={form.error ? 'true' : undefined}
          aria-describedby={form.error ? errorId : undefined}
          className={inputClass}
          onChange={(event) => {
            onDraftChange(event.target.value)
          }}
        />
        {form.error ? <InlineError id={errorId} text={form.error} /> : null}
        <div className="flex flex-wrap gap-2">
          <Button type="submit" disabled={renamePending}>
            {renamePending ? 'Saving…' : 'Save'}
          </Button>
          <Button
            type="button"
            variant="outline"
            disabled={renamePending}
            onClick={onCancel}
          >
            Cancel
          </Button>
        </div>
      </form>
    )
  } else {
    header = (
      <h3 id={headingId} className={cn('text-base font-semibold', wrapText)}>
        {name} ({cards.length})
      </h3>
    )
  }

  let controls: React.ReactNode = null
  if (form?.kind === 'delete') {
    controls = (
      <div
        role="group"
        aria-label={`Delete cluster ${name}`}
        className="space-y-3 rounded-md border border-destructive/30 p-3"
        onKeyDown={onEscape(deletePending)}
      >
        <p className={cn('text-sm', wrapText)}>{deleteQuestion(cluster)}</p>
        <div className="flex flex-wrap gap-2">
          <Button
            type="button"
            variant="outline"
            disabled={deletePending}
            data-cluster-focus={`delete-cancel:${clusterId}`}
            onClick={onCancel}
          >
            Cancel
          </Button>
          <Button
            type="button"
            variant="destructive"
            disabled={deletePending}
            onClick={onConfirmDelete}
          >
            {deletePending ? 'Deleting…' : 'Delete cluster'}
          </Button>
        </div>
      </div>
    )
  } else if (form === null) {
    controls = (
      <div className="flex flex-wrap gap-2">
        <Button
          type="button"
          variant="outline"
          size="sm"
          aria-label={`Rename cluster ${name}`}
          data-cluster-focus={`rename-button:${clusterId}`}
          onClick={onOpenRename}
        >
          Rename
        </Button>
        <Button
          type="button"
          variant="outline"
          size="sm"
          aria-label={`Delete cluster ${name}`}
          data-cluster-focus={`delete-button:${clusterId}`}
          onClick={onOpenDelete}
        >
          Delete
        </Button>
      </div>
    )
  }

  return (
    <section
      aria-labelledby={form?.kind === 'rename' ? undefined : headingId}
      aria-label={form?.kind === 'rename' ? name : undefined}
      data-drop-target={clusterId}
      className={cn(
        'min-w-0 space-y-3 rounded-lg border bg-card p-4 text-card-foreground',
        dropActive && 'ring-2 ring-primary',
      )}
      {...dropTarget}
    >
      {header}
      {cards.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          No cards in this cluster yet.
        </p>
      ) : (
        <ul
          aria-label={`Cards in ${name}`}
          data-drop-list=""
          className="space-y-2"
        >
          {cards.map((card, index) => renderCard(card, index))}
        </ul>
      )}
      {controls}
    </section>
  )
}

export interface ClusterModeProps {
  readonly board: CycleBoard
  /** Called when a write says the caller is no longer a member. */
  readonly onLostAccess: () => void
}

/**
 * The Cluster stage: the "New cluster" form, the ungrouped cards, and every
 * cluster with its Rename and Delete controls, and every card with its Move
 * menu and, on fine pointers, native drag (#18). Every member sees the same
 * controls. Cluster writes are not optimistic: they show when the board's
 * refetch returns, and a refetch never overwrites a draft being typed. A card
 * move is the one optimistic write: the pending move is drawn over the server
 * board until the refetch after it is in.
 */
export function ClusterMode({ board, onLostAccess }: ClusterModeProps) {
  const { cycleId } = board
  const finePointer = useFinePointer()
  const mover = useMoveCard(cycleId, (error) => {
    const message = moveErrorMessage(clusterErrorCodeOf(error))
    if (message === null) {
      onLostAccess()
    } else {
      toast.error(message)
    }
  })
  // The server board with the pending move (if any) applied on top. The
  // cache is never edited; the overlay disappears with the mutation.
  const displayed =
    mover.pendingMove === null
      ? board
      : applyPendingMove(board, mover.pendingMove)
  const { clusters } = displayed
  const createMutation = useCreateCluster(cycleId)
  const renameMutation = useRenameCluster(cycleId)
  const deleteMutation = useDeleteCluster(cycleId)

  const [newDraft, setNewDraft] = useState('')
  const [newError, setNewError] = useState<string | null>(null)
  const [openForm, setOpenForm] = useState<OpenForm | null>(null)
  // Each announcement gets a new id, which remounts the live region's text,
  // so a repeated identical message (two moves to Ungrouped) is read again.
  const [announcement, setAnnouncementState] = useState({ text: '', id: 0 })
  const setAnnouncement = (text: string) => {
    setAnnouncementState((current) => ({ text, id: current.id + 1 }))
  }
  // A new object for every request, so the same target can be asked twice.
  const [focusTarget, setFocusTarget] = useState<FocusTarget | null>(null)

  // A synchronous second click or Enter must not send a second request.
  const createPendingRef = useRef(false)
  const movePendingRef = useRef(false)
  const [openMenu, setOpenMenu] = useState<OpenMenu | null>(null)
  const [moveFocus, setMoveFocus] = useState<MoveFocus | null>(null)
  const handledMoveFocusRef = useRef<MoveFocus | null>(null)
  const [drag, setDrag] = useState<DragState | null>(null)
  const renamePendingRef = useRef(false)
  const deletePendingRef = useRef(false)
  const rootRef = useRef<HTMLDivElement>(null)
  const newInputRef = useRef<HTMLInputElement>(null)
  const newInputId = useId()
  const newErrorId = useId()

  // The cluster whose form is open disappeared from the refreshed board (a
  // delete by anyone): close the form and move focus to the new-cluster input.
  if (
    openForm !== null &&
    !clusters.some((cluster) => cluster.clusterId === openForm.clusterId)
  ) {
    setOpenForm(null)
    setFocusTarget({ kind: 'new-input' })
  }

  // Another member moved the card whose menu is open: close the menu, send
  // nothing, and focus the card's Move button in its new place.
  // Another card moving above or below it changes nothing.
  if (openMenu !== null) {
    const anchor = cardAnchor(displayed, openMenu.cardId)
    if (cardMovedItself(openMenu.anchor, anchor)) {
      setOpenMenu(null)
      setMoveFocus({
        cardId: openMenu.cardId,
        at: locationKey(cardLocation(displayed, openMenu.cardId)),
      })
    } else if (
      anchor !== openMenu.anchor &&
      !sameAnchor(anchor, openMenu.anchor)
    ) {
      setOpenMenu({ ...openMenu, anchor })
    }
  }

  // Focus a moved card's Move button once the card is shown where expected,
  // and only if focus is still on that card (its button, its menu) or was
  // lost to <body> because the control unmounted (#94's rule).
  useEffect(() => {
    if (moveFocus === null || handledMoveFocusRef.current === moveFocus) {
      return
    }
    if (
      locationKey(cardLocation(displayed, moveFocus.cardId)) !== moveFocus.at
    ) {
      return
    }
    handledMoveFocusRef.current = moveFocus
    const active = document.activeElement
    const onCard =
      active === null ||
      active === document.body ||
      active.closest(`[data-card-id="${moveFocus.cardId}"]`) !== null ||
      active.closest(`[data-move-menu="${moveFocus.cardId}"]`) !== null
    if (!onCard) {
      return
    }
    rootRef.current
      ?.querySelector<HTMLElement>(`[data-move-card="${moveFocus.cardId}"]`)
      ?.focus()
  }, [moveFocus, displayed])

  useEffect(() => {
    if (focusTarget === null) {
      return
    }
    const selector = focusSelector(focusTarget)
    const element =
      selector === null
        ? newInputRef.current
        : rootRef.current?.querySelector<HTMLElement>(selector)
    element?.focus()
  }, [focusTarget])

  const cardsById = new Map(board.cards.map((card) => [card.cardId, card]))
  const ungrouped = ungroupedCards(displayed)

  /** Focus the card's Move button where the given board shows it. */
  const focusMovedCard = (cardId: string, shown: typeof board | null) => {
    if (shown !== null) {
      setMoveFocus({ cardId, at: locationKey(cardLocation(shown, cardId)) })
    }
  }

  /** One move at a time, through move_card only; a no-op sends nothing. */
  const startMove = (move: CardMove) => {
    if (movePendingRef.current || isNoOpMove(displayed, move)) {
      return
    }
    movePendingRef.current = true
    setOpenMenu(null)
    setDrag(null)
    focusMovedCard(move.cardId, applyPendingMove(displayed, move))
    mover
      .mutateAsync(move)
      .then(() => {
        const server = mover.serverBoard()
        if (server !== null) {
          setAnnouncement(moveAnnouncement(server, move.cardId))
        }
        focusMovedCard(move.cardId, server)
      })
      .catch(() => {
        // The toast was shown when the move failed; the card is back.
        focusMovedCard(move.cardId, mover.serverBoard())
      })
      .finally(() => {
        movePendingRef.current = false
      })
  }

  /**
   * One set of handlers for every drop target. Each section names itself in
   * `data-drop-target`: a cluster id, or "ungrouped".
   */
  const targetOf = (event: DragEvent<HTMLElement>) => {
    const over = event.currentTarget.dataset.dropTarget ?? UNGROUPED_TARGET
    return { over, clusterId: over === UNGROUPED_TARGET ? null : over }
  }

  const dropHandlers: DropTargetProps = {
    onDragOver: (event) => {
      if (!carriesCard(event) || movePendingRef.current) {
        return
      }
      const { over, clusterId } = targetOf(event)
      event.preventDefault()
      event.dataTransfer.dropEffect = 'move'
      const index = clusterId === null ? null : insertionIndex(event)
      setDrag((current) =>
        current !== null && current.over === over && current.index === index
          ? current
          : { cardId: current?.cardId ?? null, over, index },
      )
    },
    onDragLeave: (event) => {
      const { over } = targetOf(event)
      const next = event.relatedTarget
      if (next instanceof Node && event.currentTarget.contains(next)) {
        return
      }
      setDrag((current) =>
        current?.over === over
          ? { ...current, over: null, index: null }
          : current,
      )
    },
    onDrop: (event) => {
      event.preventDefault()
      const { clusterId } = targetOf(event)
      const index = clusterId === null ? null : insertionIndex(event)
      setDrag(null)
      if (!carriesCard(event)) {
        return
      }
      const cardId = event.dataTransfer.getData(CARD_DRAG_TYPE)
      // A card of another tab, cycle, or board is not ours to move.
      if (cardId === '' || cardLocation(displayed, cardId) === null) {
        return
      }
      startMove({
        cardId,
        clusterId,
        position:
          clusterId === null
            ? null
            : dropPosition(displayed, cardId, clusterId, index),
      })
    },
  }

  const canDrag = finePointer && !mover.isPending

  const renderCard = (
    card: BoardCard,
    dropLine: 'before' | 'after' | null = null,
  ) => {
    const items: readonly MoveMenuItem[] = moveMenuItems(displayed, card.cardId)
    return (
      <ClusterCardItem
        key={card.cardId}
        card={card}
        draggable={canDrag}
        dropLine={dropLine}
        onDragStart={(event) => {
          if (movePendingRef.current) {
            event.preventDefault()
            return
          }
          event.dataTransfer.setData(CARD_DRAG_TYPE, card.cardId)
          event.dataTransfer.effectAllowed = 'move'
          setOpenMenu(null)
          setDrag({ cardId: card.cardId, over: null, index: null })
        }}
        onDragEnd={() => {
          setDrag(null)
        }}
        moveControl={
          items.length === 0 ? null : (
            <MoveMenu
              cardId={card.cardId}
              label={moveButtonLabel(card)}
              items={items}
              open={openMenu?.cardId === card.cardId}
              blocked={mover.isPending}
              onOpenChange={(open) => {
                if (open) {
                  // A focus request left over from a move must not pull focus
                  // out of the menu that is opening.
                  handledMoveFocusRef.current = moveFocus
                }
                setOpenMenu(
                  open
                    ? {
                        cardId: card.cardId,
                        anchor: cardAnchor(displayed, card.cardId),
                      }
                    : null,
                )
              }}
              onSelect={(item) => {
                startMove(item.move)
              }}
            />
          )
        }
      />
    )
  }

  /** Shows the toast (or the not-found state) and returns the code. */
  const reportError = (
    error: unknown,
    operation: ClusterOperation,
  ): ClusterErrorCode => {
    const code = clusterErrorCodeOf(error)
    const message = clusterErrorMessage(code, operation)
    if (message === null) {
      onLostAccess()
    } else {
      toast.error(message)
    }
    return code
  }

  /** Closes the form only if it is still the one for this cluster. */
  const closeFormOf = (kind: OpenForm['kind'], clusterId: string) => {
    setOpenForm((current) =>
      current?.kind === kind && current.clusterId === clusterId
        ? null
        : current,
    )
  }

  const submitNew = (event: FormEvent) => {
    event.preventDefault()
    if (createPendingRef.current) {
      return
    }
    const checked = validateClusterName(newDraft, clusters)
    if ('error' in checked) {
      setNewError(checked.error)
      return
    }
    setNewError(null)
    createPendingRef.current = true
    createMutation
      .mutateAsync(checked.name)
      .then((saved) => {
        setNewDraft('')
        setAnnouncement(`Added cluster ${saved.name}.`)
        setFocusTarget({ kind: 'new-input' })
      })
      .catch((error: unknown) => {
        const code = reportError(error, 'save')
        if (code === 'cycle_not_clustering') {
          setNewDraft('')
        }
      })
      .finally(() => {
        createPendingRef.current = false
      })
  }

  const openRename = (cluster: BoardCluster) => {
    setOpenForm({
      kind: 'rename',
      clusterId: cluster.clusterId,
      draft: cluster.name,
      error: null,
    })
    setFocusTarget({ kind: 'rename-input', clusterId: cluster.clusterId })
  }

  const openDelete = (cluster: BoardCluster) => {
    setOpenForm({ kind: 'delete', clusterId: cluster.clusterId })
    setFocusTarget({ kind: 'delete-cancel', clusterId: cluster.clusterId })
  }

  const cancel = (form: OpenForm) => {
    setOpenForm(null)
    setFocusTarget({
      kind: form.kind === 'rename' ? 'rename-button' : 'delete-button',
      clusterId: form.clusterId,
    })
  }

  const saveRename = (cluster: BoardCluster, form: OpenForm) => {
    if (form.kind !== 'rename' || renamePendingRef.current) {
      return
    }
    const { clusterId } = cluster
    // An unchanged name (after trimming, same case) closes with no request.
    if (trimClusterName(form.draft) === cluster.name) {
      cancel(form)
      return
    }
    const checked = validateClusterName(form.draft, clusters, clusterId)
    if ('error' in checked) {
      setOpenForm({ ...form, error: checked.error })
      return
    }
    setOpenForm({ ...form, error: null })
    renamePendingRef.current = true
    renameMutation
      .mutateAsync({ clusterId, name: checked.name })
      .then((saved) => {
        closeFormOf('rename', clusterId)
        setAnnouncement(`Renamed cluster to ${saved.name}.`)
        setFocusTarget({ kind: 'rename-button', clusterId })
      })
      .catch((error: unknown) => {
        const code = reportError(error, 'save')
        if (code === 'cycle_not_clustering') {
          closeFormOf('rename', clusterId)
        }
      })
      .finally(() => {
        renamePendingRef.current = false
      })
  }

  const confirmDelete = (cluster: BoardCluster) => {
    if (deletePendingRef.current) {
      return
    }
    const { clusterId, name } = cluster
    deletePendingRef.current = true
    deleteMutation
      .mutateAsync(clusterId)
      .then(() => {
        closeFormOf('delete', clusterId)
        setAnnouncement(`Deleted cluster ${name}.`)
        setFocusTarget({ kind: 'new-input' })
      })
      .catch((error: unknown) => {
        const code = reportError(error, 'delete')
        if (code === 'cycle_not_clustering') {
          closeFormOf('delete', clusterId)
        }
      })
      .finally(() => {
        deletePendingRef.current = false
      })
  }

  const createPending = createMutation.isPending

  return (
    <div
      ref={rootRef}
      data-testid="cluster-board"
      className="min-w-0 space-y-4"
    >
      <form
        aria-label="New cluster"
        noValidate
        className="min-w-0 space-y-2"
        onSubmit={submitNew}
      >
        <label htmlFor={newInputId} className="block text-sm font-medium">
          Cluster name
        </label>
        <div className="flex min-w-0 flex-wrap items-start gap-2">
          <input
            ref={newInputRef}
            id={newInputId}
            type="text"
            autoComplete="off"
            value={newDraft}
            aria-invalid={newError ? 'true' : undefined}
            aria-describedby={newError ? newErrorId : undefined}
            className={cn(inputClass, 'flex-1 basis-48')}
            onChange={(event) => {
              setNewDraft(event.target.value)
              setNewError(null)
            }}
          />
          <Button type="submit" disabled={createPending}>
            {createPending ? 'Adding…' : 'Add cluster'}
          </Button>
        </div>
        {newError ? <InlineError id={newErrorId} text={newError} /> : null}
      </form>

      <p
        role="status"
        aria-live="polite"
        aria-atomic="true"
        className="sr-only"
      >
        <span key={announcement.id}>{announcement.text}</span>
      </p>

      <section
        aria-labelledby="cluster-ungrouped-heading"
        data-drop-target={UNGROUPED_TARGET}
        className={cn(
          'min-w-0 space-y-3 rounded-lg border bg-card p-4 text-card-foreground',
          drag?.over === UNGROUPED_TARGET && 'ring-2 ring-primary',
        )}
        {...dropHandlers}
      >
        <h3 id="cluster-ungrouped-heading" className="text-base font-semibold">
          Ungrouped ({ungrouped.length})
        </h3>
        {ungrouped.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            {board.cards.length === 0
              ? 'No feedback was submitted for this cycle.'
              : 'Every card is in a cluster.'}
          </p>
        ) : (
          <ul
            aria-label="Ungrouped cards"
            className="grid min-w-0 grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-3"
          >
            {ungrouped.map((card) => renderCard(card))}
          </ul>
        )}
      </section>

      {clusters.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          No clusters yet. Add one above.
        </p>
      ) : (
        <div className="grid min-w-0 grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {clusters.map((cluster) => {
            const form =
              openForm?.clusterId === cluster.clusterId ? openForm : null
            const cards = cluster.cardIds.flatMap((cardId) => {
              const card = cardsById.get(cardId)
              return card ? [card] : []
            })
            return (
              <ClusterSection
                key={cluster.clusterId}
                cluster={cluster}
                cards={cards}
                renderCard={(card, index) => {
                  let line: 'before' | 'after' | null = null
                  if (drag?.over === cluster.clusterId && drag.index !== null) {
                    if (drag.index === index) {
                      line = 'before'
                    } else if (
                      drag.index === cards.length &&
                      index === cards.length - 1
                    ) {
                      line = 'after'
                    }
                  }
                  return renderCard(card, line)
                }}
                dropTarget={dropHandlers}
                dropActive={drag?.over === cluster.clusterId}
                form={form}
                renamePending={renameMutation.isPending}
                deletePending={deleteMutation.isPending}
                onOpenRename={() => {
                  openRename(cluster)
                }}
                onOpenDelete={() => {
                  openDelete(cluster)
                }}
                onDraftChange={(draft) => {
                  if (form?.kind === 'rename') {
                    setOpenForm({ ...form, draft, error: null })
                  }
                }}
                onCancel={() => {
                  if (form !== null) {
                    cancel(form)
                  }
                }}
                onSaveRename={() => {
                  if (form !== null) {
                    saveRename(cluster, form)
                  }
                }}
                onConfirmDelete={() => {
                  confirmDelete(cluster)
                }}
              />
            )
          })}
        </div>
      )}
    </div>
  )
}
