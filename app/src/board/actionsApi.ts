import { z } from 'zod'
import { supabase } from '@/auth/supabaseClient'
import { ActionApiError, toActionErrorCode } from './actionErrors'
import { codePointLength } from './discussionApi'

/** An action item's status (#26). */
export const ACTION_STATUSES = ['open', 'done'] as const
export type ActionStatus = (typeof ACTION_STATUSES)[number]

/** Where an action came from: added by hand here, or extracted (#33). */
export const ACTION_SOURCES = ['manual', 'extraction'] as const
export type ActionSource = (typeof ACTION_SOURCES)[number]

/** The most characters (code points) an action's description can have. */
export const ACTION_DESCRIPTION_MAX_LENGTH = 500

/** The due-date range the server accepts, as `YYYY-MM-DD`. */
export const DUE_DATE_MIN = '2000-01-01'
export const DUE_DATE_MAX = '2099-12-31'

/**
 * One action item. The same for every member, except `ownerIsMe` and
 * `createdByMe`. `ownerId` and `ownerName` are null after the owner's
 * account was deleted.
 */
export interface CycleAction {
  readonly actionId: string
  /** Null for no related topic. */
  readonly clusterId: string | null
  readonly description: string
  readonly ownerId: string | null
  readonly ownerName: string | null
  readonly ownerIsMe: boolean
  readonly createdByMe: boolean
  /** `YYYY-MM-DD`, or null. */
  readonly dueDate: string | null
  readonly status: ActionStatus
  readonly completedAt: string | null
  readonly source: ActionSource
  readonly createdAt: string
  readonly updatedAt: string
}

/** `get_cycle_actions`: every action of one cycle, in creation order. */
export interface CycleActions {
  readonly cycleId: string
  readonly actions: readonly CycleAction[]
}

/** The four editable fields, sent by create and edit. */
export interface ActionInput {
  readonly description: string
  readonly ownerId: string
  readonly dueDate: string | null
  readonly clusterId: string | null
}

const timestamp = z.iso.datetime({ offset: true })

/** `YYYY-MM-DD` with a real calendar date. */
export function isIsoDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    return false
  }
  const date = new Date(`${value}T00:00:00Z`)
  return !Number.isNaN(date.getTime()) && date.toISOString().startsWith(value)
}

const isoDate = z.string().refine(isIsoDate)

const description = z
  .string()
  .refine(
    (text) =>
      codePointLength(text) >= 1 &&
      codePointLength(text) <= ACTION_DESCRIPTION_MAX_LENGTH,
  )

// Strict at every level: exactly the agreed keys.
const actionSchema = z
  .object({
    action_id: z.string(),
    cluster_id: z.string().nullable(),
    description,
    owner_id: z.string().nullable(),
    owner_name: z.string().nullable(),
    owner_is_me: z.boolean(),
    created_by_me: z.boolean(),
    due_date: isoDate.nullable(),
    status: z.enum(ACTION_STATUSES),
    completed_at: timestamp.nullable(),
    source: z.enum(ACTION_SOURCES),
    created_at: timestamp,
    updated_at: timestamp,
  })
  .strict()
  .refine((row) => (row.owner_id === null) === (row.owner_name === null))
  .refine((row) => (row.status === 'done') === (row.completed_at !== null))

const actionsSchema = z
  .object({
    cycle_id: z.string(),
    actions: z.array(actionSchema),
  })
  .strict()

interface DbResult {
  readonly data: unknown
  readonly error: { readonly message: string } | null
}

/**
 * Calls one action RPC. A missing client, a thrown call, and any error
 * become an `ActionApiError` carrying only a stable code; the server's text
 * is never kept.
 */
async function callRpc(
  fn: string,
  args: Record<string, string | null>,
): Promise<unknown> {
  if (!supabase) {
    throw new ActionApiError('unknown')
  }
  let result: DbResult
  try {
    result = await supabase.rpc(fn, args)
  } catch {
    throw new ActionApiError('unknown')
  }
  if (result.error) {
    throw new ActionApiError(toActionErrorCode(result.error.message))
  }
  return result.data
}

/** Parses a one-row write result exactly, else `unknown`. */
function oneRow<T>(schema: z.ZodType<T>, data: unknown): T {
  const parsed = z.array(schema).length(1).safeParse(data)
  if (!parsed.success) {
    throw new ActionApiError('unknown')
  }
  return parsed.data[0]
}

const actionIdRow = z.object({ action_id: z.string() }).strict()

/** The cycle's action items. Called only while the board is in discuss. */
export async function fetchCycleActions(
  cycleId: string,
): Promise<CycleActions> {
  const data = await callRpc('get_cycle_actions', { p_cycle_id: cycleId })
  const parsed = actionsSchema.safeParse(data)
  if (!parsed.success || parsed.data.cycle_id !== cycleId) {
    throw new ActionApiError('unknown')
  }
  return {
    cycleId: parsed.data.cycle_id,
    actions: parsed.data.actions.map((row) => ({
      actionId: row.action_id,
      clusterId: row.cluster_id,
      description: row.description,
      ownerId: row.owner_id,
      ownerName: row.owner_name,
      ownerIsMe: row.owner_is_me,
      createdByMe: row.created_by_me,
      dueDate: row.due_date,
      status: row.status,
      completedAt: row.completed_at,
      source: row.source,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    })),
  }
}

/** Adds an action item. Resolves with the new id once the server agrees. */
export async function createAction(
  cycleId: string,
  input: ActionInput,
): Promise<string> {
  const data = await callRpc('create_action', {
    p_cycle_id: cycleId,
    p_description: input.description,
    p_owner_id: input.ownerId,
    p_due_date: input.dueDate ?? null,
    p_cluster_id: input.clusterId ?? null,
  })
  return oneRow(actionIdRow, data).action_id
}

/** Replaces the four editable fields (its creator, or the facilitator). */
export async function updateAction(
  actionId: string,
  input: ActionInput,
): Promise<void> {
  const data = await callRpc('update_action', {
    p_action_id: actionId,
    p_description: input.description,
    p_owner_id: input.ownerId,
    p_due_date: input.dueDate ?? null,
    p_cluster_id: input.clusterId ?? null,
  })
  if (oneRow(actionIdRow, data).action_id !== actionId) {
    throw new ActionApiError('unknown')
  }
}

/** Marks an action done or reopens it (its owner, or the facilitator). */
export async function setActionStatus(
  actionId: string,
  status: ActionStatus,
): Promise<void> {
  const data = await callRpc('set_action_status', {
    p_action_id: actionId,
    p_status: status,
  })
  const row = oneRow(
    z.object({ action_id: z.string(), status: z.string() }).strict(),
    data,
  )
  if (row.action_id !== actionId || row.status !== status) {
    throw new ActionApiError('unknown')
  }
}

/** Deletes an action item (its creator, or the facilitator). */
export async function deleteAction(actionId: string): Promise<void> {
  const data = await callRpc('delete_action', { p_action_id: actionId })
  if (oneRow(actionIdRow, data).action_id !== actionId) {
    throw new ActionApiError('unknown')
  }
}
