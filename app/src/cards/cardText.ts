import { z } from 'zod'

/** The most characters (Unicode code points) a card may hold after trimming. */
export const CARD_TEXT_MAX = 500

export const CARD_TEXT_EMPTY_MESSAGE = 'Write something before adding the card.'
export const CARD_TEXT_TOO_LONG_MESSAGE = 'Use 500 characters or fewer.'

// The database trims exactly E' \t\n\r' (pg_catalog.btrim). String.prototype
// .trim removes more (for example U+00A0 and U+2028), so it is not used here.
const TRIM_SET: ReadonlySet<string> = new Set([' ', '\t', '\n', '\r'])

/** Removes leading and trailing spaces, tabs, `\n`, and `\r` only. */
export function trimCardText(value: string): string {
  let start = 0
  let end = value.length
  while (start < end && TRIM_SET.has(value.charAt(start))) {
    start += 1
  }
  while (end > start && TRIM_SET.has(value.charAt(end - 1))) {
    end -= 1
  }
  return value.slice(start, end)
}

/**
 * The length the database checks: code points of the trimmed text, the same
 * as Postgres `char_length`. `.length` counts UTF-16 units, so an emoji would
 * count twice.
 */
export function cardTextLength(value: string): number {
  return [...trimCardText(value)].length
}

/** The inline error for a card's text, or `null` when it can be sent. */
export function cardTextError(value: string): string | null {
  const length = cardTextLength(value)
  if (length === 0) {
    return CARD_TEXT_EMPTY_MESSAGE
  }
  if (length > CARD_TEXT_MAX) {
    return CARD_TEXT_TOO_LONG_MESSAGE
  }
  return null
}

/**
 * The one text rule for adding and editing a card. The output text is
 * trimmed; interior line breaks are kept.
 */
export const cardFormSchema = z.object({
  text: z
    .string()
    .superRefine((value, ctx) => {
      const message = cardTextError(value)
      if (message !== null) {
        ctx.addIssue({ code: 'custom', message })
      }
    })
    .transform(trimCardText),
  isAnonymous: z.boolean(),
})

export type CardFormValues = z.input<typeof cardFormSchema>
export type CardFormOutput = z.output<typeof cardFormSchema>
