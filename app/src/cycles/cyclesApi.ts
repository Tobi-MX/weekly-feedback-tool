import { z } from 'zod'
import { supabase } from '@/auth/supabaseClient'
import { isProjectId } from '@/projects/projectId'
import { CYCLE_STATUSES, type CycleStatus } from './cycleStatus'
import { CyclesApiError, toCyclesErrorCode } from './cyclesErrors'

/** A cycle as the project page renders it. */
export interface CycleSummary {
  readonly id: string
  readonly title: string
  readonly weekStart: string
  readonly status: CycleStatus
  readonly createdAt: string
  readonly closedAt: string | null
}

/** The open cycle (if any) and the most recently created closed cycles. */
export interface ProjectCycles {
  readonly current: CycleSummary | null
  readonly past: readonly CycleSummary[]
}

export interface CreateCycleInput {
  readonly projectId: string
  readonly title: string
  /** `YYYY-MM-DD`, the Monday of the week. */
  readonly weekStart: string
}

/** The `create_cycle` result row. */
export interface CreatedCycle {
  readonly id: string
  readonly projectId: string
  readonly title: string
  readonly weekStart: string
  readonly status: CycleStatus
  readonly createdAt: string
}

/** One cycle, as the feedback form reads it by id. */
export interface CycleDetail {
  readonly id: string
  readonly projectId: string
  readonly title: string
  readonly weekStart: string
  readonly status: CycleStatus
}

/** The `close_cycle` result row. */
export interface ClosedCycle {
  readonly id: string
  readonly status: CycleStatus
  readonly closedAt: string | null
}

/** Past cycles shown on the project page; older ones are #37's history. */
export const PAST_CYCLES_LIMIT = 10

const CYCLE_COLUMNS = 'id, title, week_start, status, created_at, closed_at'

const CYCLE_DETAIL_COLUMNS = 'id, project_id, title, week_start, status'

const statusSchema = z.enum(CYCLE_STATUSES)

const cycleRowSchema = z.object({
  id: z.string(),
  title: z.string(),
  week_start: z.string(),
  status: statusSchema,
  created_at: z.string(),
  closed_at: z.string().nullable(),
})

const createdRowSchema = z.object({
  id: z.string(),
  project_id: z.string(),
  title: z.string(),
  week_start: z.string(),
  status: statusSchema,
  created_at: z.string(),
})

const cycleDetailRowSchema = z.object({
  id: z.string(),
  project_id: z.string(),
  title: z.string(),
  week_start: z.string(),
  status: statusSchema,
})

const closedRowSchema = z.object({
  id: z.string(),
  status: statusSchema,
  closed_at: z.string().nullable(),
})

interface DbError {
  readonly message: string
}

interface DbResult {
  readonly data: unknown
  readonly error: DbError | null
}

function parseRows<T>(schema: z.ZodType<T>, data: unknown): T[] {
  const parsed = z.array(schema).safeParse(data ?? [])
  if (!parsed.success) {
    throw new CyclesApiError('unknown')
  }
  return parsed.data
}

function toSummary(row: z.infer<typeof cycleRowSchema>): CycleSummary {
  return {
    id: row.id,
    title: row.title,
    weekStart: row.week_start,
    status: row.status,
    createdAt: row.created_at,
    closedAt: row.closed_at,
  }
}

/** Calls an RPC and keeps only the stable error code on failure. */
async function callRpc(
  name: 'create_cycle' | 'close_cycle',
  args: Record<string, unknown>,
): Promise<unknown> {
  if (!supabase) {
    throw new CyclesApiError('unknown')
  }
  const { data, error }: DbResult = await supabase.rpc(name, args)
  if (error) {
    throw new CyclesApiError(toCyclesErrorCode(error.message))
  }
  return data
}

/**
 * Loads a project's open cycle and its most recent closed cycles, newest
 * first. RLS returns rows only to members of the project.
 */
export async function fetchProjectCycles(
  projectId: string,
): Promise<ProjectCycles> {
  if (!supabase) {
    throw new CyclesApiError('unknown')
  }
  if (!isProjectId(projectId)) {
    return { current: null, past: [] }
  }

  const [currentResult, pastResult]: [DbResult, DbResult] = await Promise.all([
    supabase
      .from('feedback_cycles')
      .select(CYCLE_COLUMNS)
      .eq('project_id', projectId)
      .neq('status', 'closed')
      .order('created_at', { ascending: false })
      .limit(1),
    supabase
      .from('feedback_cycles')
      .select(CYCLE_COLUMNS)
      .eq('project_id', projectId)
      .eq('status', 'closed')
      .order('created_at', { ascending: false })
      .limit(PAST_CYCLES_LIMIT),
  ])

  if (currentResult.error || pastResult.error) {
    throw new CyclesApiError('unknown')
  }

  const [current] = parseRows(cycleRowSchema, currentResult.data)
  const past = parseRows(cycleRowSchema, pastResult.data)
  return {
    current: current ? toSummary(current) : null,
    past: past.map(toSummary),
  }
}

/**
 * Loads one cycle by id. A non-UUID id resolves to `null` without a request;
 * an unknown id and a cycle in a project the caller is not a member of both
 * return zero rows under RLS and also resolve to `null`.
 */
export async function fetchCycle(cycleId: string): Promise<CycleDetail | null> {
  if (!supabase) {
    throw new CyclesApiError('unknown')
  }
  if (!isProjectId(cycleId)) {
    return null
  }

  const { data, error }: DbResult = await supabase
    .from('feedback_cycles')
    .select(CYCLE_DETAIL_COLUMNS)
    .eq('id', cycleId)
    .maybeSingle()

  if (error) {
    throw new CyclesApiError('unknown')
  }
  if (data === null || data === undefined) {
    return null
  }

  const parsed = cycleDetailRowSchema.safeParse(data)
  if (!parsed.success) {
    throw new CyclesApiError('unknown')
  }
  const row = parsed.data
  return {
    id: row.id,
    projectId: row.project_id,
    title: row.title,
    weekStart: row.week_start,
    status: row.status,
  }
}

/** Facilitator only: opens a new `collecting` cycle for the project. */
export async function createCycle(
  input: CreateCycleInput,
): Promise<CreatedCycle> {
  const data = await callRpc('create_cycle', {
    p_project_id: input.projectId,
    p_title: input.title,
    p_week_start: input.weekStart,
  })
  const [row] = parseRows(createdRowSchema, data)
  if (!row) {
    throw new CyclesApiError('unknown')
  }
  return {
    id: row.id,
    projectId: row.project_id,
    title: row.title,
    weekStart: row.week_start,
    status: row.status,
    createdAt: row.created_at,
  }
}

/** Facilitator only: ends the cycle early; closing a closed cycle is a no-op. */
export async function closeCycle(cycleId: string): Promise<ClosedCycle> {
  const data = await callRpc('close_cycle', { p_cycle_id: cycleId })
  const [row] = parseRows(closedRowSchema, data)
  if (!row) {
    throw new CyclesApiError('unknown')
  }
  return { id: row.id, status: row.status, closedAt: row.closed_at }
}
