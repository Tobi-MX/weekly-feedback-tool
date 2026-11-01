import {
  act,
  cleanup,
  fireEvent,
  screen,
  waitFor,
  within,
} from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { queryClient } from '../lib/queryClient'
import type { ProjectMember } from '../projects/membersApi'
import type { ProjectSummary } from '../projects/projectsApi'
import { deferred, mockRestoredSession } from '../test/authMock'
import { cyclesMock } from '../test/cyclesMock'
import { membersMock } from '../test/membersMock'
import { profileMock } from '../test/profileMock'
import { projectsMock } from '../test/projectsMock'
import { renderApp } from '../test/renderApp'
import type {
  CycleSubmissionStatus,
  CycleSummary,
  ProjectCycles,
} from './cyclesApi'
import { cycleStatusLabel, type CycleStatus } from './cycleStatus'
import { CyclesApiError } from './cyclesErrors'
import { cycleStatusQueryKey } from './useCycles'

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
    displayName: 'Other Person',
    role,
    isOwner: false,
    isMe: false,
    joinedAt: '2026-10-30T12:00:00.000Z',
  }) satisfies ProjectMember

const asFacilitator: ProjectMember[] = [
  me('facilitator', true),
  other('member'),
]
const asMember: ProjectMember[] = [me('member', false), other('facilitator')]

const openCycle: CycleSummary = {
  id: '30000000-0000-4000-8000-000000000001',
  title: 'Week of Oct 26, 2026',
  weekStart: '2026-10-26',
  status: 'collecting',
  createdAt: '2026-10-30T12:00:00.000Z',
  closedAt: null,
}

const pastCycle: CycleSummary = {
  id: '30000000-0000-4000-8000-000000000002',
  title: 'Retro one',
  weekStart: '2026-10-19',
  status: 'closed',
  createdAt: '2026-10-20T12:00:00.000Z',
  closedAt: '2026-10-24T12:00:00.000Z',
}

function statusOf(
  overrides: Partial<CycleSubmissionStatus> = {},
): CycleSubmissionStatus {
  return {
    cycleId: openCycle.id,
    status: 'collecting',
    isRevealed: false,
    memberCount: 3,
    submittedMemberCount: 2,
    myCardCount: 1,
    cardCount: null,
    ...overrides,
  }
}

interface RenderOptions {
  readonly members?: ProjectMember[]
  readonly cycles?: ProjectCycles
  readonly status?: CycleSubmissionStatus
}

function renderPage(options: RenderOptions = {}) {
  mockRestoredSession()
  profileMock.fetchProfileDisplayName.mockResolvedValue('Dev User')
  projectsMock.fetchProject.mockResolvedValue(project)
  membersMock.fetchProjectMembers.mockResolvedValue(
    options.members ?? asFacilitator,
  )
  cyclesMock.fetchProjectCycles.mockResolvedValue(
    options.cycles ?? { current: openCycle, past: [] },
  )
  if (options.status) {
    cyclesMock.fetchCycleStatus.mockResolvedValue(options.status)
  }
  return renderApp({ initialEntries: [`/projects/${project.id}`] })
}

function findBlock() {
  return screen.findByRole('region', { name: 'Submission status' })
}

/** The block's text without the caller's own (last) line. */
function teamText(block: HTMLElement): string {
  const lines = within(block)
    .getAllByText(/./, { selector: 'p' })
    .map((line) => line.textContent ?? '')
  return lines.slice(0, -1).join('\n')
}

describe('SubmissionStatus while collecting', () => {
  it('shows the block with an h3 and requests the open cycle only', async () => {
    renderPage({ status: statusOf() })

    const block = await findBlock()
    expect(
      within(block).getByRole('heading', {
        name: 'Submission status',
        level: 3,
      }),
    ).toBeVisible()
    expect(
      await within(block).findByText('2 of 3 members have added feedback.'),
    ).toBeVisible()
    expect(cyclesMock.fetchCycleStatus).toHaveBeenCalledWith(openCycle.id)
    expect(cyclesMock.fetchCycleStatus).toHaveBeenCalledTimes(1)
  })

  it('shows some submissions without the no-one line', async () => {
    renderPage({ status: statusOf({ submittedMemberCount: 1 }) })

    const block = await findBlock()
    expect(
      await within(block).findByText('1 of 3 members have added feedback.'),
    ).toBeVisible()
    expect(
      within(block).queryByText('No one has added feedback yet.'),
    ).not.toBeInTheDocument()
  })

  it('shows zero submissions with the no-one line', async () => {
    renderPage({
      status: statusOf({ submittedMemberCount: 0, myCardCount: 0 }),
    })

    const block = await findBlock()
    expect(
      await within(block).findByText('0 of 3 members have added feedback.'),
    ).toBeVisible()
    expect(
      within(block).getByText('No one has added feedback yet.'),
    ).toBeVisible()
  })

  it('shows all submissions', async () => {
    renderPage({ status: statusOf({ submittedMemberCount: 3 }) })

    const block = await findBlock()
    expect(
      await within(block).findByText('3 of 3 members have added feedback.'),
    ).toBeVisible()
  })

  it('uses the singular for a one-member project', async () => {
    renderPage({
      status: statusOf({ memberCount: 1, submittedMemberCount: 1 }),
    })

    const block = await findBlock()
    expect(
      await within(block).findByText('1 of 1 member has added feedback.'),
    ).toBeVisible()
  })

  it.each([
    [0, 'You have not added feedback yet.'],
    [1, 'You have added 1 card.'],
    [4, 'You have added 4 cards.'],
  ])('shows the caller line for %i cards', async (myCardCount, line) => {
    renderPage({ status: statusOf({ myCardCount }) })

    const block = await findBlock()
    expect(await within(block).findByText(line)).toBeVisible()
  })

  it('shows no card total, names, per-member list, or times', async () => {
    renderPage({ status: statusOf() })

    const block = await findBlock()
    await within(block).findByText('2 of 3 members have added feedback.')
    expect(block).not.toHaveTextContent(/in total/)
    expect(block).not.toHaveTextContent(/Dev User|Other Person/)
    expect(block).not.toHaveTextContent(/anonymous/i)
    expect(block).not.toHaveTextContent(/start|stop|continue/i)
    expect(block).not.toHaveTextContent(/\d{1,2}:\d{2}|ago|Oct/)
    expect(within(block).queryByRole('list')).not.toBeInTheDocument()
    expect(within(block).queryByRole('img')).not.toBeInTheDocument()
  })
})

describe('SubmissionStatus after reveal', () => {
  it.each<CycleStatus>(['reveal', 'cluster', 'vote', 'discuss'])(
    'shows the ended copy with the total while %s',
    async (status) => {
      renderPage({
        cycles: { current: { ...openCycle, status }, past: [] },
        status: statusOf({
          status,
          isRevealed: true,
          cardCount: 5,
          myCardCount: 2,
        }),
      })

      const block = await findBlock()
      expect(
        await within(block).findByText(
          'Feedback collection has ended. 2 of 3 members added feedback, 5 cards in total.',
        ),
      ).toBeVisible()
      expect(within(block).getByText('You added 2 cards.')).toBeVisible()
      // The status label stays #10's.
      expect(screen.getByText(cycleStatusLabel(status))).toBeVisible()
    },
  )

  it('uses the singular for one card', async () => {
    renderPage({
      cycles: { current: { ...openCycle, status: 'reveal' }, past: [] },
      status: statusOf({
        status: 'reveal',
        isRevealed: true,
        memberCount: 1,
        submittedMemberCount: 1,
        cardCount: 1,
        myCardCount: 1,
      }),
    })

    const block = await findBlock()
    expect(
      await within(block).findByText(
        'Feedback collection has ended. 1 of 1 member added feedback, 1 card in total.',
      ),
    ).toBeVisible()
    expect(within(block).getByText('You added 1 card.')).toBeVisible()
  })

  it('leaves the total out when card_count is null', async () => {
    renderPage({
      cycles: { current: { ...openCycle, status: 'vote' }, past: [] },
      status: statusOf({
        status: 'vote',
        isRevealed: true,
        cardCount: null,
        myCardCount: 0,
      }),
    })

    const block = await findBlock()
    expect(
      await within(block).findByText(
        'Feedback collection has ended. 2 of 3 members added feedback.',
      ),
    ).toBeVisible()
    expect(block).not.toHaveTextContent(/in total/)
    expect(within(block).getByText('You added 0 cards.')).toBeVisible()
  })
})

describe('SubmissionStatus for every role', () => {
  it.each([
    ['collecting', statusOf()],
    [
      'revealed',
      statusOf({ status: 'reveal', isRevealed: true, cardCount: 6 }),
    ],
  ])(
    'the facilitator and a member see the same text apart from their own line (%s)',
    async (_label, data) => {
      const cycles: ProjectCycles = {
        current: { ...openCycle, status: data.status },
        past: [],
      }
      renderPage({
        members: asFacilitator,
        cycles,
        status: { ...data, myCardCount: 0 },
      })
      let block = await findBlock()
      await waitFor(() => {
        expect(within(block).getAllByText(/./, { selector: 'p' })).toHaveLength(
          2,
        )
      })
      expect(
        await screen.findByRole('button', { name: 'Close cycle' }),
      ).toBeVisible()
      const facilitatorText = teamText(block)
      const facilitatorLines = within(block).getAllByText(/./, {
        selector: 'p',
      }).length

      cleanup()
      queryClient.clear()

      renderPage({
        members: asMember,
        cycles,
        status: { ...data, myCardCount: 3 },
      })
      block = await findBlock()
      await waitFor(() => {
        expect(within(block).getAllByText(/./, { selector: 'p' })).toHaveLength(
          facilitatorLines,
        )
      })
      expect(teamText(block)).toBe(facilitatorText)
      expect(block).toHaveTextContent(/3 cards/)
    },
  )
})

describe('SubmissionStatus requests', () => {
  it('shows no block and sends no request with no open cycle, and none for past cycles', async () => {
    renderPage({ cycles: { current: null, past: [pastCycle] } })

    expect(await screen.findByText('Retro one')).toBeVisible()
    expect(screen.getByText('No open feedback cycle.')).toBeVisible()
    expect(
      screen.queryByRole('region', { name: 'Submission status' }),
    ).not.toBeInTheDocument()
    expect(screen.queryByText(/added feedback/)).not.toBeInTheDocument()
    expect(cyclesMock.fetchCycleStatus).not.toHaveBeenCalled()
  })

  it('re-reads on window focus and sets no polling interval', async () => {
    renderPage({ status: statusOf() })

    const block = await findBlock()
    await within(block).findByText('2 of 3 members have added feedback.')
    expect(cyclesMock.fetchCycleStatus).toHaveBeenCalledTimes(1)

    cyclesMock.fetchCycleStatus.mockResolvedValue(
      statusOf({ submittedMemberCount: 3 }),
    )
    act(() => {
      window.dispatchEvent(new Event('focus'))
    })

    expect(
      await within(block).findByText('3 of 3 members have added feedback.'),
    ).toBeVisible()
    expect(cyclesMock.fetchCycleStatus).toHaveBeenCalledTimes(2)

    const query = queryClient
      .getQueryCache()
      .find({ queryKey: cycleStatusQueryKey('user-1', openCycle.id) })
    expect(query).toBeDefined()
    const options = query?.options as Record<string, unknown> | undefined
    expect(options?.refetchInterval).toBeUndefined()
    expect(options?.refetchOnWindowFocus).toBe(true)
    expect(options?.refetchOnReconnect).toBe(true)
  })

  it('adds no second link to the feedback form', async () => {
    renderPage({ status: statusOf() })

    const block = await findBlock()
    await within(block).findByText('2 of 3 members have added feedback.')
    expect(within(block).queryByRole('link')).not.toBeInTheDocument()
    const formLinks = screen
      .getAllByRole('link')
      .filter((link) => link.getAttribute('href')?.startsWith('/cycles/'))
    expect(formLinks).toHaveLength(1)
    expect(formLinks[0]).toHaveTextContent('Add feedback')
  })

  it('goes away when the facilitator closes the cycle', async () => {
    cyclesMock.closeCycle.mockResolvedValue({
      id: openCycle.id,
      status: 'closed',
      closedAt: '2026-10-31T12:00:00.000Z',
    })
    renderPage({ status: statusOf() })

    await findBlock()
    fireEvent.click(await screen.findByRole('button', { name: 'Close cycle' }))
    cyclesMock.fetchProjectCycles.mockResolvedValue({
      current: null,
      past: [{ ...openCycle, status: 'closed', closedAt: '2026-10-31' }],
    })
    fireEvent.click(screen.getByRole('button', { name: 'Close cycle' }))

    expect(await screen.findByText('No open feedback cycle.')).toBeVisible()
    expect(
      screen.queryByRole('region', { name: 'Submission status' }),
    ).not.toBeInTheDocument()
  })
})

describe('SubmissionStatus loading and errors', () => {
  it('shows a loading status while the request is pending', async () => {
    const pending = deferred<CycleSubmissionStatus>()
    cyclesMock.fetchCycleStatus.mockReturnValue(pending.promise)
    renderPage()

    const block = await findBlock()
    expect(
      within(block).getByText('Loading submission status…'),
    ).toHaveAttribute('role', 'status')

    await act(async () => {
      pending.resolve(statusOf())
    })
    expect(
      await within(block).findByText('2 of 3 members have added feedback.'),
    ).toBeVisible()
  })

  it('shows an alert with Retry while the rest of the page still works', async () => {
    cyclesMock.fetchCycleStatus
      .mockRejectedValueOnce(new CyclesApiError('unknown'))
      .mockResolvedValueOnce(statusOf())
    renderPage()

    const block = await findBlock()
    const alert = await within(block).findByRole('alert')
    expect(alert).toHaveTextContent('Could not load submission status.')

    // The rest of the page renders and works.
    expect(
      screen.getByRole('heading', { name: 'Week of Oct 26, 2026', level: 3 }),
    ).toBeVisible()
    expect(screen.getByText('Collecting feedback')).toBeVisible()
    expect(screen.getByRole('link', { name: 'Add feedback' })).toHaveAttribute(
      'href',
      `/cycles/${openCycle.id}/feedback`,
    )
    fireEvent.click(await screen.findByRole('button', { name: 'Close cycle' }))
    expect(screen.getByRole('button', { name: 'Cancel' })).toBeVisible()
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))

    fireEvent.click(within(alert).getByRole('button', { name: 'Retry' }))

    expect(
      await within(block).findByText('2 of 3 members have added feedback.'),
    ).toBeVisible()
    expect(within(block).queryByRole('alert')).not.toBeInTheDocument()
    expect(cyclesMock.fetchCycleStatus).toHaveBeenCalledTimes(2)
  })

  it('not_project_member refetches the project and cycles and shows not found', async () => {
    cyclesMock.fetchCycleStatus.mockRejectedValue(
      new CyclesApiError('not_project_member'),
    )
    renderPage()
    // The first read finds the project; the re-read after the error does not.
    projectsMock.fetchProject
      .mockResolvedValueOnce(project)
      .mockResolvedValue(null)

    expect(
      await screen.findByText('Project not found or you do not have access.'),
    ).toBeVisible()
    expect(projectsMock.fetchProject).toHaveBeenCalledTimes(2)
    expect(cyclesMock.fetchProjectCycles.mock.calls.length).toBeGreaterThan(1)
    expect(
      screen.queryByText('Could not load submission status.'),
    ).not.toBeInTheDocument()

    act(() => {
      window.dispatchEvent(new Event('focus'))
    })
    expect(cyclesMock.fetchCycleStatus).toHaveBeenCalledTimes(1)
  })
})
