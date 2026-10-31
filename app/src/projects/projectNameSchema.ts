import { z } from 'zod'

/**
 * The form trims before validating so surrounding whitespace is never sent and
 * the length limit applies to the stored value. Internal whitespace is kept.
 */
export const projectNameSchema = z.object({
  name: z
    .string()
    .trim()
    .min(1, 'Enter a project name.')
    .max(100, 'Use 100 characters or fewer.'),
})

export type ProjectNameValues = z.input<typeof projectNameSchema>
export type ProjectNameOutput = z.output<typeof projectNameSchema>
