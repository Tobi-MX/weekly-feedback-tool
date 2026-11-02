import { z } from 'zod'

/**
 * The model's output schema. The JSON Schema goes to structured outputs
 * (`output_config.format`); the Zod schema mirrors it and checks the parsed
 * answer, which is untrusted. Length and count limits cannot be expressed in
 * structured outputs; `validate.ts` checks them.
 */

export const CATEGORIES = ['start', 'stop', 'continue'] as const

export type Category = (typeof CATEGORIES)[number]

export function isCategory(value: unknown): value is Category {
  return typeof value === 'string' && (CATEGORIES as readonly string[]).includes(value)
}

export const CLUSTER_OUTPUT_JSON_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['clusters', 'ungrouped_card_refs'],
  properties: {
    clusters: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['name', 'category', 'card_refs'],
        properties: {
          name: { type: 'string' },
          category: { type: 'string', enum: [...CATEGORIES] },
          card_refs: { type: 'array', items: { type: 'string' } },
        },
      },
    },
    ungrouped_card_refs: { type: 'array', items: { type: 'string' } },
  },
}

export const ClusterOutputSchema = z.strictObject({
  clusters: z.array(
    z.strictObject({
      name: z.string(),
      category: z.enum(CATEGORIES),
      card_refs: z.array(z.string()),
    }),
  ),
  ungrouped_card_refs: z.array(z.string()),
})

export type ClusterOutput = z.infer<typeof ClusterOutputSchema>
