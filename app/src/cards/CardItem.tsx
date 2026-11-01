import { useEffect, useRef, useState } from 'react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import type { MyCard } from './cardsApi'
import { cardsErrorCodeOf } from './cardsErrors'
import { CardEditor, wrapText, type WriteErrorHandler } from './CardForms'
import { useDeleteCard } from './useCards'

const DELETE_CONFIRM_COPY = 'Delete this card? This cannot be undone.'

type Mode = 'view' | 'edit' | 'confirm-delete'
type FocusTarget = 'edit' | 'delete' | null

interface CardItemProps {
  readonly cycleId: string
  readonly card: MyCard
  /** For accessible names, e.g. "Start card 2". */
  readonly name: string
  readonly collecting: boolean
  readonly online: boolean
  readonly onWriteError: WriteErrorHandler
  readonly onCardGone: (text: string) => void
  readonly focusComposer: () => void
}

/** One of the member's own cards. No author name, email, or id is shown. */
export function CardItem({
  cycleId,
  card,
  name,
  collecting,
  online,
  onWriteError,
  onCardGone,
  focusComposer,
}: CardItemProps) {
  const [mode, setMode] = useState<Mode>('view')
  const deleteMutation = useDeleteCard(cycleId)
  const deletingRef = useRef(false)
  const editButtonRef = useRef<HTMLButtonElement | null>(null)
  const deleteButtonRef = useRef<HTMLButtonElement | null>(null)
  const cancelDeleteRef = useRef<HTMLButtonElement | null>(null)
  const focusTargetRef = useRef<FocusTarget>(null)

  useEffect(() => {
    if (mode === 'confirm-delete') {
      cancelDeleteRef.current?.focus()
      return
    }
    if (mode !== 'view') {
      return
    }
    const target = focusTargetRef.current
    focusTargetRef.current = null
    if (target === 'edit') {
      editButtonRef.current?.focus()
    } else if (target === 'delete') {
      deleteButtonRef.current?.focus()
    }
  }, [mode])

  const backToView = (target: FocusTarget) => {
    focusTargetRef.current = target
    setMode('view')
  }

  const deletePending = deleteMutation.isPending

  const confirmDelete = () => {
    if (deletingRef.current || !online || !collecting) {
      return
    }
    deletingRef.current = true
    deleteMutation
      .mutateAsync(card.id)
      .then(() => {
        toast.success('Card deleted.')
        focusComposer()
      })
      .catch((error: unknown) => {
        onWriteError(cardsErrorCodeOf(error), 'delete')
      })
      .finally(() => {
        deletingRef.current = false
      })
  }

  const cancelDelete = () => {
    if (!deletePending) {
      backToView('delete')
    }
  }

  const editing = mode === 'edit'
  // While collecting, the editor replaces the card. Out of collecting the
  // card is shown, and the editor keeps any unsaved text as "Not saved".
  const showCard = !(editing && collecting)

  return (
    <li className="min-w-0 space-y-2 rounded-md border bg-background p-3">
      {showCard ? (
        <div className="min-w-0 space-y-2">
          <p className={cn('text-sm whitespace-pre-wrap', wrapText)}>
            {card.text}
          </p>
          <p className="text-xs font-medium text-muted-foreground">
            {card.isAnonymous ? 'Anonymous' : 'Shows your name'}
          </p>
        </div>
      ) : null}

      {editing ? (
        <CardEditor
          cycleId={cycleId}
          card={card}
          name={name}
          collecting={collecting}
          online={online}
          onWriteError={onWriteError}
          onCardGone={onCardGone}
          onClose={() => {
            backToView('edit')
          }}
        />
      ) : null}

      {collecting && mode === 'view' ? (
        <div className="flex flex-wrap gap-2">
          <Button
            ref={editButtonRef}
            type="button"
            variant="outline"
            size="sm"
            aria-label={`Edit ${name}`}
            onClick={() => {
              setMode('edit')
            }}
          >
            Edit
          </Button>
          <Button
            ref={deleteButtonRef}
            type="button"
            variant="outline"
            size="sm"
            aria-label={`Delete ${name}`}
            onClick={() => {
              setMode('confirm-delete')
            }}
          >
            Delete
          </Button>
        </div>
      ) : null}

      {collecting && mode === 'confirm-delete' ? (
        <div
          role="group"
          aria-label={`Confirm deleting ${name}`}
          className="space-y-3 rounded-md border border-destructive/30 p-3"
          onKeyDown={(event) => {
            if (event.key === 'Escape') {
              event.preventDefault()
              cancelDelete()
            }
          }}
        >
          <p className="text-sm">{DELETE_CONFIRM_COPY}</p>
          <div className="flex flex-wrap gap-2">
            <Button
              ref={cancelDeleteRef}
              type="button"
              variant="outline"
              size="sm"
              disabled={deletePending}
              onClick={cancelDelete}
            >
              Cancel
            </Button>
            <Button
              type="button"
              variant="destructive"
              size="sm"
              disabled={deletePending || !online}
              onClick={confirmDelete}
            >
              {deletePending ? 'Deleting…' : 'Delete card'}
            </Button>
          </div>
        </div>
      ) : null}
    </li>
  )
}
