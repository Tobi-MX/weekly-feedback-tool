import { useSyncExternalStore } from 'react'
import { wrapText } from '@/cards/CardForms'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import type { MoveMenuItem } from './cardMove'

const FINE_POINTER = '(pointer: fine)'

function subscribeFinePointer(onChange: () => void): () => void {
  const query = window.matchMedia(FINE_POINTER)
  query.addEventListener('change', onChange)
  return () => {
    query.removeEventListener('change', onChange)
  }
}

/**
 * Whether the primary pointer is a mouse or trackpad. Cards are draggable
 * only then, so touch scrolling and text selection are never captured.
 */
export function useFinePointer(): boolean {
  return useSyncExternalStore(
    subscribeFinePointer,
    () => window.matchMedia(FINE_POINTER).matches,
    () => false,
  )
}

export interface MoveMenuProps {
  readonly cardId: string
  /** "Move card: <text>", cut to 40 characters. */
  readonly label: string
  readonly items: readonly MoveMenuItem[]
  readonly open: boolean
  /** While any move is pending: focusable, but activation does nothing. */
  readonly blocked: boolean
  readonly onOpenChange: (open: boolean) => void
  readonly onSelect: (item: MoveMenuItem) => void
}

/**
 * A card's "Move" button and menu: the keyboard, screen-reader, and touch
 * path, which covers every move. It renders the same for every card and
 * every viewer.
 */
export function MoveMenu({
  cardId,
  label,
  items,
  open,
  blocked,
  onOpenChange,
  onSelect,
}: MoveMenuProps) {
  return (
    <DropdownMenu
      open={open}
      onOpenChange={(next) => {
        if (next && blocked) {
          return
        }
        onOpenChange(next)
      }}
    >
      <DropdownMenuTrigger asChild>
        <Button
          type="button"
          variant="outline"
          size="sm"
          aria-label={label}
          aria-disabled={blocked ? 'true' : undefined}
          data-move-card={cardId}
          className="shrink-0 aria-disabled:opacity-50"
        >
          Move
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align="end"
        collisionPadding={8}
        data-move-menu={cardId}
        className="max-w-[min(20rem,calc(100vw-2rem))]"
      >
        {items.map((item) => (
          <DropdownMenuItem
            key={item.key}
            className={wrapText}
            onSelect={() => {
              onSelect(item)
            }}
          >
            {item.label}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
