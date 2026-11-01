import { z } from 'zod'

/**
 * Matches `create_cycle` and `feedback_cycles_title_check`: the title is
 * trimmed before validating, so surrounding whitespace is never sent and the
 * length limit applies to the stored value.
 */
export const cycleFormSchema = z.object({
  title: z
    .string()
    .trim()
    .min(1, 'Enter a cycle title.')
    .max(100, 'Use 100 characters or fewer.'),
  weekStart: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Choose a week.'),
})

export type CycleFormValues = z.input<typeof cycleFormSchema>
export type CycleFormOutput = z.output<typeof cycleFormSchema>
