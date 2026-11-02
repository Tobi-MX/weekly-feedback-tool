import type { DragEvent, ReactNode } from 'react'
import { wrapText } from '@/cards/CardForms'
import { CARD_CATEGORIES, cardCategoryLabel } from '@/cards/cardCategories'
import { cn } from '@/lib/utils'
import type { BoardCard } from './boardApi'
import { boardCardLabel } from './boardModel'

/**
 * One card: its text and its label, both as text. Nothing else is rendered,
 * so an anonymous card's DOM is the same for every viewer.
 */
function BoardCardItem({ card }: { card: BoardCard }) {
  return (
    <li className="min-w-0 space-y-1 rounded-md border p-3">
      <p className={`text-sm ${wrapText}`}>{card.text}</p>
      <p className={`text-xs text-muted-foreground ${wrapText}`}>
        {boardCardLabel(card)}
      </p>
    </li>
  )
}

export interface ClusterCardItemProps {
  readonly card: BoardCard
  /** The card's Move menu (#18), or nothing when it has nowhere to go. */
  readonly moveControl?: ReactNode
  /** Native drag, on fine pointers only and never while a move is pending. */
  readonly draggable?: boolean
  /** Where the 2 px insertion line shows while a card is dragged over. */
  readonly dropLine?: 'before' | 'after' | null
  readonly onDragStart?: (event: DragEvent<HTMLLIElement>) => void
  readonly onDragEnd?: () => void
  /** The split form's checkbox (#19), before the card's text. */
  readonly selectControl?: ReactNode
}

/**
 * One card on the Cluster board: its category, text, and label, all as text,
 * and its Move control. An anonymous card's DOM is the same for every viewer,
 * inside a cluster or not. Nothing says who moved a card.
 */
export function ClusterCardItem({
  card,
  moveControl,
  draggable = false,
  dropLine = null,
  onDragStart,
  onDragEnd,
  selectControl = null,
}: ClusterCardItemProps) {
  return (
    <li
      data-card-id={card.cardId}
      data-drop-line={dropLine ?? undefined}
      draggable={draggable ? true : undefined}
      onDragStart={draggable ? onDragStart : undefined}
      onDragEnd={draggable ? onDragEnd : undefined}
      className={cn(
        'relative flex min-w-0 items-start gap-2 rounded-md border bg-card p-3',
        draggable && 'cursor-grab active:cursor-grabbing',
        dropLine === 'before' &&
          'before:absolute before:inset-x-0 before:-top-1.5 before:h-0.5 before:rounded before:bg-primary',
        dropLine === 'after' &&
          'after:absolute after:inset-x-0 after:-bottom-1.5 after:h-0.5 after:rounded after:bg-primary',
      )}
    >
      {selectControl}
      <div className="min-w-0 flex-1 space-y-1">
        <p className="text-xs font-medium text-muted-foreground">
          {cardCategoryLabel(card.category)}
        </p>
        <p className={`text-sm ${wrapText}`}>{card.text}</p>
        <p className={`text-xs text-muted-foreground ${wrapText}`}>
          {boardCardLabel(card)}
        </p>
      </div>
      {moveControl}
    </li>
  )
}

/**
 * The read-only card list in Start, Stop, Continue order. Each section takes
 * the response's cards of its category in the response's order: a filter,
 * never a sort.
 */
export function BoardCardList({ cards }: { cards: readonly BoardCard[] }) {
  if (cards.length === 0) {
    return (
      <p className="text-sm text-muted-foreground">
        No feedback was submitted for this cycle.
      </p>
    )
  }

  return (
    <div className="grid min-w-0 grid-cols-1 gap-4 md:grid-cols-3">
      {CARD_CATEGORIES.map((category) => {
        const label = cardCategoryLabel(category)
        const headingId = `board-${category}-heading`
        const inCategory = cards.filter((card) => card.category === category)
        return (
          <section
            key={category}
            aria-labelledby={headingId}
            className="min-w-0 space-y-3 rounded-lg border bg-card p-4 text-card-foreground"
          >
            <h3 id={headingId} className="text-base font-semibold">
              {label} ({inCategory.length})
            </h3>
            {inCategory.length === 0 ? (
              <p className="text-sm text-muted-foreground">No {label} cards.</p>
            ) : (
              <ul aria-label={`${label} cards`} className="space-y-2">
                {inCategory.map((card) => (
                  <BoardCardItem key={card.cardId} card={card} />
                ))}
              </ul>
            )}
          </section>
        )
      })}
    </div>
  )
}
