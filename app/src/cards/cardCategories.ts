/**
 * Card categories in page order, matching `cards_category_check`. A card's
 * category is fixed when it is created.
 */
export const CARD_CATEGORIES = ['start', 'stop', 'continue'] as const

export type CardCategory = (typeof CARD_CATEGORIES)[number]

interface CategoryCopy {
  readonly label: 'Start' | 'Stop' | 'Continue'
  readonly prompt: string
}

const COPY: Record<CardCategory, CategoryCopy> = {
  start: { label: 'Start', prompt: 'What should the team begin doing?' },
  stop: { label: 'Stop', prompt: 'What should the team stop doing?' },
  continue: {
    label: 'Continue',
    prompt: 'What is working and should continue?',
  },
}

export function cardCategoryLabel(category: CardCategory): string {
  return COPY[category].label
}

export function cardCategoryPrompt(category: CardCategory): string {
  return COPY[category].prompt
}
