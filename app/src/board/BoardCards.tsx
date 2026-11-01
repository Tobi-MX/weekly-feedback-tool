import { wrapText } from '@/cards/CardForms'
import { CARD_CATEGORIES, cardCategoryLabel } from '@/cards/cardCategories'
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
