import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useAuth } from '@/auth/AuthProvider'
import { cycleQueryKey } from '@/cycles/useCycles'
import {
  createCard,
  deleteCard,
  fetchMyCards,
  updateCard,
  type CreateCardInput,
  type UpdateCardInput,
} from './cardsApi'
import { cardsErrorCodeOf } from './cardsErrors'

export const myCardsQueryKey = (userId: string | null, cycleId: string) =>
  ['my-cards', userId, cycleId] as const

export const CREATE_CARD_KEY = ['create-card'] as const
export const UPDATE_CARD_KEY = ['update-card'] as const
export const DELETE_CARD_KEY = ['delete-card'] as const

function useUserId() {
  const { status, user } = useAuth()
  const userId = user?.id ?? null
  return { userId, ready: status === 'authenticated' && userId !== null }
}

/**
 * The member's own cards in the cycle. After `not_project_member` the query
 * stays disabled, so no further card request is sent.
 */
export function useMyCardsQuery(cycleId: string, enabled: boolean) {
  const { userId, ready } = useUserId()

  return useQuery({
    queryKey: myCardsQueryKey(userId, cycleId),
    queryFn: () => fetchMyCards(cycleId),
    enabled: (query) =>
      ready &&
      enabled &&
      cardsErrorCodeOf(query.state.error) !== 'not_project_member',
  })
}

/** Invalidates the card list, and with `andCycle` the cycle as well. */
export function useInvalidateFeedback(cycleId: string) {
  const { userId } = useUserId()
  const queryClient = useQueryClient()
  return (andCycle: boolean) =>
    Promise.all([
      queryClient.invalidateQueries({
        queryKey: myCardsQueryKey(userId, cycleId),
      }),
      andCycle
        ? queryClient.invalidateQueries({
            queryKey: cycleQueryKey(userId, cycleId),
          })
        : Promise.resolve(),
    ])
}

// Card mutations use networkMode 'always': a write made offline fails now
// instead of being paused and replayed later. Nothing is optimistic; the list
// is re-read after each successful write.

export function useCreateCard(cycleId: string) {
  const invalidate = useInvalidateFeedback(cycleId)
  return useMutation({
    mutationKey: CREATE_CARD_KEY,
    networkMode: 'always',
    mutationFn: (input: Omit<CreateCardInput, 'cycleId'>) =>
      createCard({ ...input, cycleId }),
    onSuccess: () => invalidate(false),
  })
}

export function useUpdateCard(cycleId: string) {
  const invalidate = useInvalidateFeedback(cycleId)
  return useMutation({
    mutationKey: UPDATE_CARD_KEY,
    networkMode: 'always',
    mutationFn: (input: UpdateCardInput) => updateCard(input),
    onSuccess: () => invalidate(false),
  })
}

export function useDeleteCard(cycleId: string) {
  const invalidate = useInvalidateFeedback(cycleId)
  return useMutation({
    mutationKey: DELETE_CARD_KEY,
    networkMode: 'always',
    mutationFn: (cardId: string) => deleteCard(cardId),
    onSuccess: () => invalidate(false),
  })
}
