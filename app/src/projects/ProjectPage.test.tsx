import { act, fireEvent, screen, waitFor, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { CycleSummary, ProjectCycles } from '../cycles/cyclesApi'
import { cycleStatusLabel, type CycleStatus } from '../cycles/cycleStatus'
import { CyclesApiError } from '../cycles/cyclesErrors'
import { deferred, mockRestoredSession } from '../test/authMock'
import { cyclesMock } from '../test/cyclesMock'
import { membersMock } from '../test/membersMock'
import { profileMock } from '../test/profileMock'
import { projectsMock } from '../test/projectsMock'
import { renderApp } from '../test/renderApp'
import type { ProjectMember } from './membersApi'
import type { ProjectSummary } from './projectsApi'

const project: ProjectSummary = {
  id: '10000000-0000-4000-8000-000000000001',
  name: 'Alpha Project',
  created_at: '2026-10-30T12:00:00.000Z',
}

const me = (role: 'facilitator' | 'member', isOwner: boolean) =>
  ({
    userId: 'user-1',
    displayName: 'Dev User',
    role,
    isOwner,
    isMe: true,
    joinedAt: '2026-10-30T12:00:00.000Z',
  }) satisfies ProjectMember

const other = (role: 'facilitator' | 'member') =>
  ({
    userId: 'user-2',
    displayName: 'Other',
    role,
    isOwner: false,
    isMe: false,
    joinedAt: '2026-10-30T12:00:00.000Z',
  }) satisfies ProjectMember

const asFacilitator: ProjectMember[] = [
  me('facilitator', true),
  other('member'),
]
// The owner after handing the role to someone else is a plain member.
const asMember: ProjectMember[] = [me('member', true), other('facilitator')]

const openCycle: CycleSummary = {
  id: '30000000-0000-4000-8000-000000000001',
  title: 'Week of Oct 26, 2026',
  weekStart: '2026-10-26',
  status: 'collecting',
  createdAt: '2026-10-30T12:00:00.000Z',
  closedAt: null,
}

const pastCycles: CycleSummary[] = [
  {
    id: '30000000-0000-4000-8000-000000000003',
    title: 'Retro two',
    weekStart: '2026-10-19',
    status: 'closed',
    createdAt: '2026-10-20T12:00:00.000Z',
    closedAt: '2026-10-24T12:00:00.000Z',
  },
  {
    id: '30000000-0000-4000-8000-000000000002',
    title: 'Retro one',
    weekStart: '2026-10-12',
    status: 'closed',
    createdAt: '2026-10-13T12:00:00.000Z',
    closedAt: '2026-10-17T12:00:00.000Z',
  },
]

afterEach(() => {
  vi.useRealTimers()
})

/** Fixes the browser's local clock; timers stay real. */
function setLocalNow(date: Date): void {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(date)
}

interface RenderOptions {
  readonly members?: ProjectMember[]
  readonly cycles?: ProjectCycles
}

function renderProject(path: string, options: RenderOptions = {}) {
  mockRestoredSession()
  profileMock.fetchProfileDisplayName.mockResolvedValue('Dev User')
  membersMock.fetchProjectMembers.mockResolvedValue(
    options.members ?? asFacilitator,
  )
  if (options.cycles) {
    cyclesMock.fetchProjectCycles.mockResolvedValue(options.cycles)
  }
  return renderApp({ initialEntries: [path] })
}

function renderFound(options: RenderOptions = {}) {
  projectsMock.fetchProject.mockResolvedValue(project)
  return renderProject(`/projects/${project.id}`, options)
}

async function openForm() {
  fireEvent.click(await screen.findByRole('button', { name: 'New cycle' }))
  return screen.findByRole('form', { name: 'New cycle' })
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
  ])(
    'shows the not-found state for %s and makes no cycles request',
    async (_label, id) => {
      projectsMock.fetchProject.mockResolvedValue(null)

      renderProject(`/projects/${id}`)

      expect(
        await screen.findByText('Project not found or you do not have access.'),
      ).toBeInTheDocument()
      expect(
        screen.getByRole('link', { name: 'Back to projects' }),
      ).toHaveAttribute('href', '/projects')
      expect(
        screen.queryByRole('heading', { level: 1 }),
      ).not.toBeInTheDocument()
      expect(
        screen.queryByRole('link', { name: 'Members' }),
      ).not.toBeInTheDocument()
      expect(screen.queryByText('Current cycle')).not.toBeInTheDocument()
      expect(projectsMock.fetchProject).toHaveBeenCalledWith(id)
      expect(cyclesMock.fetchProjectCycles).not.toHaveBeenCalled()
    },
  )

  it('shows the project name, UTC created date, and Members link without the placeholder', async () => {
    renderFound()

    expect(
      await screen.findByRole('heading', {
        name: 'Alpha Project',
        level: 1,
      }),
    ).toBeInTheDocument()
    expect(screen.getAllByText('Oct 30, 2026').length).toBeGreaterThan(0)
    expect(
      screen.queryByText('This screen is not built yet.'),
    ).not.toBeInTheDocument()
    expect(screen.queryByText(/2026-10-30T/)).not.toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'Members' })).toHaveAttribute(
      'href',
      `/projects/${project.id}/members`,
    )
    expect(
      await screen.findByRole('heading', { name: 'Current cycle', level: 2 }),
    ).toBeInTheDocument()
    expect(cyclesMock.fetchProjectCycles).toHaveBeenCalledWith(project.id)
  })

  it('lets a member who is not the owner open the project and its members link', async () => {
    renderFound({ members: [other('facilitator'), { ...me('member', false) }] })

    expect(
      await screen.findByRole('heading', { name: 'Alpha Project', level: 1 }),
    ).toBeInTheDocument()
    fireEvent.click(screen.getByRole('link', { name: 'Members' }))
    expect(await screen.findByTestId('location')).toHaveTextContent(
      `/projects/${project.id}/members`,
    )
  })
})

describe('ProjectPage cycles', () => {
  it('shows the open cycle with a Close cycle button for the facilitator', async () => {
    renderFound({ cycles: { current: openCycle, past: [] } })

    const heading = await screen.findByRole('heading', {
      name: 'Week of Oct 26, 2026',
      level: 3,
    })
    expect(heading).toBeVisible()
    expect(screen.getByText('Collecting feedback')).toBeVisible()
    expect(
      screen.getByText('Week of Oct 26, 2026', { selector: 'p' }),
    ).toBeVisible()
    expect(screen.getByText('Opened Oct 30, 2026')).toBeVisible()
    expect(
      await screen.findByRole('button', { name: 'Close cycle' }),
    ).toBeVisible()
    expect(
      screen.queryByRole('button', { name: 'New cycle' }),
    ).not.toBeInTheDocument()
  })

  it('shows the open cycle to a member with no cycle actions', async () => {
    renderFound({ members: asMember, cycles: { current: openCycle, past: [] } })

    expect(
      await screen.findByRole('heading', { name: 'Week of Oct 26, 2026' }),
    ).toBeVisible()
    await waitFor(() => {
      expect(membersMock.fetchProjectMembers).toHaveBeenCalledWith(project.id)
    })
    expect(
      screen.queryByRole('button', { name: 'Close cycle' }),
    ).not.toBeInTheDocument()
    expect(
      screen.queryByRole('button', { name: 'New cycle' }),
    ).not.toBeInTheDocument()
  })

  it.each<[CycleStatus, string]>([
    ['collecting', 'Collecting feedback'],
    ['reveal', 'Revealed'],
    ['cluster', 'Clustering'],
    ['vote', 'Voting'],
    ['discuss', 'Discussing'],
  ])('labels the %s status as text', async (status, label) => {
    renderFound({
      cycles: {
        current: {
          ...openCycle,
          status,
          title: 'Status cycle',
        },
        past: [],
      },
    })

    expect(await screen.findByText(label)).toBeVisible()
    expect(cycleStatusLabel(status)).toBe(label)
  })

  it('labels the closed status Closed', () => {
    expect(cycleStatusLabel('closed')).toBe('Closed')
  })

  it('offers the facilitator a New cycle button when no cycle is open', async () => {
    renderFound()

    expect(await screen.findByText('No open feedback cycle.')).toBeVisible()
    expect(
      await screen.findByText("Start a cycle to collect this week's feedback."),
    ).toBeVisible()
    expect(screen.getByRole('button', { name: 'New cycle' })).toBeVisible()
    expect(
      screen.queryByText('The facilitator has not started a cycle yet.'),
    ).not.toBeInTheDocument()
  })

  it('tells a member the facilitator has not started a cycle', async () => {
    renderFound({ members: asMember })

    expect(await screen.findByText('No open feedback cycle.')).toBeVisible()
    expect(
      await screen.findByText('The facilitator has not started a cycle yet.'),
    ).toBeVisible()
    expect(
      screen.queryByRole('button', { name: 'New cycle' }),
    ).not.toBeInTheDocument()
    expect(
      screen.queryByText("Start a cycle to collect this week's feedback."),
    ).not.toBeInTheDocument()
  })

  it('lists past cycles newest first with their week and closed date', async () => {
    renderFound({ cycles: { current: null, past: pastCycles } })

    const list = await screen.findByRole('list', { name: 'Past cycles' })
    const items = within(list).getAllByRole('listitem')
    expect(items).toHaveLength(2)
    expect(items[0]).toHaveTextContent('Retro two')
    expect(items[0]).toHaveTextContent('Week of Oct 19, 2026')
    expect(items[0]).toHaveTextContent('Closed Oct 24, 2026')
    expect(items[1]).toHaveTextContent('Retro one')
    expect(items[1]).toHaveTextContent('Week of Oct 12, 2026')
    expect(items[1]).toHaveTextContent('Closed Oct 17, 2026')
    expect(screen.queryByText('No past cycles yet.')).not.toBeInTheDocument()
  })

  it('shows the empty past-cycles state', async () => {
    renderFound()

    expect(
      await screen.findByRole('heading', { name: 'Past cycles', level: 2 }),
    ).toBeVisible()
    expect(screen.getByText('No past cycles yet.')).toBeVisible()
  })

  it('shows a loading status while the cycles query is pending', async () => {
    const pending = deferred<ProjectCycles>()
    cyclesMock.fetchProjectCycles.mockReturnValue(pending.promise)
    renderFound()

    expect(await screen.findByText('Loading cycles…')).toHaveAttribute(
      'role',
      'status',
    )
    expect(
      screen.getByRole('heading', { name: 'Alpha Project', level: 1 }),
    ).toBeVisible()

    await act(async () => {
      pending.resolve({ current: null, past: [] })
    })
    expect(screen.queryByText('Loading cycles…')).not.toBeInTheDocument()
  })

  it('shows an alert with Retry when the cycles query fails, keeping the project visible', async () => {
    cyclesMock.fetchProjectCycles
      .mockRejectedValueOnce(new CyclesApiError('unknown'))
      .mockResolvedValueOnce({ current: openCycle, past: [] })
    renderFound()

    const alert = await screen.findByRole('alert')
    expect(alert).toHaveTextContent('Could not load the cycles.')
    expect(
      screen.getByRole('heading', { name: 'Alpha Project', level: 1 }),
    ).toBeVisible()
    expect(screen.getByRole('link', { name: 'Members' })).toBeVisible()

    fireEvent.click(within(alert).getByRole('button', { name: 'Retry' }))

    expect(
      await screen.findByRole('heading', { name: 'Week of Oct 26, 2026' }),
    ).toBeVisible()
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
    expect(cyclesMock.fetchProjectCycles).toHaveBeenCalledTimes(2)
  })

  it.each(['Pacific/Pago_Pago', 'Pacific/Kiritimati', 'UTC'])(
    'shows week_start 2026-10-26 as Week of Oct 26, 2026 in %s',
    async (zone) => {
      vi.stubEnv('TZ', zone)
      renderFound({
        cycles: { current: { ...openCycle, title: 'TZ cycle' }, past: [] },
      })

      expect(await screen.findByText('Week of Oct 26, 2026')).toBeVisible()
    },
  )

  it('lets a 100-character title wrap', async () => {
    const longTitle = 'x'.repeat(100)
    renderFound({
      cycles: {
        current: { ...openCycle, title: longTitle },
        past: [{ ...pastCycles[0], title: longTitle }],
      },
    })

    const heading = await screen.findByRole('heading', { name: longTitle })
    expect(heading.className).toContain('[overflow-wrap:anywhere]')
    expect(heading.className).toContain('min-w-0')
  })
})

describe('ProjectPage feedback link', () => {
  const feedbackHref = `/cycles/${openCycle.id}/feedback`

  it.each<[string, ProjectMember[]]>([
    ['the facilitator', asFacilitator],
    ['a member', asMember],
  ])(
    'shows %s an Add feedback link while the cycle is collecting',
    async (_label, members) => {
      renderFound({ members, cycles: { current: openCycle, past: [] } })

      const link = await screen.findByRole('link', { name: 'Add feedback' })
      expect(link).toHaveAttribute('href', feedbackHref)
      expect(
        screen.queryByRole('link', { name: 'View my feedback' }),
      ).not.toBeInTheDocument()
    },
  )

  it.each<CycleStatus>(['reveal', 'cluster', 'vote', 'discuss'])(
    'shows View my feedback while the cycle is %s',
    async (status) => {
      renderFound({
        members: asMember,
        cycles: { current: { ...openCycle, status }, past: [] },
      })

      const link = await screen.findByRole('link', {
        name: 'View my feedback',
      })
      expect(link).toHaveAttribute('href', feedbackHref)
      expect(
        screen.queryByRole('link', { name: 'Add feedback' }),
      ).not.toBeInTheDocument()
    },
  )

  it('shows no feedback link with no open cycle, and none for past cycles', async () => {
    renderFound({ cycles: { current: null, past: pastCycles } })

    expect(await screen.findByText('Retro two')).toBeVisible()
    expect(screen.getByText('No open feedback cycle.')).toBeVisible()
    expect(
      screen.queryByRole('link', { name: 'Add feedback' }),
    ).not.toBeInTheDocument()
    expect(
      screen.queryByRole('link', { name: 'View my feedback' }),
    ).not.toBeInTheDocument()
    expect(
      screen
        .queryAllByRole('link')
        .some((link) => link.getAttribute('href')?.startsWith('/cycles/')),
    ).toBe(false)
  })
})

describe('ProjectPage create cycle form', () => {
  it('prefills the title and week from the local date and lists three weeks', async () => {
    // Wednesday 2026-10-28, local time.
    setLocalNow(new Date(2026, 9, 28, 10, 0))
    renderFound()

    const form = await openForm()
    expect(within(form).getByLabelText('Title')).toHaveValue(
      'Week of Oct 26, 2026',
    )
    const week = within(form).getByLabelText('Week')
    expect(week).toHaveValue('2026-10-26')
    expect(
      within(week)
        .getAllByRole('option')
        .map((option) => option.textContent),
    ).toEqual([
      'Last week (Oct 19, 2026)',
      'This week (Oct 26, 2026)',
      'Next week (Nov 2, 2026)',
    ])
  })

  it.each([
    ['Sunday 2026-11-01 23:30', new Date(2026, 10, 1, 23, 30), '2026-10-26'],
    ['Monday 2026-11-02 00:10', new Date(2026, 10, 2, 0, 10), '2026-11-02'],
  ])('defaults to the local week at %s', async (_label, now, expectedWeek) => {
    // A zone where these local times fall on another UTC date.
    vi.stubEnv(
      'TZ',
      expectedWeek === '2026-10-26'
        ? 'America/Los_Angeles'
        : 'Pacific/Kiritimati',
    )
    setLocalNow(now)
    renderFound()

    const form = await openForm()
    expect(within(form).getByLabelText('Week')).toHaveValue(expectedWeek)
  })

  it('updates an unedited title when the week changes', async () => {
    setLocalNow(new Date(2026, 9, 28, 10, 0))
    renderFound()

    const form = await openForm()
    fireEvent.change(within(form).getByLabelText('Week'), {
      target: { value: '2026-11-02' },
    })
    await waitFor(() => {
      expect(within(form).getByLabelText('Title')).toHaveValue(
        'Week of Nov 2, 2026',
      )
    })
  })

  it('keeps an edited title when the week changes', async () => {
    setLocalNow(new Date(2026, 9, 28, 10, 0))
    renderFound()

    const form = await openForm()
    const title = within(form).getByLabelText('Title')
    fireEvent.change(title, { target: { value: 'My retro' } })
    fireEvent.change(within(form).getByLabelText('Week'), {
      target: { value: '2026-10-19' },
    })
    await waitFor(() => {
      expect(within(form).getByLabelText('Week')).toHaveValue('2026-10-19')
    })
    expect(title).toHaveValue('My retro')
  })

  it('starts a cycle, shows a toast, closes the form, and shows the new cycle', async () => {
    setLocalNow(new Date(2026, 9, 28, 10, 0))
    cyclesMock.createCycle.mockResolvedValue({
      id: openCycle.id,
      projectId: project.id,
      title: '  Kickoff  ',
      weekStart: '2026-10-26',
      status: 'collecting',
      createdAt: openCycle.createdAt,
    })
    renderFound()

    const form = await openForm()
    fireEvent.change(within(form).getByLabelText('Title'), {
      target: { value: '  Kickoff  ' },
    })
    cyclesMock.fetchProjectCycles.mockResolvedValue({
      current: { ...openCycle, title: 'Kickoff' },
      past: [],
    })
    fireEvent.click(within(form).getByRole('button', { name: 'Start cycle' }))

    expect(await screen.findByText('Cycle started.')).toBeInTheDocument()
    expect(cyclesMock.createCycle).toHaveBeenCalledTimes(1)
    expect(cyclesMock.createCycle).toHaveBeenCalledWith({
      projectId: project.id,
      title: 'Kickoff',
      weekStart: '2026-10-26',
    })
    expect(
      await screen.findByRole('heading', { name: 'Kickoff', level: 3 }),
    ).toBeVisible()
    expect(
      screen.queryByRole('form', { name: 'New cycle' }),
    ).not.toBeInTheDocument()
    expect(cyclesMock.fetchProjectCycles).toHaveBeenCalledTimes(2)
    expect(
      screen.queryByRole('button', { name: 'New cycle' }),
    ).not.toBeInTheDocument()
  })

  it.each([
    ['a blank title', '   ', 'Enter a cycle title.'],
    ['a 101-character title', 'x'.repeat(101), 'Use 100 characters or fewer.'],
  ])('rejects %s inline without a request', async (_label, value, message) => {
    renderFound()

    const form = await openForm()
    const title = within(form).getByLabelText('Title')
    fireEvent.change(title, { target: { value } })
    fireEvent.click(within(form).getByRole('button', { name: 'Start cycle' }))

    expect(await within(form).findByText(message)).toBeVisible()
    expect(title).toHaveAttribute('aria-invalid', 'true')
    expect(cyclesMock.createCycle).not.toHaveBeenCalled()
  })

  it('accepts a 100-character title', async () => {
    const pending = deferred<never>()
    cyclesMock.createCycle.mockReturnValue(pending.promise)
    renderFound()

    const form = await openForm()
    fireEvent.change(within(form).getByLabelText('Title'), {
      target: { value: 'x'.repeat(100) },
    })
    fireEvent.click(within(form).getByRole('button', { name: 'Start cycle' }))

    await waitFor(() => {
      expect(cyclesMock.createCycle).toHaveBeenCalledTimes(1)
    })
  })

  it('sends one request on a double click and disables the button while pending', async () => {
    const pending = deferred<never>()
    cyclesMock.createCycle.mockReturnValue(pending.promise)
    renderFound()

    const form = await openForm()
    const submit = within(form).getByRole('button', { name: 'Start cycle' })
    fireEvent.click(submit)
    fireEvent.click(submit)

    expect(
      await within(form).findByRole('button', { name: 'Starting…' }),
    ).toBeDisabled()
    fireEvent.click(within(form).getByRole('button', { name: 'Starting…' }))
    expect(cyclesMock.createCycle).toHaveBeenCalledTimes(1)
  })

  it('cycle_already_open shows its message, refetches, and keeps the input', async () => {
    cyclesMock.createCycle.mockRejectedValue(
      new CyclesApiError('cycle_already_open'),
    )
    renderFound()

    const form = await openForm()
    fireEvent.change(within(form).getByLabelText('Title'), {
      target: { value: 'My retro' },
    })
    fireEvent.click(within(form).getByRole('button', { name: 'Start cycle' }))

    expect(
      await screen.findByText('This project already has an open cycle.'),
    ).toBeInTheDocument()
    await waitFor(() => {
      expect(cyclesMock.fetchProjectCycles).toHaveBeenCalledTimes(2)
    })
    expect(within(form).getByLabelText('Title')).toHaveValue('My retro')
  })

  it('not_project_facilitator shows its message and refetches the members', async () => {
    cyclesMock.createCycle.mockRejectedValue(
      new CyclesApiError('not_project_facilitator'),
    )
    renderFound()

    const form = await openForm()
    await waitFor(() => {
      expect(membersMock.fetchProjectMembers).toHaveBeenCalledTimes(1)
    })
    membersMock.fetchProjectMembers.mockResolvedValue(asMember)
    fireEvent.click(within(form).getByRole('button', { name: 'Start cycle' }))

    expect(
      await screen.findByText('Only the facilitator can start a cycle.'),
    ).toBeInTheDocument()
    await waitFor(() => {
      expect(membersMock.fetchProjectMembers).toHaveBeenCalledTimes(2)
    })
    expect(
      await screen.findByText('The facilitator has not started a cycle yet.'),
    ).toBeVisible()
  })

  it.each(['not_project_member', 'invalid_week_start', 'unknown'] as const)(
    '%s shows the generic message and keeps the input',
    async (code) => {
      cyclesMock.createCycle.mockRejectedValue(new CyclesApiError(code))
      renderFound()

      const form = await openForm()
      fireEvent.change(within(form).getByLabelText('Title'), {
        target: { value: 'My retro' },
      })
      fireEvent.click(within(form).getByRole('button', { name: 'Start cycle' }))

      expect(
        await screen.findByText('Could not start the cycle.'),
      ).toBeInTheDocument()
      expect(within(form).getByLabelText('Title')).toHaveValue('My retro')
      expect(screen.queryByText(code)).not.toBeInTheDocument()
      expect(
        within(form).getByRole('button', { name: 'Start cycle' }),
      ).toBeEnabled()
    },
  )

  it('Cancel closes the form without a request', async () => {
    renderFound()

    const form = await openForm()
    fireEvent.click(within(form).getByRole('button', { name: 'Cancel' }))

    expect(
      screen.queryByRole('form', { name: 'New cycle' }),
    ).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'New cycle' })).toBeVisible()
    expect(cyclesMock.createCycle).not.toHaveBeenCalled()
  })
})

describe('ProjectPage close cycle', () => {
  const confirmCopy =
    'Closing ends this cycle for everyone. Feedback can no longer be added and the cycle cannot be reopened.'

  it('asks for confirmation, and Cancel makes no request', async () => {
    renderFound({ cycles: { current: openCycle, past: [] } })

    fireEvent.click(await screen.findByRole('button', { name: 'Close cycle' }))
    expect(screen.getByText(confirmCopy)).toBeVisible()
    expect(screen.getAllByRole('button', { name: 'Close cycle' })).toHaveLength(
      1,
    )

    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(screen.queryByText(confirmCopy)).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Close cycle' })).toBeVisible()
    expect(cyclesMock.closeCycle).not.toHaveBeenCalled()
  })

  it('closes the cycle, moves it to Past cycles, and shows New cycle', async () => {
    cyclesMock.closeCycle.mockResolvedValue({
      id: openCycle.id,
      status: 'closed',
      closedAt: '2026-10-31T12:00:00.000Z',
    })
    renderFound({ cycles: { current: openCycle, past: [] } })

    fireEvent.click(await screen.findByRole('button', { name: 'Close cycle' }))
    cyclesMock.fetchProjectCycles.mockResolvedValue({
      current: null,
      past: [
        {
          ...openCycle,
          status: 'closed',
          closedAt: '2026-10-31T12:00:00.000Z',
        },
      ],
    })
    const confirm = screen.getByRole('button', { name: 'Close cycle' })
    fireEvent.click(confirm)
    fireEvent.click(confirm)

    expect(await screen.findByText('Cycle closed.')).toBeInTheDocument()
    expect(cyclesMock.closeCycle).toHaveBeenCalledTimes(1)
    expect(cyclesMock.closeCycle).toHaveBeenCalledWith(openCycle.id)
    const list = await screen.findByRole('list', { name: 'Past cycles' })
    expect(list).toHaveTextContent('Week of Oct 26, 2026')
    expect(list).toHaveTextContent('Closed Oct 31, 2026')
    expect(screen.getByText('No open feedback cycle.')).toBeVisible()
    expect(screen.getByRole('button', { name: 'New cycle' })).toBeVisible()
  })

  it('not_project_facilitator keeps the cycle current and refetches the members', async () => {
    cyclesMock.closeCycle.mockRejectedValue(
      new CyclesApiError('not_project_facilitator'),
    )
    renderFound({ cycles: { current: openCycle, past: [] } })

    fireEvent.click(await screen.findByRole('button', { name: 'Close cycle' }))
    membersMock.fetchProjectMembers.mockResolvedValue(asMember)
    fireEvent.click(screen.getByRole('button', { name: 'Close cycle' }))

    expect(
      await screen.findByText('Only the facilitator can close the cycle.'),
    ).toBeInTheDocument()
    await waitFor(() => {
      expect(
        screen.queryByRole('button', { name: 'Close cycle' }),
      ).not.toBeInTheDocument()
    })
    expect(
      screen.getByRole('heading', { name: 'Week of Oct 26, 2026' }),
    ).toBeVisible()
  })

  it('any other failure shows the generic message and the cycle stays current', async () => {
    cyclesMock.closeCycle.mockRejectedValue(new CyclesApiError('unknown'))
    renderFound({ cycles: { current: openCycle, past: [] } })

    fireEvent.click(await screen.findByRole('button', { name: 'Close cycle' }))
    fireEvent.click(screen.getByRole('button', { name: 'Close cycle' }))

    expect(
      await screen.findByText('Could not close the cycle.'),
    ).toBeInTheDocument()
    expect(
      screen.getByRole('heading', { name: 'Week of Oct 26, 2026' }),
    ).toBeVisible()
    expect(screen.getByRole('button', { name: 'Close cycle' })).toBeVisible()
    expect(screen.queryByText('No past cycles yet.')).toBeVisible()
  })
})
