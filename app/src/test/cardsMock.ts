import { vi } from 'vitest'
import type {
  CreateCardInput,
  MyCard,
  SavedCard,
  UpdateCardInput,
} from '../cards/cardsApi'
import { CardsApiError } from '../cards/cardsErrors'

/**
 * Shared mock for `src/cards/cardsApi.ts`. Every test gets it through
 * `setupTests`, so no test opens a network connection for card data.
 */
export const cardsMock = {
  fetchMyCards: vi.fn<(cycleId: string) => Promise<MyCard[]>>(),
  createCard: vi.fn<(input: CreateCardInput) => Promise<SavedCard>>(),
  updateCard: vi.fn<(input: UpdateCardInput) => Promise<SavedCard>>(),
  deleteCard: vi.fn<(cardId: string) => Promise<void>>(),

  resetCardsMock(): void {
    cardsMock.fetchMyCards.mockReset().mockResolvedValue([])
    cardsMock.createCard
      .mockReset()
      .mockRejectedValue(new CardsApiError('unknown', 'add'))
    cardsMock.updateCard
      .mockReset()
      .mockRejectedValue(new CardsApiError('unknown', 'save'))
    cardsMock.deleteCard
      .mockReset()
      .mockRejectedValue(new CardsApiError('unknown', 'delete'))
  },
}

export function resetCardsMock(): void {
  cardsMock.resetCardsMock()
}
