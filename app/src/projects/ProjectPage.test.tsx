import { act, fireEvent, screen, waitFor, within } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { deferred, mockRestoredSession } from '../test/authMock'
import { profileMock } from '../test/profileMock'
import { projectsMock } from '../test/projectsMock'
import { renderApp } from '../test/renderApp'
import type { ProjectSummary } from './projectsApi'

const project: ProjectSummary = {
  id: '10000000-0000-4000-8000-000000000001',
  name: 'Alpha Project',
  created_at: '2026-10-30T12:00:00.000Z',
}

function renderProject(path: string) {
  mockRestoredSession()
  profileMock.fetchProfileDisplayName.mockResolvedValue('Dev User')
  return renderApp({ initialEntries: [path] })
}

describe('ProjectPage', () => {
  it('shows an accessible loading indicator while the project query is pending', async () => {
    const pending = deferred<ProjectSummary | null>()
    projectsMock.fetchProject.mockReturnValue(pending.promise)

    renderProject(`/projects/${project.id}`)

    expect(await screen.findByText('Loading project…')).toHaveAttribute(
      'role',
      'status',
    )
    expect(
      screen.queryByText('This screen is not built yet.'),
    ).not.toBeInTheDocument()

    await act(async () => {
      pending.resolve(null)
    })
  })

  it('shows an alert and retries after a project query failure', async () => {
    projectsMock.fetchProject
      .mockRejectedValueOnce(new Error('permission denied for table projects'))
      .mockResolvedValueOnce(project)

    renderProject(`/projects/${project.id}`)

    const alert = await screen.findByRole('alert')
    expect(alert).toHaveTextContent('Could not load the project.')
    expect(alert).not.toHaveTextContent('permission denied')

    fireEvent.click(within(alert).getByRole('button', { name: 'Retry' }))

    expect(
      await screen.findByRole('heading', {
        name: 'Alpha Project',
        level: 1,
      }),
    ).toBeInTheDocument()
    await waitFor(() => {
      expect(screen.queryByRole('alert')).not.toBeInTheDocument()
    })
    expect(projectsMock.fetchProject).toHaveBeenCalledTimes(2)
  })

  it.each([
    ['an unknown id', '10000000-0000-4000-8000-000000000099'],
    ["another user's project id", '10000000-0000-4000-8000-000000000098'],
    ['a non-UUID id', 'project-1'],
  ])('shows the not-found state for %s', async (_label, id) => {
    projectsMock.fetchProject.mockResolvedValue(null)

    renderProject(`/projects/${id}`)

    expect(
      await screen.findByText('Project not found or you do not have access.'),
    ).toBeInTheDocument()
    expect(
      screen.getByRole('link', { name: 'Back to projects' }),
    ).toHaveAttribute('href', '/projects')
    expect(screen.queryByRole('heading', { level: 1 })).not.toBeInTheDocument()
    expect(
      screen.queryByText('This screen is not built yet.'),
    ).not.toBeInTheDocument()
    expect(screen.queryByText('Oct 30, 2026')).not.toBeInTheDocument()
    expect(projectsMock.fetchProject).toHaveBeenCalledWith(id)
  })

  it('shows the project name, UTC created date, and the placeholder copy', async () => {
    projectsMock.fetchProject.mockResolvedValue(project)

    renderProject(`/projects/${project.id}`)

    expect(
      await screen.findByRole('heading', {
        name: 'Alpha Project',
        level: 1,
      }),
    ).toBeInTheDocument()
    expect(screen.getByText('Oct 30, 2026')).toBeInTheDocument()
    expect(screen.getByText('This screen is not built yet.')).toBeVisible()
    expect(screen.queryByText(/2026-10-30T/)).not.toBeInTheDocument()
    expect(
      screen.queryByRole('link', { name: 'Back to projects' }),
    ).not.toBeInTheDocument()
    expect(screen.queryByText(/cycles|members|actions|history/i)).toBeNull()
    expect(projectsMock.fetchProject).toHaveBeenCalledWith(project.id)
  })
})
