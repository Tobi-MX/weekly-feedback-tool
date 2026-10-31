import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from '@testing-library/react'
import { MemoryRouter, useLocation, useNavigate } from 'react-router-dom'
import { describe, expect, it } from 'vitest'
import App from '../App'
import { queryClient } from '../lib/queryClient'
import {
  deferred,
  mockEmptySession,
  mockRestoredSession,
} from '../test/authMock'
import { membersMock } from '../test/membersMock'
import { profileMock } from '../test/profileMock'
import { projectsMock } from '../test/projectsMock'
import { renderApp } from '../test/renderApp'
import { safeRedirectPath } from '../auth/redirectPath'
import type { JoinProjectResult } from './membersApi'
import { MembersApiError } from './membersErrors'
import type { ProjectSummary } from './projectsApi'
import { projectsQueryKey } from './useProjects'

const USER_ID = 'user-b'
const TOKEN = '0123456789abcdef'.repeat(4)

const project: ProjectSummary = {
  id: '10000000-0000-4000-8000-000000000001',
  name: 'Alpha Project',
  created_at: '2026-10-30T12:00:00.000Z',
}

const joined: JoinProjectResult = {
  projectId: project.id,
  projectName: project.name,
  alreadyMember: false,
}

function locationText(): string {
  return screen.getByTestId('location').textContent ?? ''
}

function renderJoin(
  token = TOKEN,
  options: { strictMode?: boolean; navigationLog?: string[] } = {},
) {
  mockRestoredSession('b@example.com', USER_ID)
  profileMock.fetchProfileDisplayName.mockResolvedValue('Bob')
  projectsMock.fetchProject.mockResolvedValue(project)
  return renderApp({ initialEntries: [`/join/${token}`], ...options })
}

describe('JoinProjectPage', () => {
  it('shows "Joining project…" while the join is pending', async () => {
    const pending = deferred<JoinProjectResult>()
    membersMock.joinProject.mockReturnValue(pending.promise)

    renderJoin()

    expect(await screen.findByText('Joining project…')).toHaveAttribute(
      'role',
      'status',
    )

    await act(async () => {
      pending.resolve(joined)
    })
  })

  it('joins once, refreshes projects, toasts, and replaces the history entry', async () => {
    membersMock.joinProject.mockResolvedValue(joined)
    projectsMock.fetchProjects.mockResolvedValue([])
    const log: string[] = []
    renderJoin(TOKEN, { navigationLog: log })

    expect(
      await screen.findByText('You joined Alpha Project.'),
    ).toBeInTheDocument()
    await waitFor(() => {
      expect(locationText()).toBe(`/projects/${project.id}`)
    })
    expect(
      await screen.findByRole('heading', { name: 'Alpha Project', level: 1 }),
    ).toBeInTheDocument()
    expect(membersMock.joinProject).toHaveBeenCalledTimes(1)
    expect(membersMock.joinProject).toHaveBeenCalledWith(TOKEN)
    expect(log).toEqual([`/join/${TOKEN}`, `/projects/${project.id}`])
  })

  it('a joined project appears in /projects without a reload', async () => {
    membersMock.joinProject.mockResolvedValue(joined)
    // The projects list was cached before joining and is now stale.
    queryClient.setQueryData(projectsQueryKey(USER_ID), [])
    projectsMock.fetchProjects.mockResolvedValue([project])
    renderJoin()

    await waitFor(() => {
      expect(locationText()).toBe(`/projects/${project.id}`)
    })
    expect(
      queryClient.getQueryState(projectsQueryKey(USER_ID))?.isInvalidated,
    ).toBe(true)
    fireEvent.click(screen.getAllByRole('link', { name: 'Projects' })[0])

    expect(
      await screen.findByRole('link', { name: 'Alpha Project' }),
    ).toBeInTheDocument()
  })

  it('tells an existing member they are already in the project', async () => {
    membersMock.joinProject.mockResolvedValue({
      ...joined,
      alreadyMember: true,
    })
    renderJoin()

    expect(
      await screen.findByText("You're already a member of Alpha Project."),
    ).toBeInTheDocument()
    await waitFor(() => {
      expect(locationText()).toBe(`/projects/${project.id}`)
    })
  })

  it('shows the invalid state for invite_invalid without navigating', async () => {
    membersMock.joinProject.mockRejectedValue(
      new MembersApiError('invite_invalid'),
    )
    renderJoin()

    const alert = await screen.findByRole('alert')
    expect(alert).toHaveTextContent(
      'This invite link is not valid. Ask the project owner for a new link.',
    )
    expect(
      within(alert).getByRole('link', { name: 'Go to projects' }),
    ).toHaveAttribute('href', '/projects')
    expect(locationText()).toBe(`/join/${TOKEN}`)
  })

  it('shows the expired state for invite_expired without navigating', async () => {
    membersMock.joinProject.mockRejectedValue(
      new MembersApiError('invite_expired'),
    )
    renderJoin()

    const alert = await screen.findByRole('alert')
    expect(alert).toHaveTextContent(
      'This invite link has expired. Ask the project owner for a new link.',
    )
    expect(
      within(alert).getByRole('link', { name: 'Go to projects' }),
    ).toBeInTheDocument()
    expect(locationText()).toBe(`/join/${TOKEN}`)
  })

  it.each(['abc', 'A'.repeat(64), 'z'.repeat(64), `${TOKEN}0`])(
    'shows the invalid state for the malformed token %j without calling the RPC',
    async (token) => {
      renderJoin(token)

      const alert = await screen.findByRole('alert')
      expect(alert).toHaveTextContent(
        'This invite link is not valid. Ask the project owner for a new link.',
      )
      expect(membersMock.joinProject).not.toHaveBeenCalled()
    },
  )

  it('shows a generic failure with Retry, and Retry joins', async () => {
    membersMock.joinProject
      .mockRejectedValueOnce(new MembersApiError('unknown'))
      .mockResolvedValueOnce(joined)
    renderJoin()

    const alert = await screen.findByRole('alert')
    expect(alert).toHaveTextContent('Could not join the project.')
    fireEvent.click(within(alert).getByRole('button', { name: 'Retry' }))

    expect(
      await screen.findByText('You joined Alpha Project.'),
    ).toBeInTheDocument()
    await waitFor(() => {
      expect(locationText()).toBe(`/projects/${project.id}`)
    })
    expect(membersMock.joinProject).toHaveBeenCalledTimes(2)
  })

  it('makes one request, one toast, and one navigation under StrictMode', async () => {
    membersMock.joinProject.mockResolvedValue(joined)
    const log: string[] = []
    renderJoin(TOKEN, { strictMode: true, navigationLog: log })

    await waitFor(() => {
      expect(locationText()).toBe(`/projects/${project.id}`)
    })
    expect(
      await screen.findByText('You joined Alpha Project.'),
    ).toBeInTheDocument()
    expect(screen.getAllByText('You joined Alpha Project.')).toHaveLength(1)
    expect(membersMock.joinProject).toHaveBeenCalledTimes(1)
    expect(log.filter((entry) => entry === `/projects/${project.id}`)).toEqual([
      `/projects/${project.id}`,
    ])
  })

  it('redirects a signed-out visitor to /login with redirectTo', async () => {
    mockEmptySession()
    renderApp({ initialEntries: [`/join/${TOKEN}`] })

    await waitFor(() => {
      expect(locationText()).toBe(`/login?redirectTo=%2Fjoin%2F${TOKEN}`)
    })
    expect(membersMock.joinProject).not.toHaveBeenCalled()
  })

  it('accepts /join/<token> unchanged as a post-sign-in redirect', () => {
    expect(safeRedirectPath(`/join/${TOKEN}`, 'http://localhost:5173')).toBe(
      `/join/${TOKEN}`,
    )
    expect(
      safeRedirectPath(
        encodeURIComponent(`/join/${TOKEN}`),
        'http://localhost:5173',
      ),
    ).toBe(`/join/${TOKEN}`)
  })

  it('navigates with replace so Back does not return to the invite link', async () => {
    membersMock.joinProject.mockResolvedValue(joined)
    mockRestoredSession('b@example.com', USER_ID)
    projectsMock.fetchProject.mockResolvedValue(project)

    function BackProbe() {
      const navigate = useNavigate()
      const location = useLocation()
      return (
        <>
          <output data-testid="probe-location">{location.pathname}</output>
          <button
            type="button"
            onClick={() => {
              void navigate(-1)
            }}
          >
            Test back
          </button>
        </>
      )
    }

    render(
      <MemoryRouter
        initialEntries={['/projects', `/join/${TOKEN}`]}
        initialIndex={1}
      >
        <App />
        <BackProbe />
      </MemoryRouter>,
    )

    await waitFor(() => {
      expect(screen.getByTestId('probe-location')).toHaveTextContent(
        `/projects/${project.id}`,
      )
    })
    fireEvent.click(screen.getByRole('button', { name: 'Test back' }))

    await waitFor(() => {
      expect(screen.getByTestId('probe-location').textContent).toBe('/projects')
    })
  })
})
