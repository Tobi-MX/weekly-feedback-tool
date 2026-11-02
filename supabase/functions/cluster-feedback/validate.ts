import { type Category, type ClusterOutput, ClusterOutputSchema } from './schema.ts'

/**
 * Checks the model's answer before any write. The answer is untrusted input:
 * every failure is `ai_invalid_output` (or `ai_refused` for a refusal), and
 * nothing is written.
 */

/** A content block, narrowed to what validation reads. */
export interface ContentBlockLike {
  readonly type: string
  readonly text?: string
}

export interface ModelAnswer {
  readonly stop_reason: string | null
  readonly content: readonly ContentBlockLike[]
}

export interface ValidCluster {
  /** Trimmed with #17's trim set. */
  readonly name: string
  readonly category: Category
  readonly card_refs: readonly string[]
}

export type ValidationResult =
  | { readonly ok: true; readonly clusters: readonly ValidCluster[] }
  | { readonly ok: false; readonly code: 'ai_refused' | 'ai_invalid_output' }

const INVALID = { ok: false, code: 'ai_invalid_output' } as const

/** #17's trim set: space, tab, newline, carriage return. */
export function trimClusterName(name: string): string {
  return name.replace(/^[ \t\n\r]+|[ \t\n\r]+$/g, '')
}

// deno-lint-ignore no-control-regex
const CONTROL = /[\u0000-\u001f\u007f-\u009f]/

/** #17's name rule after the trim: 1-100 characters, no control character. */
export function isValidClusterName(name: string): boolean {
  const length = [...name].length
  return length >= 1 && length <= 100 && !CONTROL.test(name)
}

/**
 * The structured-output text: the single text block after the last fallback
 * block (a declined model's partial text comes before it), or null.
 */
export function outputText(content: readonly ContentBlockLike[]): string | null {
  let start = 0
  content.forEach((block, index) => {
    if (block.type === 'fallback') {
      start = index + 1
    }
  })
  const texts = content.slice(start).filter((block) => block.type === 'text')
  if (texts.length !== 1 || typeof texts[0].text !== 'string') {
    return null
  }
  return texts[0].text
}

/**
 * Validates the answer against the refs that were sent (ref -> category) and
 * the cluster slots left. Sent cards in no list count as ungrouped; zero
 * clusters is valid; duplicate names are left to the database's suffixing.
 */
export function validateAnswer(
  answer: ModelAnswer,
  sentRefs: ReadonlyMap<string, Category>,
  clusterSlots: number,
): ValidationResult {
  if (answer.stop_reason === 'refusal') {
    return { ok: false, code: 'ai_refused' }
  }
  if (answer.stop_reason !== 'end_turn') {
    return INVALID
  }

  const text = outputText(answer.content)
  if (text === null) {
    return INVALID
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return INVALID
  }
  const checked = ClusterOutputSchema.safeParse(parsed)
  if (!checked.success) {
    return INVALID
  }
  const output: ClusterOutput = checked.data

  if (output.clusters.length > clusterSlots) {
    return INVALID
  }

  const used = new Set<string>()
  const useRef = (ref: string): boolean => {
    if (!sentRefs.has(ref) || used.has(ref)) {
      return false
    }
    used.add(ref)
    return true
  }

  const clusters: ValidCluster[] = []
  for (const cluster of output.clusters) {
    if (cluster.card_refs.length === 0) {
      return INVALID
    }
    for (const ref of cluster.card_refs) {
      if (!useRef(ref) || sentRefs.get(ref) !== cluster.category) {
        return INVALID
      }
    }
    const name = trimClusterName(cluster.name)
    if (!isValidClusterName(name)) {
      return INVALID
    }
    clusters.push({ name, category: cluster.category, card_refs: cluster.card_refs })
  }
  for (const ref of output.ungrouped_card_refs) {
    if (!useRef(ref)) {
      return INVALID
    }
  }

  return { ok: true, clusters }
}
