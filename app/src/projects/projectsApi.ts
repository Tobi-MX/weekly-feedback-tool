import { supabase } from '@/auth/supabaseClient'
import { isProjectId } from './projectId'

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

// The UUID guard lives in its own module so the members API can reuse it
// without importing this (mocked in tests) module.
export { isProjectId }

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
