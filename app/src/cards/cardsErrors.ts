/**
 * Stable error codes raised by the card RPCs. The database raises them as the
 * exception message; nothing else from a Postgres error is ever kept, shown,
 * or logged.
 */
export const CARDS_ERROR_CODES = [
  'not_project_member',
  'cycle_not_collecting',
  'card_not_found',
  'invalid_card_category',
  'invalid_card_text',
  'invalid_card_anonymity',
] as const

export type CardsErrorCode = (typeof CARDS_ERROR_CODES)[number] | 'unknown'

/** What the failed request was doing; it picks the message. */
export type CardOperation = 'load' | 'add' | 'save' | 'delete'

export const NOT_FOUND_MESSAGE = 'Cycle not found or you do not have access.'
export const COLLECTION_ENDED_MESSAGE =
  'Feedback collection has ended for this cycle.'
export const LOAD_ERROR_MESSAGE = 'Could not load your feedback.'
export const SAVE_ERROR_MESSAGE = 'Could not save the card. Try again.'
export const CARD_GONE_ON_SAVE_MESSAGE = 'This card no longer exists.'
export const CARD_GONE_ON_DELETE_MESSAGE = 'This card was already deleted.'

/**
 * The fixed, user-safe sentence for a code. It never contains card text, ids,
 * emails, or raw Postgres text.
 */
export function cardsErrorMessage(
  code: CardsErrorCode,
  operation: CardOperation,
): string {
  if (code === 'not_project_member') {
    return NOT_FOUND_MESSAGE
  }
  if (operation === 'load') {
    return LOAD_ERROR_MESSAGE
  }
  if (code === 'cycle_not_collecting') {
    return COLLECTION_ENDED_MESSAGE
  }
  if (code === 'card_not_found' && operation === 'save') {
    return CARD_GONE_ON_SAVE_MESSAGE
  }
  if (code === 'card_not_found' && operation === 'delete') {
    return CARD_GONE_ON_DELETE_MESSAGE
  }
  return SAVE_ERROR_MESSAGE
}

/** An error that carries only a stable code and a fixed message. */
export class CardsApiError extends Error {
  readonly code: CardsErrorCode

  constructor(code: CardsErrorCode, operation: CardOperation) {
    super(cardsErrorMessage(code, operation))
    this.name = 'CardsApiError'
    this.code = code
  }
}

/** Maps a raw RPC error message to one of the stable codes, else `unknown`. */
export function toCardsErrorCode(
  message: string | null | undefined,
): CardsErrorCode {
  return CARDS_ERROR_CODES.find((code) => code === message) ?? 'unknown'
}

export function cardsErrorCodeOf(error: unknown): CardsErrorCode {
  return error instanceof CardsApiError ? error.code : 'unknown'
}
