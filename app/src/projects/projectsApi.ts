import { supabase } from '@/auth/supabaseClient'

/** The narrow row shape the projects list and project page select. */
export interface ProjectSummary {
  readonly id: string
  readonly name: string
  readonly created_at: string
}

/** The only fields the client may supply when creating a project. */
export interface CreateProjectInput {
  readonly name: string
  readonly ownerId: string
}

export interface CreatedProject {
  readonly id: string
}

// The API rejects a non-UUID id before it reaches PostgREST, so an unknown or
// malformed id becomes the same not-found state instead of a database error.
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export function isProjectId(value: string): boolean {
  return UUID_PATTERN.test(value)
}

/**
 * Lists the signed-in user's projects newest first. RLS is the row boundary,
 * so no owner filter is sent. Only the columns the list renders are selected.
 */
export async function fetchProjects(): Promise<ProjectSummary[]> {
  if (!supabase) {
    return []
  }

  const { data, error } = await supabase
    .from('projects')
    .select('id, name, created_at')
    .order('created_at', { ascending: false })
    .overrideTypes<ProjectSummary[]>()

  if (error) {
    throw new Error('Could not load your projects.')
  }

  return data ?? []
}

/**
 * Loads one project by id. RLS returns no row for another user's project, and a
 * malformed id is treated the same way as an unknown one.
 */
export async function fetchProject(
  projectId: string,
): Promise<ProjectSummary | null> {
  if (!supabase || !isProjectId(projectId)) {
    return null
  }

  const { data, error } = await supabase
    .from('projects')
    .select('id, name, created_at')
    .eq('id', projectId)
    .maybeSingle<ProjectSummary>()

  if (error) {
    throw new Error('Could not load the project.')
  }

  return data ?? null
}

/**
 * Creates a project for the signed-in user. The client sends only the name and
 * owner id; the database owns the id and both timestamps.
 */
export async function createProject(
  input: CreateProjectInput,
): Promise<CreatedProject> {
  if (!supabase) {
    throw new Error('Could not create the project.')
  }

  const { data, error } = await supabase
    .from('projects')
    .insert({ name: input.name, owner_id: input.ownerId })
    .select('id')
    .single<CreatedProject>()

  if (error || !data) {
    throw new Error('Could not create the project.')
  }

  return data
}
