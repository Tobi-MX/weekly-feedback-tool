import { z } from 'zod'
import { supabase } from '@/auth/supabaseClient'
import { DiscussionApiError, toDiscussionErrorCode } from './discussionErrors'

/** A topic's discussion status (#25). */
export const DISCUSSION_STATUSES = [
  'pending',
  'discussed',
  'skipped',
  'deferred',
] as const

export type DiscussionStatus = (typeof DISCUSSION_STATUSES)[number]

/** The most characters (code points) a note can have. */
export const NOTE_MAX_LENGTH = 2000

export interface TopicStatus {
  readonly clusterId: string
  readonly discussionStatus: DiscussionStatus
}

/**
 * One note. Notes are attributed and the same for every member, except
 * `isMine`. `authorName` is null when the author's account was deleted.
 */
export interface DiscussionNote {
  readonly noteId: string
  /** Null for a general note. */
  readonly clusterId: string | null
  readonly text: string
  readonly authorName: string | null
  readonly isMine: boolean
  readonly createdAt: string
  readonly editedAt: string | null
}

/** `get_cycle_discussion`: the statuses and notes of one cycle. */
export interface CycleDiscussion {
  readonly cycleId: string
  readonly statuses: readonly TopicStatus[]
  readonly notes: readonly DiscussionNote[]
}

/** Length in code points, as the server's `char_length`. */
export function codePointLength(text: string): number {
  return Array.from(text).length
}

const timestamp = z.iso.datetime({ offset: true })

const noteText = z
  .string()
  .refine(
    (text) =>
      codePointLength(text) >= 1 && codePointLength(text) <= NOTE_MAX_LENGTH,
  )

// Strict at every level: exactly the agreed keys.
const discussionSchema = z
  .object({
    cycle_id: z.string(),
    statuses: z.array(
      z
        .object({
          cluster_id: z.string(),
          discussion_status: z.enum(DISCUSSION_STATUSES),
        })
        .strict(),
    ),
    notes: z.array(
      z
        .object({
          note_id: z.string(),
          cluster_id: z.string().nullable(),
          text: noteText,
          author_name: z.string().nullable(),
          is_mine: z.boolean(),
          created_at: timestamp,
          edited_at: timestamp.nullable(),
        })
        .strict(),
    ),
  })
  .strict()

interface DbResult {
  readonly data: unknown
  readonly error: { readonly message: string } | null
}

/**
 * Calls one discussion RPC. A missing client, a thrown call, and any error
 * become a `DiscussionApiError` carrying only a stable code; the server's
 * text is never kept.
 */
async function callRpc(
  fn: string,
  args: Record<string, string | null>,
): Promise<unknown> {
  if (!supabase) {
    throw new DiscussionApiError('unknown')
  }
  let result: DbResult
  try {
    result = await supabase.rpc(fn, args)
  } catch {
    throw new DiscussionApiError('unknown')
  }
  if (result.error) {
    throw new DiscussionApiError(toDiscussionErrorCode(result.error.message))
  }
  return result.data
}

/** Parses a one-row write result exactly, else `unknown`. */
function oneRow<T>(schema: z.ZodType<T>, data: unknown): T {
  const parsed = z.array(schema).length(1).safeParse(data)
  if (!parsed.success) {
    throw new DiscussionApiError('unknown')
  }
  return parsed.data[0]
}

/** The cycle's statuses and notes. Called only while the board is in discuss. */
export async function fetchDiscussion(
  cycleId: string,
): Promise<CycleDiscussion> {
  const data = await callRpc('get_cycle_discussion', { p_cycle_id: cycleId })
  const parsed = discussionSchema.safeParse(data)
  if (!parsed.success || parsed.data.cycle_id !== cycleId) {
    throw new DiscussionApiError('unknown')
  }
  return {
    cycleId: parsed.data.cycle_id,
    statuses: parsed.data.statuses.map((row) => ({
      clusterId: row.cluster_id,
      discussionStatus: row.discussion_status,
    })),
    notes: parsed.data.notes.map((row) => ({
      noteId: row.note_id,
      clusterId: row.cluster_id,
      text: row.text,
      authorName: row.author_name,
      isMine: row.is_mine,
      createdAt: row.created_at,
      editedAt: row.edited_at,
    })),
  }
}

/** Sets a topic's status (facilitator only). Resolves once the server agrees. */
export async function setDiscussionStatus(
  clusterId: string,
  status: DiscussionStatus,
): Promise<void> {
  const data = await callRpc('set_discussion_status', {
    p_cluster_id: clusterId,
    p_status: status,
  })
  const row = oneRow(
    z
      .object({ cluster_id: z.string(), discussion_status: z.string() })
      .strict(),
    data,
  )
  if (row.cluster_id !== clusterId || row.discussion_status !== status) {
    throw new DiscussionApiError('unknown')
  }
}

/** Adds a note to a topic, or a general note when `clusterId` is null. */
export async function addNote(
  cycleId: string,
  clusterId: string | null,
  text: string,
): Promise<string> {
  const data = await callRpc('add_note', {
    p_cycle_id: cycleId,
    p_cluster_id: clusterId,
    p_text: text,
  })
  const row = oneRow(
    z
      .object({ note_id: z.string(), cluster_id: z.string().nullable() })
      .strict(),
    data,
  )
  if (row.cluster_id !== clusterId) {
    throw new DiscussionApiError('unknown')
  }
  return row.note_id
}

const noteIdRow = z.object({ note_id: z.string() }).strict()

/** Changes the caller's own note. */
export async function updateNote(noteId: string, text: string): Promise<void> {
  const data = await callRpc('update_note', {
    p_note_id: noteId,
    p_text: text,
  })
  if (oneRow(noteIdRow, data).note_id !== noteId) {
    throw new DiscussionApiError('unknown')
  }
}

/** Deletes a note (its author, or the facilitator). */
export async function deleteNote(noteId: string): Promise<void> {
  const data = await callRpc('delete_note', { p_note_id: noteId })
  if (oneRow(noteIdRow, data).note_id !== noteId) {
    throw new DiscussionApiError('unknown')
  }
}
