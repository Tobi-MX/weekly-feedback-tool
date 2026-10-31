import { useRef, type FormEvent } from 'react'
import { zodResolver } from '@hookform/resolvers/zod'
import { useQueryClient } from '@tanstack/react-query'
import { useForm } from 'react-hook-form'
import { Link, useNavigate } from 'react-router-dom'
import { toast } from 'sonner'
import { useAuth } from '@/auth/AuthProvider'
import { Button } from '@/components/ui/button'
import { formatProjectDate } from './projectDate'
import {
  projectNameSchema,
  type ProjectNameOutput,
  type ProjectNameValues,
} from './projectNameSchema'
import {
  projectsQueryKey,
  useCreateProject,
  useProjectsQuery,
} from './useProjects'

const CREATE_ERROR_MESSAGE = 'Could not create the project. Try again.'

export function ProjectsPage() {
  const { user } = useAuth()
  const userId = user?.id ?? null
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const projectsQuery = useProjectsQuery()
  const createMutation = useCreateProject()
  // React state updates after the first submit, so a synchronous second click
  // could otherwise start a second request before the button disables.
  const submittingRef = useRef(false)

  const {
    register,
    handleSubmit,
    reset,
    setFocus,
    formState: { errors, isSubmitting },
  } = useForm<ProjectNameValues, unknown, ProjectNameOutput>({
    resolver: zodResolver(projectNameSchema),
    defaultValues: { name: '' },
  })

  const isCreating = createMutation.isPending || isSubmitting
  const projects = projectsQuery.data
  const isInitialLoading =
    projectsQuery.isPending && projectsQuery.data === undefined
  const isInitialError =
    projectsQuery.isError && projectsQuery.data === undefined
  const isRefetchError =
    projectsQuery.isError && projectsQuery.data !== undefined

  const onSubmit = handleSubmit(async (values) => {
    if (!userId) {
      return
    }

    try {
      const created = await createMutation.mutateAsync({
        name: values.name,
        ownerId: userId,
      })
      // There is no optimistic row: the server owns the id and timestamps, so
      // the list is refreshed from the database before navigating away.
      await queryClient.invalidateQueries({
        queryKey: projectsQueryKey(userId),
      })
      reset()
      void navigate(`/projects/${created.id}`)
    } catch {
      toast.error(CREATE_ERROR_MESSAGE)
    }
  })

  // The guard lives in the submit event handler so a second synchronous click
  // cannot start a second insert before React disables the button.
  const onFormSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (!userId || submittingRef.current) {
      return
    }
    submittingRef.current = true
    void onSubmit(event).finally(() => {
      submittingRef.current = false
    })
  }

  return (
    <section aria-labelledby="projects-heading" className="space-y-6">
      <div className="space-y-4">
        <h1
          id="projects-heading"
          className="text-2xl font-semibold tracking-tight"
        >
          Projects
        </h1>

        <form
          onSubmit={onFormSubmit}
          noValidate
          className="flex flex-col gap-3 rounded-lg border bg-card p-4 text-card-foreground sm:flex-row sm:items-start"
        >
          <div className="min-w-0 flex-1 space-y-1">
            <label htmlFor="project-name" className="block text-sm font-medium">
              Project name
            </label>
            <input
              id="project-name"
              type="text"
              autoComplete="off"
              aria-invalid={errors.name ? 'true' : undefined}
              aria-describedby={errors.name ? 'project-name-error' : undefined}
              className="h-9 w-full min-w-0 rounded-md border border-input bg-background px-3 text-sm outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50"
              {...register('name')}
            />
            {errors.name?.message ? (
              <p id="project-name-error" className="text-sm text-destructive">
                {errors.name.message}
              </p>
            ) : null}
          </div>
          <Button type="submit" disabled={isCreating} className="sm:mt-6">
            {isCreating ? 'Creating…' : 'Create project'}
          </Button>
        </form>
      </div>

      <div className="space-y-3">
        {isInitialLoading ? (
          <p role="status" className="text-sm text-muted-foreground">
            Loading projects…
          </p>
        ) : null}

        {isInitialError ? (
          <div
            role="alert"
            className="space-y-3 rounded-lg border border-destructive/30 bg-card p-4 text-card-foreground"
          >
            <p className="text-sm">Could not load your projects.</p>
            <Button
              type="button"
              variant="outline"
              onClick={() => {
                void projectsQuery.refetch()
              }}
            >
              Retry
            </Button>
          </div>
        ) : null}

        {projects !== undefined ? (
          <div className="space-y-3">
            {isRefetchError ? (
              <div
                role="alert"
                className="space-y-3 rounded-lg border border-destructive/30 bg-card p-4 text-card-foreground"
              >
                <p className="text-sm">Could not load your projects.</p>
                <Button
                  type="button"
                  variant="outline"
                  onClick={() => {
                    void projectsQuery.refetch()
                  }}
                >
                  Retry
                </Button>
              </div>
            ) : null}

            {projects.length === 0 ? (
              <div className="space-y-3 rounded-lg border border-dashed bg-card p-6 text-card-foreground">
                <p className="text-sm text-muted-foreground">
                  No projects yet.
                </p>
                <Button
                  type="button"
                  variant="outline"
                  onClick={() => {
                    setFocus('name')
                  }}
                >
                  Create your first project
                </Button>
              </div>
            ) : (
              <ul
                aria-label="Your projects"
                className="divide-y rounded-lg border bg-card text-card-foreground"
              >
                {projects.map((project) => (
                  <li
                    key={project.id}
                    className="flex min-w-0 flex-col gap-1 px-4 py-3 sm:flex-row sm:items-baseline sm:justify-between sm:gap-4"
                  >
                    <Link
                      to={`/projects/${project.id}`}
                      className="min-w-0 break-words font-medium underline-offset-4 hover:underline [overflow-wrap:anywhere]"
                    >
                      {project.name}
                    </Link>
                    <span className="shrink-0 text-sm text-muted-foreground">
                      {formatProjectDate(project.created_at)}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </div>
        ) : null}
      </div>
    </section>
  )
}

export default ProjectsPage
