import { act, fireEvent, screen, waitFor, within } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
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
  StartedRetrospective,
} from './cyclesApi'
import type { CycleStatus } from './cycleStatus'
import { CyclesApiError } from './cyclesErrors'

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

const other = (role: 'facilitator' | 'member', isOwner = false) =>
  ({
    userId: 'user-2',
    displayName: 'Other Person',
    role,
    isOwner,
    isMe: false,
    joinedAt: '2026-10-30T12:00:00.000Z',
  }) satisfies ProjectMember

const asFacilitator: ProjectMember[] = [
  me('facilitator', true),
  other('member'),
]
const asMember: ProjectMember[] = [me('member', false), other('facilitator')]
// The owner after handing the role to someone else is a plain member.
const asOwnerNotFacilitator: ProjectMember[] = [
  me('member', true),
  other('facilitator'),
]

const openCycle: CycleSummary = {
  id: '30000000-0000-4000-8000-000000000001',
  title: 'Week of Oct 26, 2026',
  weekStart: '2026-10-26',
  status: 'collecting',
  createdAt: '2026-10-30T12:00:00.000Z',
  closedAt: null,
}

const nextCycle: CycleSummary = {
  ...openCycle,
  id: '30000000-0000-4000-8000-000000000005',
  title: 'Week of Nov 2, 2026',
  weekStart: '2026-11-02',
}

const pastCycle: CycleSummary = {
  id: '30000000-0000-4000-8000-000000000002',
  title: 'Retro one',
  weekStart: '2026-10-19',
  status: 'reveal',
  createdAt: '2026-10-20T12:00:00.000Z',
  closedAt: '2026-10-24T12:00:00.000Z',
}

const closedOpenCycle: CycleSummary = {
  ...openCycle,
  status: 'closed',
  closedAt: '2026-10-31T12:00:00.000Z',
}

const START_COPY =
  'Start the retrospective? Feedback collection ends for everyone, and every card in this cycle becomes visible to all project members. Names are shown only on cards that were not submitted anonymously. This cannot be undone.'

const BOARD_STATUSES: CycleStatus[] = ['reveal', 'cluster', 'vote', 'discuss']

function withStatus(status: CycleStatus): CycleSummary {
  return { ...openCycle, status }
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

const started: StartedRetrospective = {
  id: openCycle.id,
  status: 'reveal',
  revealedAt: '2026-11-01T12:00:00.000Z',
}

interface RenderOptions {
  readonly members?: ProjectMember[]
  readonly cycles?: ProjectCycles
  readonly status?: CycleSubmissionStatus
  readonly strictMode?: boolean
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
  return renderApp({
    initialEntries: [`/projects/${project.id}`],
    strictMode: options.strictMode,
  })
}

async function findCurrentCycle() {
  return screen.findByRole('heading', { name: openCycle.title })
}

async function openConfirmation() {
  fireEvent.click(
    await screen.findByRole('button', { name: 'Start retrospective' }),
  )
  return screen.findByRole('group', { name: 'Start retrospective' })
}

function confirmButton(group: HTMLElement) {
  return within(group).getByRole('button', {
    name: /^(Start retrospective|Starting…)$/,
  })
}

describe('Start retrospective button', () => {
  it('shows for the facilitator on a collecting cycle, next to Close cycle', async () => {
    renderPage()

    expect(
      await screen.findByRole('button', { name: 'Start retrospective' }),
    ).toBeEnabled()
    expect(screen.getByRole('button', { name: 'Close cycle' })).toBeVisible()
  })

  it('does not show for an ordinary member', async () => {
    renderPage({ members: asMember })

    await findCurrentCycle()
    await screen.findByText('Add feedback')
    await waitFor(() => {
      expect(membersMock.fetchProjectMembers).toHaveBeenCalled()
    })
    expect(
      screen.queryByRole('button', { name: 'Start retrospective' }),
    ).not.toBeInTheDocument()
  })

  it('does not show for an owner who handed over the facilitator role', async () => {
    renderPage({ members: asOwnerNotFacilitator })

    await findCurrentCycle()
    await waitFor(() => {
      expect(membersMock.fetchProjectMembers).toHaveBeenCalled()
    })
    expect(
      screen.queryByRole('button', { name: 'Start retrospective' }),
    ).not.toBeInTheDocument()
    expect(
      screen.queryByRole('button', { name: 'Close cycle' }),
    ).not.toBeInTheDocument()
  })

  it.each(BOARD_STATUSES)(
    'does not show for the facilitator on a %s cycle, and Close cycle stays',
    async (status) => {
      renderPage({
        cycles: { current: withStatus(status), past: [] },
        status: statusOf({ status, isRevealed: true, cardCount: 4 }),
      })

      expect(
        await screen.findByRole('button', { name: 'Close cycle' }),
      ).toBeVisible()
      expect(
        screen.queryByRole('button', { name: 'Start retrospective' }),
      ).not.toBeInTheDocument()
    },
  )
})

describe('Open retrospective board link', () => {
  it.each(BOARD_STATUSES)(
    'every member sees it on a %s cycle',
    async (status) => {
      renderPage({
        members: asMember,
        cycles: { current: withStatus(status), past: [] },
        status: statusOf({ status, isRevealed: true, cardCount: 4 }),
      })

      const link = await screen.findByRole('link', {
        name: 'Open retrospective board',
      })
      expect(link).toHaveAttribute('href', `/cycles/${openCycle.id}/board`)
    },
  )

  it('the facilitator sees it too', async () => {
    renderPage({
      cycles: { current: withStatus('vote'), past: [] },
      status: statusOf({ status: 'vote', isRevealed: true, cardCount: 4 }),
    })

    expect(
      await screen.findByRole('link', { name: 'Open retrospective board' }),
    ).toBeVisible()
  })

  it('is not shown while collecting or for past cycles', async () => {
    renderPage({
      cycles: {
        current: openCycle,
        past: [{ ...pastCycle, status: 'closed' }],
      },
    })

    await screen.findByRole('list', { name: 'Past cycles' })
    await screen.findByText('Add feedback')
    expect(
      screen.queryByRole('link', { name: 'Open retrospective board' }),
    ).not.toBeInTheDocument()
  })

  it('is not shown with no open cycle', async () => {
    renderPage({
      cycles: { current: null, past: [{ ...pastCycle, status: 'closed' }] },
    })

    await screen.findByText('No open feedback cycle.')
    expect(
      screen.queryByRole('link', { name: 'Open retrospective board' }),
    ).not.toBeInTheDocument()
  })
})

describe('Start retrospective confirmation', () => {
  it('shows the copy and the submitters line, with focus on Cancel and no card count', async () => {
    renderPage({ status: statusOf() })

    const group = await openConfirmation()
    expect(within(group).getByText(START_COPY)).toBeVisible()
    expect(
      await within(group).findByText('2 of 3 members have added feedback.'),
    ).toBeVisible()
    expect(within(group).getByRole('button', { name: 'Cancel' })).toHaveFocus()
    expect(confirmButton(group)).toHaveTextContent('Start retrospective')
    expect(confirmButton(group)).toBeEnabled()
    // Apart from the fixed copy, nothing mentions cards or a count of them.
    expect((group.textContent ?? '').replace(START_COPY, '')).not.toMatch(
      /card/i,
    )
    expect(group.textContent).not.toContain('Other Person')
    expect(group.textContent).not.toContain('Dev User')
    // Only one confirmation is open at a time.
    expect(
      screen.queryByRole('button', { name: 'Close cycle' }),
    ).not.toBeInTheDocument()
    // The line comes from the Submission status block's own query (the same
    // key, re-read when the confirmation opens): no new kind of request.
    for (const call of cyclesMock.fetchCycleStatus.mock.calls) {
      expect(call).toEqual([openCycle.id])
    }
    expect(cyclesMock.startRetrospective).not.toHaveBeenCalled()
  })

  it('reads "No one has added feedback yet." with zero submissions', async () => {
    renderPage({
      status: statusOf({ submittedMemberCount: 0, myCardCount: 0 }),
    })

    const group = await openConfirmation()
    expect(
      await within(group).findByText('No one has added feedback yet.'),
    ).toBeVisible()
  })

  it('reads "3 of 3" when everyone has added feedback', async () => {
    renderPage({ status: statusOf({ submittedMemberCount: 3 }) })

    const group = await openConfirmation()
    expect(
      await within(group).findByText('3 of 3 members have added feedback.'),
    ).toBeVisible()
  })

  it('uses the singular with one member', async () => {
    renderPage({
      status: statusOf({ memberCount: 1, submittedMemberCount: 1 }),
    })

    const group = await openConfirmation()
    expect(
      await within(group).findByText('1 of 1 member has added feedback.'),
    ).toBeVisible()
  })

  it('shows a loading line while the status is loading, with confirm enabled', async () => {
    const pending = deferred<CycleSubmissionStatus>()
    cyclesMock.fetchCycleStatus.mockReturnValue(pending.promise)
    renderPage()

    const group = await openConfirmation()
    expect(within(group).getByText('Loading submission status…')).toBeVisible()
    expect(confirmButton(group)).toBeEnabled()

    await act(async () => {
      pending.resolve(statusOf())
      await pending.promise
    })
    expect(
      await within(group).findByText('2 of 3 members have added feedback.'),
    ).toBeVisible()
  })

  it('shows a failure line when the status fails, with confirm enabled', async () => {
    cyclesMock.fetchCycleStatus.mockRejectedValue(new CyclesApiError('unknown'))
    renderPage()

    const group = await openConfirmation()
    expect(
      await within(group).findByText('Could not load submission status.'),
    ).toBeVisible()
    expect(confirmButton(group)).toBeEnabled()
  })

  it('Cancel closes it without a request and returns focus', async () => {
    renderPage({ status: statusOf() })

    const group = await openConfirmation()
    fireEvent.click(within(group).getByRole('button', { name: 'Cancel' }))

    expect(screen.queryByText(START_COPY)).not.toBeInTheDocument()
    await waitFor(() => {
      expect(
        screen.getByRole('button', { name: 'Start retrospective' }),
      ).toHaveFocus()
    })
    expect(screen.getByRole('button', { name: 'Close cycle' })).toBeVisible()
    expect(cyclesMock.startRetrospective).not.toHaveBeenCalled()
  })

  it('Escape cancels it without a request', async () => {
    renderPage({ status: statusOf() })

    const group = await openConfirmation()
    fireEvent.keyDown(within(group).getByRole('button', { name: 'Cancel' }), {
      key: 'Escape',
    })

    expect(screen.queryByText(START_COPY)).not.toBeInTheDocument()
    expect(cyclesMock.startRetrospective).not.toHaveBeenCalled()
  })

  it('opening Close cycle hides Start retrospective', async () => {
    renderPage()

    fireEvent.click(await screen.findByRole('button', { name: 'Close cycle' }))
    expect(
      screen.queryByRole('button', { name: 'Start retrospective' }),
    ).not.toBeInTheDocument()
    expect(screen.queryByText(START_COPY)).not.toBeInTheDocument()
  })
})

describe('Starting the retrospective', () => {
  it('sends one request for a double click and reads "Starting…" while pending', async () => {
    const pending = deferred<StartedRetrospective>()
    cyclesMock.startRetrospective.mockReturnValue(pending.promise)
    renderPage({ status: statusOf() })

    const group = await openConfirmation()
    const confirm = confirmButton(group)
    fireEvent.click(confirm)
    fireEvent.click(confirm)
    fireEvent.keyDown(confirm, { key: 'Enter' })
    fireEvent.click(confirm)

    await waitFor(() => {
      expect(cyclesMock.startRetrospective).toHaveBeenCalled()
    })
    expect(cyclesMock.startRetrospective).toHaveBeenCalledTimes(1)
    expect(cyclesMock.startRetrospective).toHaveBeenCalledWith(openCycle.id)
    await waitFor(() => {
      expect(confirmButton(group)).toHaveTextContent('Starting…')
    })
    expect(confirmButton(group)).toBeDisabled()

    await act(async () => {
      pending.resolve(started)
      await pending.promise
    })
    expect(cyclesMock.startRetrospective).toHaveBeenCalledTimes(1)
  })

  it('shows the toast, invalidates both queries, and opens the board', async () => {
    cyclesMock.startRetrospective.mockResolvedValue(started)
    const invalidate = vi.spyOn(queryClient, 'invalidateQueries')
    renderPage({ status: statusOf() })

    const group = await openConfirmation()
    fireEvent.click(confirmButton(group))

    expect(await screen.findByText('Retrospective started.')).toBeVisible()
    await waitFor(() => {
      expect(screen.getByTestId('location')).toHaveTextContent(
        `/cycles/${openCycle.id}/board`,
      )
    })
    const keys = invalidate.mock.calls.map(([filters]) => filters?.queryKey)
    expect(keys).toContainEqual(['project-cycles', 'user-1', project.id])
    expect(keys).toContainEqual(['cycle-status', 'user-1', openCycle.id])
  })

  it('a stale tab whose cycle was already started elsewhere gets the same success', async () => {
    // The server's no-op returns the existing reveal row.
    cyclesMock.startRetrospective.mockResolvedValue({
      ...started,
      revealedAt: '2026-11-01T09:00:00.000Z',
    })
    renderPage({ status: statusOf() })

    const group = await openConfirmation()
    fireEvent.click(confirmButton(group))

    expect(await screen.findByText('Retrospective started.')).toBeVisible()
    await waitFor(() => {
      expect(screen.getByTestId('location')).toHaveTextContent(
        `/cycles/${openCycle.id}/board`,
      )
    })
  })

  it('after the start the project page reads Revealed with the revealed status and View my feedback', async () => {
    renderPage({
      members: asMember,
      cycles: { current: withStatus('reveal'), past: [] },
      status: statusOf({
        status: 'reveal',
        isRevealed: true,
        submittedMemberCount: 2,
        cardCount: 1,
      }),
    })

    expect(await screen.findByText('Revealed')).toBeVisible()
    expect(
      await screen.findByText(
        'Feedback collection has ended. 2 of 3 members added feedback, 1 card in total.',
      ),
    ).toBeVisible()
    expect(screen.getByRole('link', { name: 'View my feedback' })).toBeVisible()
  })

  it('not_project_facilitator shows its message and re-reads the members', async () => {
    cyclesMock.startRetrospective.mockRejectedValue(
      new CyclesApiError('not_project_facilitator'),
    )
    renderPage({ status: statusOf() })

    const group = await openConfirmation()
    membersMock.fetchProjectMembers.mockResolvedValue(asOwnerNotFacilitator)
    fireEvent.click(confirmButton(group))

    expect(
      await screen.findByText(
        'Only the facilitator can start the retrospective.',
      ),
    ).toBeVisible()
    await waitFor(() => {
      expect(
        screen.queryByRole('button', { name: 'Start retrospective' }),
      ).not.toBeInTheDocument()
    })
    expect(screen.queryByText(START_COPY)).not.toBeInTheDocument()
    expect(await findCurrentCycle()).toBeVisible()
  })

  it('cycle_not_collecting from a stale tab shows its message and moves the closed cycle to Past cycles', async () => {
    cyclesMock.startRetrospective.mockRejectedValue(
      new CyclesApiError('cycle_not_collecting'),
    )
    renderPage({ status: statusOf() })

    const group = await openConfirmation()
    const statusCalls = cyclesMock.fetchCycleStatus.mock.calls.length
    cyclesMock.fetchProjectCycles.mockResolvedValue({
      current: null,
      past: [closedOpenCycle],
    })
    fireEvent.click(confirmButton(group))

    expect(
      await screen.findByText(
        'Feedback collection has already ended for this cycle.',
      ),
    ).toBeVisible()
    const list = await screen.findByRole('list', { name: 'Past cycles' })
    expect(list).toHaveTextContent(openCycle.title)
    expect(screen.getByText('No open feedback cycle.')).toBeVisible()
    expect(
      cyclesMock.fetchCycleStatus.mock.calls.length,
    ).toBeGreaterThanOrEqual(statusCalls)
    expect(screen.getByTestId('location')).toHaveTextContent(
      `/projects/${project.id}`,
    )
  })

  it('cycle_not_collecting re-reads the cycles and the status', async () => {
    cyclesMock.startRetrospective.mockRejectedValue(
      new CyclesApiError('cycle_not_collecting'),
    )
    const invalidate = vi.spyOn(queryClient, 'invalidateQueries')
    renderPage({ status: statusOf() })

    const group = await openConfirmation()
    fireEvent.click(confirmButton(group))

    await screen.findByText(
      'Feedback collection has already ended for this cycle.',
    )
    const keys = invalidate.mock.calls.map(([filters]) => filters?.queryKey)
    expect(keys).toContainEqual(['project-cycles', 'user-1', project.id])
    expect(keys).toContainEqual(['cycle-status', 'user-1', openCycle.id])
    expect(
      screen.getByRole('button', { name: 'Start retrospective' }),
    ).toBeEnabled()
  })

  it('not_project_member re-reads the project and shows the not-found state', async () => {
    cyclesMock.startRetrospective.mockRejectedValue(
      new CyclesApiError('not_project_member'),
    )
    renderPage({ status: statusOf() })

    const group = await openConfirmation()
    projectsMock.fetchProject.mockResolvedValue(null)
    cyclesMock.fetchProjectCycles.mockResolvedValue({ current: null, past: [] })
    fireEvent.click(confirmButton(group))

    expect(
      await screen.findByText('Project not found or you do not have access.'),
    ).toBeVisible()
  })

  it('a network failure shows the generic message and keeps the button enabled', async () => {
    cyclesMock.startRetrospective.mockRejectedValue(
      new TypeError('fetch failed'),
    )
    renderPage({ status: statusOf() })

    const group = await openConfirmation()
    fireEvent.click(confirmButton(group))

    expect(
      await screen.findByText('Could not start the retrospective.'),
    ).toBeVisible()
    expect(screen.queryByText(START_COPY)).not.toBeInTheDocument()
    expect(
      screen.getByRole('button', { name: 'Start retrospective' }),
    ).toBeEnabled()
    expect(screen.queryByText(/fetch failed/)).not.toBeInTheDocument()
    expect(await findCurrentCycle()).toBeVisible()
  })

  it('an unknown code shows the generic message', async () => {
    cyclesMock.startRetrospective.mockRejectedValue(
      new CyclesApiError('unknown'),
    )
    renderPage({ status: statusOf() })

    const group = await openConfirmation()
    fireEvent.click(confirmButton(group))

    expect(
      await screen.findByText('Could not start the retrospective.'),
    ).toBeVisible()
  })
})

describe('Project page live update', () => {
  it('subscribes once to the open cycle and re-reads cycles and status on an event', async () => {
    renderPage({ members: asMember, status: statusOf() })
    await screen.findByText('Collecting feedback')

    await waitFor(() => {
      expect(cyclesMock.activeCycleEventsSubscriptions()).toHaveLength(1)
    })
    expect(cyclesMock.activeCycleEventsSubscriptions()[0]?.cycleId).toBe(
      openCycle.id,
    )

    cyclesMock.fetchProjectCycles.mockResolvedValue({
      current: withStatus('reveal'),
      past: [],
    })
    cyclesMock.fetchCycleStatus.mockResolvedValue(
      statusOf({ status: 'reveal', isRevealed: true, cardCount: 5 }),
    )
    act(() => {
      cyclesMock.emitCycleEvent(openCycle.id)
    })

    expect(await screen.findByText('Revealed')).toBeVisible()
    expect(
      await screen.findByRole('link', { name: 'Open retrospective board' }),
    ).toBeVisible()
    expect(
      await screen.findByText(
        'Feedback collection has ended. 2 of 3 members added feedback, 5 cards in total.',
      ),
    ).toBeVisible()
    expect(screen.getByRole('link', { name: 'View my feedback' })).toBeVisible()
  })

  it('moves the cycle to Past cycles when it is closed elsewhere, and removes the channel', async () => {
    renderPage({ members: asMember })
    await screen.findByText('Collecting feedback')
    await waitFor(() => {
      expect(cyclesMock.activeCycleEventsSubscriptions()).toHaveLength(1)
    })

    cyclesMock.fetchProjectCycles.mockResolvedValue({
      current: null,
      past: [closedOpenCycle],
    })
    act(() => {
      cyclesMock.emitCycleEvent(openCycle.id)
    })

    const list = await screen.findByRole('list', { name: 'Past cycles' })
    expect(list).toHaveTextContent(openCycle.title)
    await waitFor(() => {
      expect(cyclesMock.activeCycleEventsSubscriptions()).toHaveLength(0)
    })
  })

  it('invalidates both queries on the first SUBSCRIBED and again after a resubscribe', async () => {
    const invalidate = vi.spyOn(queryClient, 'invalidateQueries')
    renderPage({ status: statusOf() })
    await screen.findByText('Collecting feedback')
    await waitFor(() => {
      expect(cyclesMock.activeCycleEventsSubscriptions()).toHaveLength(1)
    })

    const count = (key: readonly unknown[]) =>
      invalidate.mock.calls.filter(
        ([filters]) =>
          JSON.stringify(filters?.queryKey) === JSON.stringify(key),
      ).length
    const cyclesKey = ['project-cycles', 'user-1', project.id]
    const statusKey = ['cycle-status', 'user-1', openCycle.id]
    expect(count(cyclesKey)).toBe(0)

    act(() => {
      cyclesMock.emitCycleEventsStatus(openCycle.id, 'SUBSCRIBED')
    })
    expect(count(cyclesKey)).toBe(1)
    expect(count(statusKey)).toBe(1)

    act(() => {
      cyclesMock.emitCycleEventsStatus(openCycle.id, 'CHANNEL_ERROR')
    })
    expect(count(cyclesKey)).toBe(1)

    act(() => {
      cyclesMock.emitCycleEventsStatus(openCycle.id, 'SUBSCRIBED')
    })
    expect(count(cyclesKey)).toBe(2)
    expect(count(statusKey)).toBe(2)

    for (const status of ['TIMED_OUT', 'CLOSED'] as const) {
      act(() => {
        cyclesMock.emitCycleEventsStatus(openCycle.id, status)
      })
      act(() => {
        cyclesMock.emitCycleEventsStatus(openCycle.id, 'SUBSCRIBED')
      })
    }
    expect(count(cyclesKey)).toBe(4)
    expect(count(statusKey)).toBe(4)
  })

  it('unsubscribes on unmount', async () => {
    const view = renderPage()
    await screen.findByText('Collecting feedback')
    await waitFor(() => {
      expect(cyclesMock.activeCycleEventsSubscriptions()).toHaveLength(1)
    })

    view.unmount()
    expect(cyclesMock.activeCycleEventsSubscriptions()).toHaveLength(0)
  })

  it('moves the subscription when the open cycle changes', async () => {
    renderPage()
    await screen.findByText('Collecting feedback')
    await waitFor(() => {
      expect(cyclesMock.activeCycleEventsSubscriptions()).toHaveLength(1)
    })

    cyclesMock.fetchProjectCycles.mockResolvedValue({
      current: nextCycle,
      past: [closedOpenCycle],
    })
    act(() => {
      cyclesMock.emitCycleEvent(openCycle.id)
    })

    await screen.findByRole('heading', { name: nextCycle.title })
    await waitFor(() => {
      expect(
        cyclesMock.activeCycleEventsSubscriptions().map((s) => s.cycleId),
      ).toEqual([nextCycle.id])
    })
  })

  it('opens no channel without an open cycle', async () => {
    renderPage({ cycles: { current: null, past: [] } })

    await screen.findByText('No open feedback cycle.')
    expect(cyclesMock.subscribeToCycleEvents).not.toHaveBeenCalled()
  })

  it('leaves exactly one live channel in strict mode', async () => {
    renderPage({ strictMode: true })
    await screen.findByText('Collecting feedback')

    await waitFor(() => {
      expect(cyclesMock.activeCycleEventsSubscriptions()).toHaveLength(1)
    })
  })

  it('sets no polling interval and stores nothing from an event', async () => {
    const setItem = vi.spyOn(Storage.prototype, 'setItem')
    renderPage({ status: statusOf() })
    await screen.findByText('Collecting feedback')
    await waitFor(() => {
      expect(cyclesMock.activeCycleEventsSubscriptions()).toHaveLength(1)
    })

    act(() => {
      cyclesMock.emitCycleEvent(openCycle.id)
    })
    await waitFor(() => {
      expect(cyclesMock.fetchProjectCycles.mock.calls.length).toBeGreaterThan(1)
    })

    for (const query of queryClient.getQueryCache().getAll()) {
      const options = query.options as { refetchInterval?: unknown }
      expect(options.refetchInterval).toBeUndefined()
    }
    expect(setItem).not.toHaveBeenCalled()
  })

  it('re-reads the cycles when the window regains focus', async () => {
    renderPage()
    await screen.findByText('Collecting feedback')
    const calls = cyclesMock.fetchProjectCycles.mock.calls.length

    act(() => {
      window.dispatchEvent(new Event('focus'))
    })

    await waitFor(() => {
      expect(cyclesMock.fetchProjectCycles.mock.calls.length).toBeGreaterThan(
        calls,
      )
    })
  })
})
