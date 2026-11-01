import {
  useEffect,
  useId,
  useRef,
  useState,
  type FormEvent,
  type KeyboardEvent,
} from 'react'
import { toast } from 'sonner'
import { focusRing, wrapText } from '@/cards/CardForms'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import type { BoardCard, BoardCluster, CycleBoard } from './boardApi'
import { ClusterCardItem } from './BoardCards'
import { ungroupedCards } from './boardModel'
import {
  clusterErrorCodeOf,
  clusterErrorMessage,
  NAME_REQUIRED_MESSAGE,
  NAME_TAKEN_MESSAGE,
  NAME_TOO_LONG_MESSAGE,
  NAME_UNGROUPED_MESSAGE,
  type ClusterErrorCode,
  type ClusterOperation,
} from './clusterErrors'
import {
  useCreateCluster,
  useDeleteCluster,
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
      className="min-w-0 space-y-3 rounded-lg border bg-card p-4 text-card-foreground"
    >
      {header}
      {cards.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          No cards in this cluster yet.
        </p>
      ) : (
        <ul aria-label={`Cards in ${name}`} className="space-y-2">
          {cards.map((card) => (
            <ClusterCardItem key={card.cardId} card={card} />
          ))}
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
 * cluster with its Rename and Delete controls. Every member sees the same
 * controls. Nothing is optimistic: the lists change only when the board's
 * refetch returns, and a refetch never overwrites a draft being typed.
 */
export function ClusterMode({ board, onLostAccess }: ClusterModeProps) {
  const { cycleId, clusters } = board
  const createMutation = useCreateCluster(cycleId)
  const renameMutation = useRenameCluster(cycleId)
  const deleteMutation = useDeleteCluster(cycleId)

  const [newDraft, setNewDraft] = useState('')
  const [newError, setNewError] = useState<string | null>(null)
  const [openForm, setOpenForm] = useState<OpenForm | null>(null)
  const [announcement, setAnnouncement] = useState('')
  // A new object for every request, so the same target can be asked twice.
  const [focusTarget, setFocusTarget] = useState<FocusTarget | null>(null)

  // A synchronous second click or Enter must not send a second request.
  const createPendingRef = useRef(false)
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
  const ungrouped = ungroupedCards(board)

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

      <p role="status" className="sr-only">
        {announcement}
      </p>

      <section
        aria-labelledby="cluster-ungrouped-heading"
        className="min-w-0 space-y-3 rounded-lg border bg-card p-4 text-card-foreground"
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
            {ungrouped.map((card) => (
              <ClusterCardItem key={card.cardId} card={card} />
            ))}
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
