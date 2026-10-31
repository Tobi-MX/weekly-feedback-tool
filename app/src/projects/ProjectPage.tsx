import { Link, useParams } from 'react-router-dom'
import { Button } from '@/components/ui/button'
import { ProjectCycles } from '@/cycles/ProjectCycles'
import { formatProjectDate } from './projectDate'
import { useProjectQuery } from './useProjects'

export function ProjectPage() {
  const { id } = useParams<{ id: string }>()
  const projectQuery = useProjectQuery(id)
  const project = projectQuery.data

  return (
    <section className="space-y-4">
      {projectQuery.isPending ? (
        <p role="status" className="text-sm text-muted-foreground">
          Loading project…
        </p>
      ) : null}

      {projectQuery.isError ? (
        <div
          role="alert"
          className="space-y-3 rounded-lg border border-destructive/30 bg-card p-4 text-card-foreground"
        >
          <p className="text-sm">Could not load the project.</p>
          <Button
            type="button"
            variant="outline"
            onClick={() => {
              void projectQuery.refetch()
            }}
          >
            Retry
          </Button>
        </div>
      ) : null}

      {projectQuery.isSuccess && project === null ? (
        <div className="space-y-3 rounded-lg border border-dashed bg-card p-6 text-card-foreground">
          <p className="text-sm">
            Project not found or you do not have access.
          </p>
          <Link
            to="/projects"
            className="text-sm font-medium underline underline-offset-4"
          >
            Back to projects
          </Link>
        </div>
      ) : null}

      {projectQuery.isSuccess && project !== undefined && project !== null ? (
        <>
          <div className="min-w-0 space-y-3">
            <h1 className="min-w-0 break-words text-2xl font-semibold tracking-tight [overflow-wrap:anywhere]">
              {project.name}
            </h1>
            <p className="text-sm text-muted-foreground">
              {formatProjectDate(project.created_at)}
            </p>
            <Link
              to={`/projects/${project.id}/members`}
              className="inline-block text-sm font-medium underline underline-offset-4"
            >
              Members
            </Link>
          </div>
          <ProjectCycles projectId={project.id} />
        </>
      ) : null}
    </section>
  )
}

export default ProjectPage
