import { act, fireEvent, screen, waitFor, within } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { queryClient } from '../lib/queryClient'
import { deferred, mockRestoredSession } from '../test/authMock'
import { profileMock } from '../test/profileMock'
import { projectsMock } from '../test/projectsMock'
import { renderApp } from '../test/renderApp'
import type { CreatedProject, ProjectSummary } from './projectsApi'
import { projectsQueryKey } from './useProjects'

const newerProject: ProjectSummary = {
  id: '10000000-0000-4000-8000-000000000001',
  name: 'Newer Project',
  created_at: '2026-10-30T12:00:00.000Z',
}

const olderProject: ProjectSummary = {
  id: '10000000-0000-4000-8000-000000000002',
  name: 'Older Project',
  created_at: '2026-10-01T12:00:00.000Z',
}

const createdProject: ProjectSummary = {
  id: '10000000-0000-4000-8000-000000000003',
  name: 'Team',
  created_at: '2026-10-30T13:00:00.000Z',
}

function locationText(): string {
  return screen.getByTestId('location').textContent ?? ''
}

function renderProjects(navigationLog?: string[]) {
  mockRestoredSession()
  profileMock.fetchProfileDisplayName.mockResolvedValue('Dev User')
  return renderApp({ initialEntries: ['/projects'], navigationLog })
}

async function renderWithProjects(projects: ProjectSummary[]) {
  projectsMock.fetchProjects.mockResolvedValue(projects)
  renderProjects()
  await screen.findByRole('heading', { name: 'Projects', level: 1 })
  if (projects.length === 0) {
    await screen.findByText('No projects yet.')
  } else {
    await screen.findByRole('list', { name: 'Your projects' })
  }
}

describe('ProjectsPage', () => {
  it('renders one heading, a labeled name field, a submit button, and no owner field', async () => {
    projectsMock.fetchProjects.mockResolvedValue([])
    renderProjects()

    const heading = await screen.findByRole('heading', {
      name: 'Projects',
      level: 1,
    })
    expect(screen.getAllByRole('heading', { level: 1 })).toHaveLength(1)
    expect(heading).toBeInTheDocument()
    expect(screen.getByLabelText('Project name')).toBeInTheDocument()
    expect(
      screen.getByRole('button', { name: 'Create project' }),
    ).toBeInTheDocument()
    expect(screen.queryByLabelText(/owner/i)).not.toBeInTheDocument()
  })

  it('shows an accessible loading indicator and not the empty state while pending', async () => {
    const pending = deferred<ProjectSummary[]>()
    projectsMock.fetchProjects.mockReturnValue(pending.promise)

    renderProjects()

    expect(await screen.findByText('Loading projects…')).toHaveAttribute(
      'role',
      'status',
    )
    expect(screen.queryByText('No projects yet.')).not.toBeInTheDocument()

    await act(async () => {
      pending.resolve([])
    })
  })

  it('shows the empty state and focuses the name input from its action', async () => {
    await renderWithProjects([])

    expect(screen.getByText('No projects yet.')).toBeInTheDocument()
    const input = screen.getByLabelText('Project name')
    expect(input).not.toHaveFocus()

    fireEvent.click(
      screen.getByRole('button', { name: 'Create your first project' }),
    )

    await waitFor(() => {
      expect(input).toHaveFocus()
    })
  })

  it('renders rows in API order with a UTC human-readable date and links', async () => {
    await renderWithProjects([newerProject, olderProject])

    const list = screen.getByRole('list', { name: 'Your projects' })
    const rows = within(list).getAllByRole('listitem')
    expect(rows).toHaveLength(2)

    const newerLink = within(rows[0]).getByRole('link', {
      name: 'Newer Project',
    })
    expect(newerLink.tagName).toBe('A')
    expect(newerLink).toHaveAttribute('href', `/projects/${newerProject.id}`)
    expect(within(rows[0]).getByText('Oct 30, 2026')).toBeInTheDocument()
    expect(within(rows[1]).getByText('Older Project')).toBeInTheDocument()
    expect(within(rows[1]).getByText('Oct 1, 2026')).toBeInTheDocument()
    expect(screen.queryByText(/2026-10-30T/)).not.toBeInTheDocument()
  })

  it('navigates to the project page when a row is activated', async () => {
    projectsMock.fetchProject.mockResolvedValue(newerProject)
    await renderWithProjects([newerProject])

    fireEvent.click(screen.getByRole('link', { name: 'Newer Project' }))

    expect(
      await screen.findByRole('heading', {
        name: 'Newer Project',
        level: 1,
      }),
    ).toBeInTheDocument()
    expect(locationText()).toBe(`/projects/${newerProject.id}`)
    expect(projectsMock.fetchProject).toHaveBeenCalledWith(newerProject.id)
  })

  it('shows an alert and retries after an initial list failure', async () => {
    projectsMock.fetchProjects
      .mockRejectedValueOnce(new Error('permission denied for table projects'))
      .mockResolvedValueOnce([newerProject])

    renderProjects()

    const alert = await screen.findByRole('alert')
    expect(alert).toHaveTextContent('Could not load your projects.')
    expect(alert).not.toHaveTextContent('permission denied')
    expect(screen.queryByText('No projects yet.')).not.toBeInTheDocument()

    fireEvent.click(within(alert).getByRole('button', { name: 'Retry' }))

    expect(
      await screen.findByRole('link', { name: 'Newer Project' }),
    ).toBeInTheDocument()
    await waitFor(() => {
      expect(screen.queryByRole('alert')).not.toBeInTheDocument()
    })
    expect(projectsMock.fetchProjects).toHaveBeenCalledTimes(2)
  })

  it('keeps loaded rows when a refetch fails and shows the retry alert', async () => {
    await renderWithProjects([newerProject])
    expect(screen.getByRole('link', { name: 'Newer Project' })).toBeVisible()

    projectsMock.fetchProjects.mockRejectedValueOnce(
      new Error('network unavailable'),
    )
    await act(async () => {
      await queryClient.invalidateQueries({
        queryKey: projectsQueryKey('user-1'),
      })
    })

    const alert = await screen.findByRole('alert')
    expect(alert).toHaveTextContent('Could not load your projects.')
    expect(screen.getByRole('link', { name: 'Newer Project' })).toBeVisible()
    expect(screen.queryByText('No projects yet.')).not.toBeInTheDocument()

    projectsMock.fetchProjects.mockResolvedValueOnce([newerProject])
    fireEvent.click(within(alert).getByRole('button', { name: 'Retry' }))

    await waitFor(() => {
      expect(screen.queryByRole('alert')).not.toBeInTheDocument()
    })
    expect(screen.getByRole('link', { name: 'Newer Project' })).toBeVisible()
  })

  it('renders two same-name projects as separate rows without a uniqueness error', async () => {
    const duplicateA: ProjectSummary = {
      id: '10000000-0000-4000-8000-000000000011',
      name: 'Same name',
      created_at: '2026-10-30T10:00:00.000Z',
    }
    const duplicateB: ProjectSummary = {
      id: '10000000-0000-4000-8000-000000000012',
      name: 'Same name',
      created_at: '2026-10-30T09:00:00.000Z',
    }

    await renderWithProjects([duplicateA, duplicateB])

    expect(screen.getAllByRole('link', { name: 'Same name' })).toHaveLength(2)
    expect(
      screen.queryByText(/already exists|must be unique|unique/i),
    ).not.toBeInTheDocument()
  })

  it.each([
    ['an empty name', ''],
    ['a whitespace-only name', '   '],
    ['a tab-and-newline-only name', '\t\n'],
  ])('rejects %s without calling the API', async (_label, name) => {
    await renderWithProjects([])
    const input = screen.getByLabelText('Project name')

    if (name) {
      fireEvent.change(input, { target: { value: name } })
    }
    fireEvent.click(screen.getByRole('button', { name: 'Create project' }))

    expect(await screen.findByText('Enter a project name.')).toBeInTheDocument()
    expect(projectsMock.createProject).not.toHaveBeenCalled()
    expect(locationText()).toBe('/projects')
  })

  it('rejects a trimmed name longer than 100 characters without truncating the input', async () => {
    await renderWithProjects([])
    const input = screen.getByLabelText('Project name')
    const overlong = ` ${'a'.repeat(101)} `
    fireEvent.change(input, { target: { value: overlong } })
    fireEvent.click(screen.getByRole('button', { name: 'Create project' }))

    expect(
      await screen.findByText('Use 100 characters or fewer.'),
    ).toBeInTheDocument()
    expect(input).toHaveValue(overlong)
    expect(projectsMock.createProject).not.toHaveBeenCalled()
    expect(locationText()).toBe('/projects')
  })

  it.each([
    ['a one-character name', 'A', 'A'],
    ['a 100-character name', 'b'.repeat(100), 'b'.repeat(100)],
    [
      'a 100-character name surrounded by spaces',
      ` ${'c'.repeat(100)} `,
      'c'.repeat(100),
    ],
  ])('submits %s after trimming', async (_label, entered, expectedName) => {
    const project: ProjectSummary = {
      ...createdProject,
      name: expectedName,
    }
    projectsMock.fetchProjects.mockResolvedValue([])
    projectsMock.fetchProject.mockResolvedValue(project)
    projectsMock.createProject.mockResolvedValue({
      id: project.id,
    })

    renderProjects()
    await screen.findByText('No projects yet.')

    const input = screen.getByLabelText('Project name')
    fireEvent.change(input, { target: { value: entered } })
    fireEvent.click(screen.getByRole('button', { name: 'Create project' }))

    await waitFor(() => {
      expect(projectsMock.createProject).toHaveBeenCalledWith({
        name: expectedName,
        ownerId: 'user-1',
      })
    })
    expect(
      await screen.findByRole('heading', {
        name: expectedName,
        level: 1,
      }),
    ).toBeInTheDocument()
    expect(locationText()).toBe(`/projects/${project.id}`)
  })

  it('trims before sending, invalidates the list, and returns to it without a reload', async () => {
    projectsMock.fetchProjects
      .mockResolvedValueOnce([])
      .mockResolvedValue([createdProject])
    projectsMock.fetchProject.mockResolvedValue(createdProject)
    projectsMock.createProject.mockResolvedValue({
      id: createdProject.id,
    })

    renderProjects()
    await screen.findByText('No projects yet.')

    fireEvent.change(screen.getByLabelText('Project name'), {
      target: { value: '  Team  ' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Create project' }))

    await waitFor(() => {
      expect(projectsMock.createProject).toHaveBeenCalledWith({
        name: 'Team',
        ownerId: 'user-1',
      })
    })
    expect(
      await screen.findByRole('heading', { name: 'Team', level: 1 }),
    ).toBeInTheDocument()
    expect(locationText()).toBe(`/projects/${createdProject.id}`)
    expect(projectsMock.fetchProjects).toHaveBeenCalledTimes(2)

    fireEvent.click(screen.getByRole('link', { name: 'Projects' }))

    const list = await screen.findByRole('list', { name: 'Your projects' })
    expect(within(list).getByRole('link', { name: 'Team' })).toBeInTheDocument()
    expect(screen.getByLabelText('Project name')).toHaveValue('')
  })

  it('disables the submit button, shows Creating…, and sends one insert on a rapid double click', async () => {
    const pending = deferred<CreatedProject>()
    projectsMock.fetchProjects.mockResolvedValue([])
    projectsMock.createProject.mockReturnValue(pending.promise)
    projectsMock.fetchProject.mockResolvedValue(createdProject)

    renderProjects()
    await screen.findByText('No projects yet.')

    const input = screen.getByLabelText('Project name')
    fireEvent.change(input, { target: { value: 'Team' } })

    const button = screen.getByRole('button', { name: 'Create project' })
    fireEvent.click(button)
    fireEvent.click(button)

    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Creating…' })).toBeDisabled()
    })
    expect(projectsMock.createProject).toHaveBeenCalledTimes(1)
    expect(input).toHaveValue('Team')
    expect(screen.queryByRole('link', { name: 'Team' })).not.toBeInTheDocument()

    await act(async () => {
      pending.resolve({ id: createdProject.id })
    })

    expect(
      await screen.findByRole('heading', { name: 'Team', level: 1 }),
    ).toBeInTheDocument()
    expect(projectsMock.createProject).toHaveBeenCalledTimes(1)
  })

  it('stays on the list, keeps the name, re-enables the button, and hides raw errors on failure', async () => {
    projectsMock.fetchProjects.mockResolvedValue([])
    projectsMock.createProject.mockRejectedValue(
      new Error(
        'duplicate key value violates unique constraint "projects_name_check"',
      ),
    )

    renderProjects()
    await screen.findByText('No projects yet.')

    const input = screen.getByLabelText('Project name')
    fireEvent.change(input, { target: { value: 'Team' } })
    fireEvent.click(screen.getByRole('button', { name: 'Create project' }))

    expect(
      await screen.findByText('Could not create the project. Try again.'),
    ).toBeVisible()
    await waitFor(() => {
      expect(
        screen.getByRole('button', { name: 'Create project' }),
      ).toBeEnabled()
    })
    expect(locationText()).toBe('/projects')
    expect(input).toHaveValue('Team')
    expect(screen.queryByText(/duplicate key/i)).not.toBeInTheDocument()
    expect(screen.queryByText(/constraint/i)).not.toBeInTheDocument()
  })
})
