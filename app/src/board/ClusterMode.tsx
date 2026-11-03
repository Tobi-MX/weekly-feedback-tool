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
import { keepErrorCodeOf, keepErrorMessage } from './aiClusteringErrors'
import {
  AI_GENERATING_ANNOUNCEMENT,
  AI_REMOTE_ANNOUNCEMENT,
  aiBlockedReason,
  aiBoardCounts,
  AiSuggestions,
  keptAnnouncement,
} from './AiSuggestions'
import type { BoardCard, BoardCluster, CycleBoard } from './boardApi'
import { ClusterCardItem, ClusterHeading, wrapAnywhere } from './BoardCards'
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
  MERGE_TARGET_GONE_MESSAGE,
  mergeAnnouncement,
  mergeOptionLabel,
  mergeSummary,
  pruneSplitSelection,
  splitAnnouncement,
  splitCheckboxLabel,
  splitSelectionCount,
  trimClusterName,
  validateClusterName,
  validateSplit,
  type SplitError,
} from './clusterEdits'
import {
  clusterErrorCodeOf,
  clusterErrorMessage,
  moveErrorMessage,
  type ClusterErrorCode,
  type ClusterOperation,
} from './clusterErrors'
import { MoveMenu, useFinePointer } from './MoveMenu'
import {
  useCreateCluster,
  useDeleteCluster,
  useMergeClusters,
  useMoveCard,
  useRenameCluster,
  useSplitCluster,
} from './useClusters'
import {
  focusInAiPanel,
  useKeepAiClusters,
  type AiClusteringRun,
} from './useAiClustering'

/** The Cluster stage's intro for the facilitator, who edits the clusters. */
export const CLUSTER_INTRO =
  'Group related cards into clusters. Only you, as the facilitator, can change clusters until voting starts.'

/** The intro for everyone else, who sees the same board read-only (#19b). */
export const CLUSTER_READ_ONLY_INTRO =
  'The facilitator is grouping the cards into clusters. Changes appear here as they are made, until voting starts.'

const inputClass = cn(
  'block h-9 w-full min-w-0 rounded-md border border-input bg-background px-3 py-1 text-sm aria-invalid:border-destructive',
  focusRing,
)

const selectClass = cn(
  'block h-9 w-full max-w-full min-w-0 truncate rounded-md border border-input bg-background px-3 py-1 text-sm',
  focusRing,
)

/** The form a cluster has open. */
type ClusterForm =
  | {
      readonly kind: 'rename'
      readonly clusterId: string
      readonly draft: string
      readonly error: string | null
    }
  | { readonly kind: 'delete'; readonly clusterId: string }
  | {
      readonly kind: 'merge'
      /** The source: the cluster that is merged away. */
      readonly clusterId: string
      /** The chosen target, by id, so a rename keeps the choice. */
      readonly targetId: string
      /** The chosen target disappeared and the choice was reset. */
      readonly targetGone: boolean
    }
  | {
      readonly kind: 'split'
      readonly clusterId: string
      /** The checked cards; it exists only while the form is open. */
      readonly selected: readonly string[]
      readonly draft: string
      readonly error: SplitError | null
    }

/** A confirmation open in the AI suggestions panel (#21). */
type PanelForm = { readonly kind: 'ai-run' } | { readonly kind: 'ai-keep' }

/**
 * The one form open on the board: a cluster's form or a panel confirmation.
 * Opening one closes any other.
 */
type OpenForm = ClusterForm | PanelForm

function clusterFormOf(form: OpenForm | null): ClusterForm | null {
  return form === null || form.kind === 'ai-run' || form.kind === 'ai-keep'
    ? null
    : form
}

/** Where focus goes after the next render. */
type FocusTarget =
  | { readonly kind: 'new-input' }
  /** The panel's main button, else Keep, else the mode heading. */
  | { readonly kind: 'ai-main' }
  | { readonly kind: 'ai-keep' }
  | { readonly kind: 'ai-cancel' }
  | {
      readonly kind:
        | 'rename-button'
        | 'delete-button'
        | 'merge-button'
        | 'split-button'
        | 'rename-input'
        | 'delete-cancel'
        | 'merge-select'
        | 'split-checkbox'
      readonly clusterId: string
    }

/** The button that opened each form, where Escape and Cancel return. */
const OPENER: Record<
  ClusterForm['kind'],
  Exclude<
    FocusTarget['kind'],
    'new-input' | 'ai-main' | 'ai-keep' | 'ai-cancel'
  >
> = {
  rename: 'rename-button',
  delete: 'delete-button',
  merge: 'merge-button',
  split: 'split-button',
}

/** A merge or split request in flight, and the form that sent it. */
interface BusyForm {
  readonly kind: 'merge' | 'split'
  readonly clusterId: string
}

/** A cluster whose Rename button gets focus once the board shows it. */
interface SuccessFocus {
  readonly clusterId: string
}

function focusSelector(target: FocusTarget): string | null {
  switch (target.kind) {
    case 'new-input':
      return null
    case 'ai-main':
      return '[data-ai-focus="main"], [data-ai-focus="keep"]'
    case 'ai-keep':
      return '[data-ai-focus="keep"]'
    case 'ai-cancel':
      return '[data-ai-focus="cancel"]'
    default:
      return `[data-cluster-focus="${target.kind}:${target.clusterId}"]`
  }
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

/**
 * Whether focus belongs to the cluster controls: on one of them (inside the
 * cluster board, where only controls are focusable, or in an open Move menu,
 * which renders in a portal), or lost to <body> or nowhere. A browser blurs a
 * button to <body> when it becomes disabled while its request is pending
 * (Delete cluster, Merge clusters, Add cluster), so <body> counts as lost
 * from the controls, as #94's rule treats it. Focus on any other element
 * that still exists is the user's choice and is left alone.
 */
function focusInClusterControls(): boolean {
  const active = document.activeElement
  if (active === null || active === document.body || !active.isConnected) {
    return true
  }
  return (
    active.closest('[data-testid="cluster-board"], [data-move-menu]') !== null
  )
}

/** The board's mode heading, where focus goes when the controls vanish. */
const MODE_HEADING_ID = 'board-mode-heading'

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
    <p
      id={id}
      role="alert"
      className={cn('text-sm text-destructive', wrapAnywhere)}
    >
      {text}
    </p>
  )
}

interface ClusterSectionProps {
  /** False for everyone but the facilitator: no control, no drop target. */
  readonly editable: boolean
  readonly cluster: BoardCluster
  readonly cards: readonly BoardCard[]
  readonly renderCard: (
    card: BoardCard,
    index: number,
    selectControl: ReactNode,
  ) => ReactNode
  readonly dropTarget: DropTargetProps
  readonly dropActive: boolean
  readonly form: ClusterForm | null
  /** Every other cluster in board order: the merge targets. */
  readonly otherClusters: readonly BoardCluster[]
  readonly renamePending: boolean
  readonly deletePending: boolean
  readonly mergePending: boolean
  readonly splitPending: boolean
  /** A card move is pending: merge and split submit do nothing. */
  readonly writeBlocked: boolean
  readonly onOpenRename: () => void
  readonly onOpenDelete: () => void
  readonly onOpenMerge: () => void
  readonly onOpenSplit: () => void
  readonly onDraftChange: (draft: string) => void
  readonly onCancel: () => void
  readonly onSaveRename: () => void
  readonly onConfirmDelete: () => void
  readonly onTargetChange: (targetId: string) => void
  readonly onConfirmMerge: () => void
  readonly onToggleCard: (cardId: string) => void
  readonly onSubmitSplit: () => void
}

function ClusterSection({
  editable,
  cluster,
  cards,
  renderCard,
  dropTarget,
  dropActive,
  form,
  otherClusters,
  renamePending,
  deletePending,
  mergePending,
  splitPending,
  writeBlocked,
  onOpenRename,
  onOpenDelete,
  onOpenMerge,
  onOpenSplit,
  onDraftChange,
  onCancel,
  onSaveRename,
  onConfirmDelete,
  onTargetChange,
  onConfirmMerge,
  onToggleCard,
  onSubmitSplit,
}: ClusterSectionProps) {
  const baseId = useId()
  const headingId = `${baseId}-heading`
  const inputId = `${baseId}-name`
  const errorId = `${baseId}-error`
  const selectId = `${baseId}-merge-target`
  const goneId = `${baseId}-merge-gone`
  const splitInputId = `${baseId}-split-name`
  const splitCountId = `${baseId}-split-count`
  const splitErrorId = `${baseId}-split-error`
  const { clusterId, name } = cluster
  const splitForm = form?.kind === 'split' ? form : null
  const selected = new Set(splitForm?.selected ?? [])

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
      <ClusterHeading
        id={headingId}
        cluster={cluster}
        cardCount={cards.length}
      />
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
  } else if (form?.kind === 'merge') {
    const target =
      otherClusters.find((other) => other.clusterId === form.targetId) ?? null
    controls = (
      <div
        role="group"
        aria-label={`Merge cluster ${name}`}
        data-cluster-form={`merge:${clusterId}`}
        className="min-w-0 space-y-3 rounded-md border p-3"
        onKeyDown={onEscape(mergePending)}
      >
        <div className="min-w-0 space-y-1">
          <label
            htmlFor={selectId}
            className={cn('block text-sm font-medium', wrapAnywhere)}
          >
            Merge into
          </label>
          <select
            id={selectId}
            value={form.targetId}
            data-cluster-focus={`merge-select:${clusterId}`}
            aria-describedby={form.targetGone ? goneId : undefined}
            className={selectClass}
            onChange={(event) => {
              onTargetChange(event.target.value)
            }}
          >
            {otherClusters.map((other) => (
              <option
                key={other.clusterId}
                value={other.clusterId}
                className="[overflow-wrap:anywhere] whitespace-normal"
              >
                {mergeOptionLabel(other)}
              </option>
            ))}
          </select>
        </div>
        {form.targetGone ? (
          <InlineError id={goneId} text={MERGE_TARGET_GONE_MESSAGE} />
        ) : null}
        {target === null ? null : (
          <p className={cn('text-sm', wrapAnywhere)}>
            {mergeSummary(cluster, target)}
          </p>
        )}
        <div className="flex flex-wrap gap-2">
          <Button
            type="button"
            variant="outline"
            disabled={mergePending}
            onClick={onCancel}
          >
            Cancel
          </Button>
          <Button
            type="button"
            disabled={mergePending}
            aria-disabled={writeBlocked ? 'true' : undefined}
            className="aria-disabled:opacity-50"
            onClick={onConfirmMerge}
          >
            {mergePending ? 'Merging…' : 'Merge clusters'}
          </Button>
        </div>
      </div>
    )
  } else if (splitForm !== null) {
    const nameError = splitForm.error?.field === 'name'
    controls = (
      <form
        aria-label={`Split cluster ${name}`}
        data-cluster-form={`split:${clusterId}`}
        noValidate
        className="min-w-0 space-y-2 rounded-md border p-3"
        onKeyDown={onEscape(splitPending)}
        onSubmit={(event: FormEvent) => {
          event.preventDefault()
          onSubmitSplit()
        }}
      >
        <label
          htmlFor={splitInputId}
          className={cn('block text-sm font-medium', wrapAnywhere)}
        >
          New cluster name
        </label>
        <input
          id={splitInputId}
          type="text"
          autoComplete="off"
          value={splitForm.draft}
          aria-invalid={nameError ? 'true' : undefined}
          aria-describedby={nameError ? splitErrorId : undefined}
          className={inputClass}
          onChange={(event) => {
            onDraftChange(event.target.value)
          }}
        />
        <p id={splitCountId} className="text-sm text-muted-foreground">
          {splitSelectionCount(splitForm.selected.length, cards.length)}
        </p>
        {splitForm.error === null ? null : (
          <InlineError id={splitErrorId} text={splitForm.error.message} />
        )}
        <div className="flex flex-wrap gap-2">
          <Button
            type="button"
            variant="outline"
            disabled={splitPending}
            onClick={onCancel}
          >
            Cancel
          </Button>
          <Button
            type="submit"
            disabled={splitPending}
            aria-disabled={writeBlocked ? 'true' : undefined}
            aria-describedby={
              splitForm.error === null
                ? splitCountId
                : `${splitCountId} ${splitErrorId}`
            }
            className="aria-disabled:opacity-50"
          >
            {splitPending ? 'Splitting…' : 'Split into new cluster'}
          </Button>
        </div>
      </form>
    )
  } else if (form === null && editable) {
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
        {otherClusters.length === 0 ? null : (
          <Button
            type="button"
            variant="outline"
            size="sm"
            aria-label={`Merge cluster ${name}`}
            data-cluster-focus={`merge-button:${clusterId}`}
            onClick={onOpenMerge}
          >
            Merge
          </Button>
        )}
        {cards.length < 2 ? null : (
          <Button
            type="button"
            variant="outline"
            size="sm"
            aria-label={`Split cluster ${name}`}
            data-cluster-focus={`split-button:${clusterId}`}
            onClick={onOpenSplit}
          >
            Split
          </Button>
        )}
      </div>
    )
  }

  return (
    <section
      aria-labelledby={form?.kind === 'rename' ? undefined : headingId}
      aria-label={form?.kind === 'rename' ? name : undefined}
      data-drop-target={editable ? clusterId : undefined}
      className={cn(
        'min-w-0 space-y-3 rounded-lg border bg-card p-4 text-card-foreground',
        editable && dropActive && 'ring-2 ring-primary',
      )}
      {...(editable ? dropTarget : {})}
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
          {cards.map((card, index) =>
            renderCard(
              card,
              index,
              splitForm === null ? null : (
                <input
                  type="checkbox"
                  aria-label={splitCheckboxLabel(card)}
                  checked={selected.has(card.cardId)}
                  data-split-of={clusterId}
                  data-cluster-focus={
                    index === 0 ? `split-checkbox:${clusterId}` : undefined
                  }
                  className={cn('size-6 shrink-0 accent-primary', focusRing)}
                  onChange={() => {
                    onToggleCard(card.cardId)
                  }}
                  onKeyDown={onEscape(splitPending)}
                />
              ),
            ),
          )}
        </ul>
      )}
      {controls}
    </section>
  )
}

export interface ClusterModeProps {
  readonly board: CycleBoard
  /**
   * Whether the caller is the project's current facilitator, from their own
   * member row (#19b). False while the members query loads or has failed.
   * Only the facilitator gets controls; everyone else sees the same board
   * read-only. The server enforces the rule; this only hides the controls.
   */
  readonly isFacilitator: boolean
  /** Called when a write says the caller is no longer a member. */
  readonly onLostAccess: () => void
  /** Called when a write says the caller is not the facilitator. */
  readonly onNotFacilitator: () => void
  /**
   * The page's AI clustering request (#21). It lives above this view, so a
   * request survives a stage change.
   */
  readonly ai: AiClusteringRun
}

/**
 * The Cluster stage: the "New cluster" form, the ungrouped cards, and every
 * cluster with its Rename and Delete controls, and every card with its Move
 * menu and, on fine pointers, native drag (#18). Only the facilitator gets
 * the controls (#19b); everyone else sees the same sections, names, counts,
 * and cards with no control at all. Cluster writes are not optimistic: they show when the board's
 * refetch returns, and a refetch never overwrites a draft being typed. A card
 * move is the one optimistic write: the pending move is drawn over the server
 * board until the refetch after it is in.
 */
export function ClusterMode({
  board,
  isFacilitator,
  onLostAccess,
  onNotFacilitator,
  ai,
}: ClusterModeProps) {
  const { cycleId } = board
  const finePointer = useFinePointer()
  const mover = useMoveCard(cycleId, (error) => {
    const code = clusterErrorCodeOf(error)
    const message = moveErrorMessage(code)
    if (message === null) {
      onLostAccess()
    } else {
      toast.error(message)
    }
    if (code === 'not_project_facilitator') {
      onNotFacilitator()
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
  const mergeMutation = useMergeClusters(cycleId)
  const splitMutation = useSplitCluster(cycleId)
  const keepMutation = useKeepAiClusters(cycleId)
  // One board write at a time: while a merge or split is pending, no card
  // moves; while a move is pending, merge and split send nothing.
  const clusterWritePending = mergeMutation.isPending || splitMutation.isPending

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
  const mergePendingRef = useRef(false)
  const splitPendingRef = useRef(false)
  const keepPendingRef = useRef(false)
  // A focus request for the AI panel after a run's or a keep's result.
  const [panelFocus, setPanelFocus] = useState<object | null>(null)
  // The form whose merge or split is in flight. Its refetched board may
  // already show the result (the source gone, the cluster down to one card)
  // before the request settles; the form's own success handles that, so the
  // refetch rules below wait for it.
  const [busyForm, setBusyForm] = useState<BusyForm | null>(null)
  const [successFocus, setSuccessFocus] = useState<SuccessFocus | null>(null)
  const handledSuccessFocusRef = useRef<SuccessFocus | null>(null)
  const rootRef = useRef<HTMLDivElement>(null)
  const newInputRef = useRef<HTMLInputElement>(null)
  const newInputId = useId()
  const newErrorId = useId()

  // The role the controls were last drawn for. When it is lost, every open
  // form, draft, menu, and drag closes; a pending write is left to the
  // server. Focus moves to the mode heading only if it was on a control that
  // disappears. Gaining the role moves no focus.
  const [shownRole, setShownRole] = useState(isFacilitator)
  const [headingFocus, setHeadingFocus] = useState<object | null>(null)
  if (shownRole !== isFacilitator) {
    setShownRole(isFacilitator)
    setFocusTarget(null)
    setSuccessFocus(null)
    setMoveFocus(null)
    if (!isFacilitator) {
      setOpenForm(null)
      setNewDraft('')
      setNewError(null)
      setOpenMenu(null)
      setDrag(null)
      if (focusInClusterControls()) {
        setHeadingFocus({})
      }
    }
  }

  useEffect(() => {
    if (headingFocus === null) {
      return
    }
    const active = document.activeElement
    if (active === null || active === document.body) {
      document.getElementById(MODE_HEADING_ID)?.focus()
    }
  }, [headingFocus])

  const clusterForm = clusterFormOf(openForm)
  const formBusy =
    clusterForm !== null &&
    busyForm !== null &&
    busyForm.kind === clusterForm.kind &&
    busyForm.clusterId === clusterForm.clusterId
  if (clusterForm !== null && !formBusy) {
    const openForm = clusterForm
    const own = clusters.find(
      (cluster) => cluster.clusterId === openForm.clusterId,
    )
    if (own === undefined) {
      // The cluster whose form is open disappeared from the refreshed board
      // (a delete or merge by anyone): close the form and move focus to the
      // new-cluster input.
      setOpenForm(null)
      setFocusTarget({ kind: 'new-input' })
    } else if (openForm.kind === 'merge') {
      const others = clusters.filter(
        (cluster) => cluster.clusterId !== own.clusterId,
      )
      if (others.length === 0) {
        setOpenForm(null)
        setFocusTarget({ kind: 'new-input' })
      } else if (
        !others.some((cluster) => cluster.clusterId === openForm.targetId)
      ) {
        setOpenForm({
          ...openForm,
          targetId: others[0].clusterId,
          targetGone: true,
        })
      }
    } else if (openForm.kind === 'split') {
      if (own.cardIds.length < 2) {
        setOpenForm(null)
        setFocusTarget({ kind: 'rename-button', clusterId: own.clusterId })
      } else {
        // A selected card that left drops out; one that arrived is unchecked.
        const pruned = pruneSplitSelection(own, openForm.selected)
        if (pruned.length !== openForm.selected.length) {
          setOpenForm({ ...openForm, selected: pruned })
        }
      }
    }
  }

  // The AI panel's counts come from the latest server board (#21).
  const aiCounts = aiBoardCounts(board)
  const aiTriggerShown = aiBlockedReason(aiCounts, ai.limitReached) === null
  // A refetch can take away what a panel confirmation offers (a run no longer
  // allowed, no suggestion left to keep): close it, and move focus back into
  // the panel only if it was there (#94's rule).
  if (
    (openForm?.kind === 'ai-run' && (!aiTriggerShown || ai.pending)) ||
    (openForm?.kind === 'ai-keep' &&
      aiCounts.aiClusters === 0 &&
      !keepMutation.isPending)
  ) {
    setOpenForm(null)
    if (focusInAiPanel()) {
      setFocusTarget({ kind: 'ai-main' })
    }
  }

  // Announce AI suggestions that arrive from a run this tab did not start
  // (#21): a refetch that brings an AI cluster id not seen before. The first
  // load, an unchanged refetch, and a keep (ids disappear) announce nothing.
  // While this tab's own run is pending its new ids are taken in silently;
  // that run announces its own result.
  const aiIds = board.clusters
    .filter((cluster) => cluster.source === 'ai')
    .map((cluster) => cluster.clusterId)
  const [seenAiIds, setSeenAiIds] = useState<ReadonlySet<string>>(
    () => new Set(aiIds),
  )
  const unseenAiIds = aiIds.filter((id) => !seenAiIds.has(id))
  if (unseenAiIds.length > 0) {
    setSeenAiIds(new Set([...seenAiIds, ...unseenAiIds]))
    if (!ai.pending) {
      setAnnouncement(AI_REMOTE_ANNOUNCEMENT)
    }
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

  // After a merge or split, focus the target's or new cluster's Rename button
  // once the refetched board shows it, and only if focus was still in the
  // form that started it or on <body> (#94's rule).
  useEffect(() => {
    if (
      successFocus === null ||
      handledSuccessFocusRef.current === successFocus
    ) {
      return
    }
    const button = rootRef.current?.querySelector<HTMLElement>(
      `[data-cluster-focus="rename-button:${successFocus.clusterId}"]`,
    )
    if (button === null || button === undefined) {
      return
    }
    handledSuccessFocusRef.current = successFocus
    const active = document.activeElement
    if (active === null || active === document.body) {
      button.focus()
    }
  }, [successFocus, clusters])

  useEffect(() => {
    if (focusTarget === null) {
      return
    }
    const selector = focusSelector(focusTarget)
    const element =
      selector === null
        ? newInputRef.current
        : rootRef.current?.querySelector<HTMLElement>(selector)
    if (element !== null && element !== undefined) {
      element.focus()
    } else if (focusTarget.kind === 'ai-main') {
      document.getElementById(MODE_HEADING_ID)?.focus()
    }
  }, [focusTarget])

  // The page's AI request reports back here while this view is mounted: its
  // announcements use this view's status region, and its focus rule needs
  // to know whether the panel is shown.
  const isFacilitatorRef = useRef(isFacilitator)
  useEffect(() => {
    isFacilitatorRef.current = isFacilitator
  }, [isFacilitator])
  const { attach } = ai
  useEffect(
    () =>
      attach({
        announce: (text) => {
          setAnnouncementState((current) => ({ text, id: current.id + 1 }))
        },
        markAiIdsSeen: (ids) => {
          setSeenAiIds((current) =>
            ids.every((id) => current.has(id))
              ? current
              : new Set([...current, ...ids]),
          )
        },
        panelShown: () => isFacilitatorRef.current,
        requestPanelFocus: () => {
          setPanelFocus({})
        },
      }),
    [attach],
  )

  // After a run's or a keep's result, when focus was still in the panel or
  // lost to <body> (#94's rule): the panel's main button, else Keep, else the
  // mode heading when the panel is gone.
  useEffect(() => {
    if (panelFocus === null) {
      return
    }
    const root = rootRef.current
    const target =
      root?.querySelector<HTMLElement>('[data-ai-focus="main"]') ??
      root?.querySelector<HTMLElement>('[data-ai-focus="keep"]') ??
      document.getElementById(MODE_HEADING_ID)
    target?.focus()
  }, [panelFocus])

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
    if (
      ai.isPending() ||
      movePendingRef.current ||
      mergePendingRef.current ||
      splitPendingRef.current ||
      isNoOpMove(displayed, move)
    ) {
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
      if (
        !carriesCard(event) ||
        ai.isPending() ||
        movePendingRef.current ||
        mergePendingRef.current ||
        splitPendingRef.current
      ) {
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

  const canDrag =
    isFacilitator &&
    finePointer &&
    !mover.isPending &&
    !clusterWritePending &&
    !ai.pending

  const renderCard = (
    card: BoardCard,
    dropLine: 'before' | 'after' | null = null,
    selectControl: ReactNode = null,
  ) => {
    const items: readonly MoveMenuItem[] = moveMenuItems(displayed, card.cardId)
    return (
      <ClusterCardItem
        key={card.cardId}
        card={card}
        draggable={canDrag}
        dropLine={dropLine}
        selectControl={selectControl}
        onDragStart={(event) => {
          if (
            ai.isPending() ||
            movePendingRef.current ||
            mergePendingRef.current ||
            splitPendingRef.current
          ) {
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
          !isFacilitator || items.length === 0 ? null : (
            <MoveMenu
              cardId={card.cardId}
              label={moveButtonLabel(card)}
              items={items}
              open={openMenu?.cardId === card.cardId}
              blocked={mover.isPending || clusterWritePending || ai.pending}
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
    if (code === 'not_project_facilitator') {
      onNotFacilitator()
    }
    return code
  }

  /** Closes the form only if it is still the one for this cluster. */
  const closeFormOf = (kind: ClusterForm['kind'], clusterId: string) => {
    setOpenForm((current) => {
      const form = clusterFormOf(current)
      return form?.kind === kind && form.clusterId === clusterId
        ? null
        : current
    })
  }

  const submitNew = (event: FormEvent) => {
    event.preventDefault()
    if (createPendingRef.current || ai.isPending()) {
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

  const openMerge = (cluster: BoardCluster) => {
    const first = clusters.find(
      (other) => other.clusterId !== cluster.clusterId,
    )
    if (first === undefined) {
      return
    }
    setOpenForm({
      kind: 'merge',
      clusterId: cluster.clusterId,
      targetId: first.clusterId,
      targetGone: false,
    })
    setFocusTarget({ kind: 'merge-select', clusterId: cluster.clusterId })
  }

  const openSplit = (cluster: BoardCluster) => {
    setOpenForm({
      kind: 'split',
      clusterId: cluster.clusterId,
      selected: [],
      draft: '',
      error: null,
    })
    setFocusTarget({ kind: 'split-checkbox', clusterId: cluster.clusterId })
  }

  const cancel = (form: ClusterForm) => {
    setOpenForm(null)
    setFocusTarget({ kind: OPENER[form.kind], clusterId: form.clusterId })
  }

  /** Whether focus is still in the form that started a merge or split. */
  const focusInForm = (kind: BusyForm['kind'], clusterId: string) => {
    const active = document.activeElement
    if (active === null || active === document.body) {
      return true
    }
    return (
      active.closest(`[data-cluster-form="${kind}:${clusterId}"]`) !== null ||
      (kind === 'split' &&
        active.closest(`[data-split-of="${clusterId}"]`) !== null)
    )
  }

  const confirmMerge = (cluster: BoardCluster, form: OpenForm) => {
    if (
      form.kind !== 'merge' ||
      ai.isPending() ||
      mergePendingRef.current ||
      movePendingRef.current
    ) {
      return
    }
    const { clusterId, name: sourceName } = cluster
    const target = clusters.find(
      (other) =>
        other.clusterId === form.targetId && other.clusterId !== clusterId,
    )
    if (target === undefined) {
      return
    }
    mergePendingRef.current = true
    setBusyForm({ kind: 'merge', clusterId })
    mergeMutation
      .mutateAsync({
        sourceClusterId: clusterId,
        targetClusterId: target.clusterId,
      })
      .then((saved) => {
        const keepFocus = focusInForm('merge', clusterId)
        setBusyForm(null)
        closeFormOf('merge', clusterId)
        setAnnouncement(mergeAnnouncement(sourceName, saved.name))
        if (keepFocus) {
          setSuccessFocus({ clusterId: saved.clusterId })
        }
      })
      .catch((error: unknown) => {
        setBusyForm(null)
        const code = reportError(error, 'merge')
        if (code === 'cycle_not_clustering') {
          closeFormOf('merge', clusterId)
        }
      })
      .finally(() => {
        mergePendingRef.current = false
      })
  }

  const toggleCard = (
    cluster: BoardCluster,
    form: OpenForm,
    cardId: string,
  ) => {
    if (form.kind !== 'split') {
      return
    }
    const next = form.selected.includes(cardId)
      ? form.selected.filter((id) => id !== cardId)
      : pruneSplitSelection(cluster, [...form.selected, cardId])
    setOpenForm({ ...form, selected: next, error: null })
  }

  const submitSplit = (cluster: BoardCluster, form: OpenForm) => {
    if (
      form.kind !== 'split' ||
      ai.isPending() ||
      splitPendingRef.current ||
      movePendingRef.current
    ) {
      return
    }
    const { clusterId } = cluster
    const checked = validateSplit(cluster, form.selected, form.draft, clusters)
    if ('error' in checked) {
      setOpenForm({ ...form, error: checked.error })
      return
    }
    // The cluster's displayed order, never the order the boxes were checked.
    const cardIds = pruneSplitSelection(cluster, form.selected)
    setOpenForm({ ...form, error: null })
    splitPendingRef.current = true
    setBusyForm({ kind: 'split', clusterId })
    splitMutation
      .mutateAsync({ clusterId, cardIds, name: checked.name })
      .then((saved) => {
        const keepFocus = focusInForm('split', clusterId)
        setBusyForm(null)
        closeFormOf('split', clusterId)
        setAnnouncement(splitAnnouncement(cardIds.length, saved.name))
        if (keepFocus) {
          setSuccessFocus({ clusterId: saved.clusterId })
        }
      })
      .catch((error: unknown) => {
        setBusyForm(null)
        const code = reportError(error, 'split')
        if (code === 'cycle_not_clustering') {
          closeFormOf('split', clusterId)
        }
      })
      .finally(() => {
        splitPendingRef.current = false
      })
  }

  const saveRename = (cluster: BoardCluster, form: OpenForm) => {
    if (form.kind !== 'rename' || renamePendingRef.current || ai.isPending()) {
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
    if (deletePendingRef.current || ai.isPending()) {
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

  /** Whether any cluster write or keep of this view is in flight. */
  const anyWritePending = () =>
    createPendingRef.current ||
    renamePendingRef.current ||
    deletePendingRef.current ||
    movePendingRef.current ||
    mergePendingRef.current ||
    splitPendingRef.current ||
    keepPendingRef.current

  const openAiConfirmation = (kind: PanelForm['kind']) => {
    if (ai.isPending()) {
      return
    }
    setOpenForm({ kind })
    setFocusTarget({ kind: 'ai-cancel' })
  }

  const cancelAiConfirmation = () => {
    const kind = openForm?.kind
    setOpenForm(null)
    setFocusTarget({ kind: kind === 'ai-keep' ? 'ai-keep' : 'ai-main' })
  }

  /**
   * Sends one AI request (#21). Confirming and Try again both come here;
   * nothing is sent while a run, a cluster write, or a keep is in flight.
   */
  const startAiRun = () => {
    if (anyWritePending() || !ai.start()) {
      return
    }
    setOpenForm((current) => (current?.kind === 'ai-run' ? null : current))
    setAnnouncement(AI_GENERATING_ANNOUNCEMENT)
    setFocusTarget({ kind: 'ai-main' })
  }

  /** Keep (#21): every AI cluster becomes manual; not optimistic. */
  const confirmKeep = () => {
    if (anyWritePending() || ai.isPending()) {
      return
    }
    keepPendingRef.current = true
    keepMutation
      .mutateAsync()
      .then((kept) => {
        const moveFocus = focusInAiPanel()
        setOpenForm((current) => (current?.kind === 'ai-keep' ? null : current))
        setAnnouncement(keptAnnouncement(kept))
        if (moveFocus) {
          setPanelFocus({})
        }
      })
      .catch((error: unknown) => {
        const moveFocus = focusInAiPanel()
        const code = keepErrorCodeOf(error)
        const message = keepErrorMessage(code)
        setOpenForm((current) => (current?.kind === 'ai-keep' ? null : current))
        if (message === null) {
          onLostAccess()
        } else {
          toast.error(message)
        }
        if (code === 'not_project_facilitator') {
          onNotFacilitator()
        }
        if (moveFocus) {
          setPanelFocus({})
        }
      })
      .finally(() => {
        keepPendingRef.current = false
      })
  }

  const createPending = createMutation.isPending

  return (
    <div
      ref={rootRef}
      data-testid="cluster-board"
      className="min-w-0 space-y-4"
    >
      {isFacilitator ? (
        <AiSuggestions
          counts={aiCounts}
          confirmation={
            openForm?.kind === 'ai-run'
              ? 'run'
              : openForm?.kind === 'ai-keep'
                ? 'keep'
                : null
          }
          pending={ai.pending}
          keepPending={keepMutation.isPending}
          alert={ai.alert}
          limitReached={ai.limitReached}
          onOpenRun={() => {
            openAiConfirmation('ai-run')
          }}
          onOpenKeep={() => {
            openAiConfirmation('ai-keep')
          }}
          onCancel={cancelAiConfirmation}
          onConfirmRun={startAiRun}
          onConfirmKeep={confirmKeep}
          onTryAgain={startAiRun}
        />
      ) : null}

      {isFacilitator ? (
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
      ) : null}

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
        data-drop-target={isFacilitator ? UNGROUPED_TARGET : undefined}
        className={cn(
          'min-w-0 space-y-3 rounded-lg border bg-card p-4 text-card-foreground',
          isFacilitator &&
            drag?.over === UNGROUPED_TARGET &&
            'ring-2 ring-primary',
        )}
        {...(isFacilitator ? dropHandlers : {})}
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
          {isFacilitator
            ? 'No clusters yet. Add one above.'
            : 'No clusters yet.'}
        </p>
      ) : (
        <div className="grid min-w-0 grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {clusters.map((cluster) => {
            const form =
              clusterForm?.clusterId === cluster.clusterId ? clusterForm : null
            const cards = cluster.cardIds.flatMap((cardId) => {
              const card = cardsById.get(cardId)
              return card ? [card] : []
            })
            return (
              <ClusterSection
                key={cluster.clusterId}
                editable={isFacilitator}
                cluster={cluster}
                cards={cards}
                renderCard={(card, index, selectControl) => {
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
                  return renderCard(card, line, selectControl)
                }}
                dropTarget={dropHandlers}
                dropActive={drag?.over === cluster.clusterId}
                form={form}
                otherClusters={clusters.filter(
                  (other) => other.clusterId !== cluster.clusterId,
                )}
                renamePending={renameMutation.isPending}
                deletePending={deleteMutation.isPending}
                mergePending={mergeMutation.isPending}
                splitPending={splitMutation.isPending}
                writeBlocked={mover.isPending}
                onOpenRename={() => {
                  openRename(cluster)
                }}
                onOpenDelete={() => {
                  openDelete(cluster)
                }}
                onOpenMerge={() => {
                  openMerge(cluster)
                }}
                onOpenSplit={() => {
                  openSplit(cluster)
                }}
                onDraftChange={(draft) => {
                  if (form?.kind === 'rename' || form?.kind === 'split') {
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
                onTargetChange={(targetId) => {
                  if (form?.kind === 'merge') {
                    setOpenForm({ ...form, targetId, targetGone: false })
                  }
                }}
                onConfirmMerge={() => {
                  if (form !== null) {
                    confirmMerge(cluster, form)
                  }
                }}
                onToggleCard={(cardId) => {
                  if (form !== null) {
                    toggleCard(cluster, form, cardId)
                  }
                }}
                onSubmitSplit={() => {
                  if (form !== null) {
                    submitSplit(cluster, form)
                  }
                }}
              />
            )
          })}
        </div>
      )}
    </div>
  )
}
