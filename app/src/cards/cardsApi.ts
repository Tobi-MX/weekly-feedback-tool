import { z } from 'zod'
import { supabase } from '@/auth/supabaseClient'
import { CARD_CATEGORIES, type CardCategory } from './cardCategories'
import { trimCardText } from './cardText'
import {
  CardsApiError,
  toCardsErrorCode,
  type CardOperation,
} from './cardsErrors'

/**
 * Card access goes only through #11's four RPCs. The author is always derived
 * from the session inside the database, so no request here carries a user id,
 * and no result carries an author.
 */

/** A `get_my_cards` row: one of the signed-in member's own cards. */
export interface MyCard {
  readonly id: string
  readonly category: CardCategory
  readonly text: string
  readonly isAnonymous: boolean
  readonly createdAt: string
  readonly updatedAt: string
}

/** A `create_card` or `update_card` result row. */
export interface SavedCard {
  readonly id: string
  readonly cycleId: string
  readonly category: CardCategory
  readonly text: string
  readonly isAnonymous: boolean
  readonly createdAt: string
  readonly updatedAt: string
}

export interface CreateCardInput {
  readonly cycleId: string
  readonly category: CardCategory
  readonly text: string
  readonly isAnonymous: boolean
}

export interface UpdateCardInput {
  readonly cardId: string
  readonly text: string
  readonly isAnonymous: boolean
}

type CardRpc = 'get_my_cards' | 'create_card' | 'update_card' | 'delete_card'

// Narrow schemas: unknown keys (for example an author id) are dropped, and a
// row that does not match is an unknown failure rather than rendered.
const categorySchema = z.enum(CARD_CATEGORIES)

const myCardRowSchema = z.object({
  id: z.string(),
  category: categorySchema,
  text: z.string(),
  is_anonymous: z.boolean(),
  created_at: z.string(),
  updated_at: z.string(),
})

const savedCardRowSchema = z.object({
  id: z.string(),
  cycle_id: z.string(),
  category: categorySchema,
  text: z.string(),
  is_anonymous: z.boolean(),
  created_at: z.string(),
  updated_at: z.string(),
})

interface RpcError {
  readonly message: string
}

interface RpcResult {
  readonly data: unknown
  readonly error: RpcError | null
}

/** Calls a card RPC and keeps only the stable error code on failure. */
async function callRpc(
  name: CardRpc,
  args: Record<string, string | boolean>,
  operation: CardOperation,
): Promise<unknown> {
  if (!supabase) {
    throw new CardsApiError('unknown', operation)
  }
  const { data, error }: RpcResult = await supabase.rpc(name, args)
  if (error) {
    throw new CardsApiError(toCardsErrorCode(error.message), operation)
  }
  return data
}

function parseRows<T>(
  schema: z.ZodType<T>,
  data: unknown,
  operation: CardOperation,
): T[] {
  const parsed = z.array(schema).safeParse(data ?? [])
  if (!parsed.success) {
    throw new CardsApiError('unknown', operation)
  }
  return parsed.data
}

function parseSaved(data: unknown, operation: CardOperation): SavedCard {
  const [row] = parseRows(savedCardRowSchema, data, operation)
  if (!row) {
    throw new CardsApiError('unknown', operation)
  }
  return {
    id: row.id,
    cycleId: row.cycle_id,
    category: row.category,
    text: row.text,
    isAnonymous: row.is_anonymous,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

/** The signed-in member's own cards in the cycle, oldest first. */
export async function fetchMyCards(cycleId: string): Promise<MyCard[]> {
  const data = await callRpc('get_my_cards', { p_cycle_id: cycleId }, 'load')
  return parseRows(myCardRowSchema, data, 'load').map((row) => ({
    id: row.id,
    category: row.category,
    text: row.text,
    isAnonymous: row.is_anonymous,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }))
}

/** Adds a card while the cycle is collecting. */
export async function createCard(input: CreateCardInput): Promise<SavedCard> {
  const data = await callRpc(
    'create_card',
    {
      p_cycle_id: input.cycleId,
      p_category: input.category,
      p_text: trimCardText(input.text),
      p_is_anonymous: input.isAnonymous,
    },
    'add',
  )
  return parseSaved(data, 'add')
}

/** Changes a card's text or anonymity while the cycle is collecting. */
export async function updateCard(input: UpdateCardInput): Promise<SavedCard> {
  const data = await callRpc(
    'update_card',
    {
      p_card_id: input.cardId,
      p_text: trimCardText(input.text),
      p_is_anonymous: input.isAnonymous,
    },
    'save',
  )
  return parseSaved(data, 'save')
}

/** Deletes a card while the cycle is collecting. */
export async function deleteCard(cardId: string): Promise<void> {
  await callRpc('delete_card', { p_card_id: cardId }, 'delete')
}
