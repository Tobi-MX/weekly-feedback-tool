import { z } from 'zod'
import { supabase } from '@/auth/supabaseClient'
import { ActionApiError, toActionErrorCode } from '@/board/actionErrors'
import {
  ACTION_DESCRIPTION_MAX_LENGTH,
  ACTION_SOURCES,
  ACTION_STATUSES,
  isIsoDate,
  type CycleAction,
} from '@/board/actionsApi'
import { codePointLength } from '@/board/discussionApi'
import { CYCLE_STATUSES, type CycleStatus } from '@/cycles/cycleStatus'

/** The project list's status filter (#27). */
export const PROJECT_ACTION_FILTERS = ['open', 'done', 'all'] as const
export type ProjectActionStatusFilter = (typeof PROJECT_ACTION_FILTERS)[number]

/** The most open actions one read returns; paging past it is #114. */
export const OPEN_ACTIONS_LIMIT = 200
/** The most completed actions one read returns. */
export const DONE_ACTIONS_LIMIT = 20

export interface ProjectActionFilters {
  readonly status: ProjectActionStatusFilter
  readonly mineOnly: boolean
}

/** #26's action element plus its cycle and its related topic's name. */
export interface ProjectAction extends CycleAction {
  readonly cycleId: string
  readonly cycleTitle: string
  readonly cycleStatus: CycleStatus
  /** Null exactly when `clusterId` is null. */
  readonly clusterName: string | null
}

/** `get_project_actions`: the two lists and the full totals. */
export interface ProjectActions {
  readonly projectId: string
  readonly status: ProjectActionStatusFilter
  readonly mineOnly: boolean
  /** Every open action under `mineOnly`, whatever `status` is. */
  readonly openCount: number
  /** Every done action under `mineOnly`, whatever `status` is. */
  readonly doneCount: number
  /** Open actions by due date (no date last); empty for `done`. */
  readonly open: readonly ProjectAction[]
  /** The most recently completed; empty for `open`. */
  readonly done: readonly ProjectAction[]
}

const timestamp = z.iso.datetime({ offset: true })

// #26's 13 keys and rules, plus the four of #27. Strict at every level.
const elementSchema = z
  .object({
    action_id: z.string(),
    cluster_id: z.string().nullable(),
    description: z
      .string()
      .refine(
        (text) =>
          codePointLength(text) >= 1 &&
          codePointLength(text) <= ACTION_DESCRIPTION_MAX_LENGTH,
      ),
    owner_id: z.string().nullable(),
    owner_name: z.string().nullable(),
    owner_is_me: z.boolean(),
    created_by_me: z.boolean(),
    due_date: z.string().refine(isIsoDate).nullable(),
    status: z.enum(ACTION_STATUSES),
    completed_at: timestamp.nullable(),
    source: z.enum(ACTION_SOURCES),
    created_at: timestamp,
    updated_at: timestamp,
    cycle_id: z.string(),
    cycle_title: z.string().min(1),
    cycle_status: z.enum(CYCLE_STATUSES),
    cluster_name: z.string().nullable(),
  })
  .strict()
  .refine((row) => (row.owner_id === null) === (row.owner_name === null))
  .refine((row) => (row.status === 'done') === (row.completed_at !== null))
  .refine((row) => (row.cluster_id === null) === (row.cluster_name === null))

const count = z.number().int().nonnegative()

const responseSchema = z
  .object({
    project_id: z.string(),
    status: z.enum(PROJECT_ACTION_FILTERS),
    mine_only: z.boolean(),
    open_count: count,
    done_count: count,
    open: z.array(elementSchema).max(OPEN_ACTIONS_LIMIT),
    done: z.array(elementSchema).max(DONE_ACTIONS_LIMIT),
  })
  .strict()

type Element = z.infer<typeof elementSchema>

function toAction(row: Element): ProjectAction {
  return {
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
    cycleId: row.cycle_id,
    cycleTitle: row.cycle_title,
    cycleStatus: row.cycle_status,
    clusterName: row.cluster_name,
  }
}

interface DbResult {
  readonly data: unknown
  readonly error: { readonly message: string } | null
}

/**
 * The project's action items under the filters, read through
 * `get_project_actions`. The filters and limits are applied in the
 * database. Anything that does not match the agreed shape exactly, a thrown
 * call, or a missing client is `unknown`; the server's text is never kept.
 */
export async function fetchProjectActions(
  projectId: string,
  filters: ProjectActionFilters,
): Promise<ProjectActions> {
  if (!supabase) {
    throw new ActionApiError('unknown')
  }
  let result: DbResult
  try {
    result = await supabase.rpc('get_project_actions', {
      p_project_id: projectId,
      p_status: filters.status,
      p_mine_only: filters.mineOnly,
    })
  } catch {
    throw new ActionApiError('unknown')
  }
  if (result.error) {
    throw new ActionApiError(toActionErrorCode(result.error.message))
  }

  const parsed = responseSchema.safeParse(result.data)
  if (!parsed.success) {
    throw new ActionApiError('unknown')
  }
  const body = parsed.data
  const wantsOpen = filters.status !== 'done'
  const wantsDone = filters.status !== 'open'
  const ids = [...body.open, ...body.done].map((row) => row.action_id)
  if (
    body.project_id !== projectId ||
    body.status !== filters.status ||
    body.mine_only !== filters.mineOnly ||
    (!wantsOpen && body.open.length > 0) ||
    (!wantsDone && body.done.length > 0) ||
    body.open.length > body.open_count ||
    body.done.length > body.done_count ||
    body.open.some((row) => row.status !== 'open') ||
    body.done.some((row) => row.status !== 'done') ||
    new Set(ids).size !== ids.length
  ) {
    throw new ActionApiError('unknown')
  }

  return {
    projectId: body.project_id,
    status: body.status,
    mineOnly: body.mine_only,
    openCount: body.open_count,
    doneCount: body.done_count,
    open: body.open.map(toAction),
    done: body.done.map(toAction),
  }
}
