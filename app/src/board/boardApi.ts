import { z } from 'zod'
import { supabase } from '@/auth/supabaseClient'
import { CARD_CATEGORIES, type CardCategory } from '@/cards/cardCategories'
import { CYCLE_STATUSES, type CycleStatus } from '@/cycles/cycleStatus'
import { isProjectId } from '@/projects/projectId'
import { BoardApiError, toBoardErrorCode } from './boardErrors'

/**
 * An anonymous card: no author key of any kind, and the same for every
 * caller, its author included.
 */
export interface AnonymousBoardCard {
  readonly cardId: string
  readonly category: CardCategory
  readonly text: string
  readonly isAnonymous: true
}

/** An attributed card. `authorDisplayName` is null for a deleted author. */
export interface AttributedBoardCard {
  readonly cardId: string
  readonly category: CardCategory
  readonly text: string
  readonly isAnonymous: false
  readonly isMine: boolean
  readonly authorDisplayName: string | null
}

export type BoardCard = AnonymousBoardCard | AttributedBoardCard

/** One `get_cycle_board` response. `cards` keeps the server's order. */
export interface CycleBoard {
  readonly cycleId: string
  readonly status: CycleStatus
  readonly isRevealed: boolean
  readonly cards: readonly BoardCard[]
}

// Strict: an extra or a missing key fails to parse, so a response that
// carries more than the contract (for example an author name on an anonymous
// card, or a timestamp) is shown as a load error rather than rendered. #17,
// #18, and #22 add their keys here in the PR that extends the RPC.
const anonymousCardSchema = z
  .object({
    card_id: z.string(),
    category: z.enum(CARD_CATEGORIES),
    text: z.string(),
    is_anonymous: z.literal(true),
  })
  .strict()

const attributedCardSchema = z
  .object({
    card_id: z.string(),
    category: z.enum(CARD_CATEGORIES),
    text: z.string(),
    is_anonymous: z.literal(false),
    is_mine: z.boolean(),
    author_display_name: z.string().nullable(),
  })
  .strict()

const cycleBoardSchema = z
  .object({
    cycle_id: z.string(),
    status: z.enum(CYCLE_STATUSES),
    is_revealed: z.boolean(),
    cards: z.array(
      z.discriminatedUnion('is_anonymous', [
        anonymousCardSchema,
        attributedCardSchema,
      ]),
    ),
  })
  .strict()

type CardRow = z.infer<typeof cycleBoardSchema>['cards'][number]

function toCard(row: CardRow): BoardCard {
  if (row.is_anonymous) {
    return {
      cardId: row.card_id,
      category: row.category,
      text: row.text,
      isAnonymous: true,
    }
  }
  return {
    cardId: row.card_id,
    category: row.category,
    text: row.text,
    isAnonymous: false,
    isMine: row.is_mine,
    authorDisplayName: row.author_display_name,
  }
}

interface DbResult {
  readonly data: unknown
  readonly error: { readonly message: string } | null
}

/**
 * The board for one cycle, through `get_cycle_board` only. A non-UUID id
 * resolves to `null` (not found) without a request. The response must match
 * the strict schema; the card order is the server's and is never changed.
 */
export async function fetchCycleBoard(
  cycleId: string,
): Promise<CycleBoard | null> {
  if (!supabase) {
    throw new BoardApiError('unknown')
  }
  if (!isProjectId(cycleId)) {
    return null
  }

  const { data, error }: DbResult = await supabase.rpc('get_cycle_board', {
    p_cycle_id: cycleId,
  })
  if (error) {
    throw new BoardApiError(toBoardErrorCode(error.message))
  }

  const parsed = cycleBoardSchema.safeParse(data)
  if (!parsed.success) {
    throw new BoardApiError('unknown')
  }
  const row = parsed.data
  return {
    cycleId: row.cycle_id,
    status: row.status,
    isRevealed: row.is_revealed,
    cards: row.cards.map(toCard),
  }
}
