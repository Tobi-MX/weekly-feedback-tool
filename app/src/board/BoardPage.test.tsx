import { act, fireEvent, screen, waitFor, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { CycleDetail } from '../cycles/cyclesApi'
import { CyclesApiError, type CyclesErrorCode } from '../cycles/cyclesErrors'
import type { CycleStatus } from '../cycles/cycleStatus'
import { queryClient } from '../lib/queryClient'
import type { ProjectMember } from '../projects/membersApi'
import {
  authMock,
  deferred,
  makeSession,
  mockEmptySession,
  mockRestoredSession,
} from '../test/authMock'
import { boardMock } from '../test/boardMock'
import { cyclesMock } from '../test/cyclesMock'
import { membersMock } from '../test/membersMock'
import { profileMock } from '../test/profileMock'
import { renderApp } from '../test/renderApp'
import type { BoardCard, CycleBoard } from './boardApi'
import { BoardApiError } from './boardErrors'

const CYCLE_ID = '30000000-0000-4000-8000-000000000001'
const PROJECT_ID = '10000000-0000-4000-8000-000000000001'
const PATH = `/cycles/${CYCLE_ID}/board`
const NOT_FOUND = 'Cycle not found or you do not have access.'
const LOAD_ERROR = 'Could not load the board.'
const LIVE_NOTICE =
  'Live updates are unavailable. The board refreshes every few seconds.'

const cycle: CycleDetail = {
  id: CYCLE_ID,
  projectId: PROJECT_ID,
  title: 'Sprint twelve retro',
  weekStart: '2026-10-26',
  status: 'reveal',
}

// Interleaved categories, ids out of alphabetical order: the board must keep
// this order within each section and never sort.
const SIX_CARDS: readonly BoardCard[] = [
  {
    cardId: 'f0000000-0000-4000-8000-000000000001',
    category: 'start',
    text: 'Start pairing',
    isAnonymous: false,
    isMine: false,
    authorDisplayName: 'Grace',
  },
  {
    cardId: 'a0000000-0000-4000-8000-000000000002',
    category: 'continue',
    text: 'Continue demos',
    isAnonymous: true,
  },
  {
    cardId: 'c0000000-0000-4000-8000-000000000003',
    category: 'start',
    text: 'Start writing ADRs',
    isAnonymous: true,
  },
  {
    cardId: 'b0000000-0000-4000-8000-000000000004',
    category: 'stop',
    text: 'Stop late merges',
    isAnonymous: false,
    isMine: true,
    authorDisplayName: 'Ada',
  },
  {
    cardId: 'e0000000-0000-4000-8000-000000000005',
    category: 'start',
    text: 'Start on time',
    isAnonymous: false,
    isMine: false,
    authorDisplayName: null,
  },
  {
    cardId: 'd0000000-0000-4000-8000-000000000006',
    category: 'continue',
    text: 'Continue retros',
    isAnonymous: false,
    isMine: false,
    authorDisplayName: 'Linus',
  },
]

const OWN_CARDS: readonly BoardCard[] = [
  {
    cardId: 'a1000000-0000-4000-8000-000000000001',
    category: 'start',
    text: 'My secret start',
    isAnonymous: false,
    isMine: true,
    authorDisplayName: 'Dev User',
  },
  {
    cardId: 'a1000000-0000-4000-8000-000000000002',
    category: 'stop',
    text: 'My hidden stop',
    isAnonymous: true,
  },
]

function boardOf(
  status: CycleStatus,
  isRevealed = status !== 'collecting',
  cards: readonly BoardCard[] = SIX_CARDS,
): CycleBoard {
  return { cycleId: CYCLE_ID, status, isRevealed, cards }
}

function memberRow(overrides: Partial<ProjectMember>): ProjectMember {
  return {
    userId: 'user-1',
    displayName: 'Dev User',
    role: 'facilitator',
    isOwner: true,
    isMe: true,
    joinedAt: '2026-10-30T12:00:00.000Z',
    ...overrides,
  }
}

const asFacilitator = [memberRow({})]
const asMember = [
  memberRow({ role: 'member', isOwner: false }),
  memberRow({ userId: 'user-2', displayName: 'Fac', isMe: false }),
]
// The owner who handed the role to someone else.
const asFormerFacilitator = [
  memberRow({ role: 'member', isOwner: true }),
  memberRow({
    userId: 'user-2',
    displayName: 'Fac',
    isMe: false,
    isOwner: false,
  }),
]

interface SetupOptions {
  readonly board?: CycleBoard
  readonly members?: ProjectMember[]
  readonly cycleStatus?: CycleStatus
  readonly strictMode?: boolean
  readonly userId?: string
}

function setup(options: SetupOptions = {}) {
  mockRestoredSession('dev@example.com', options.userId ?? 'user-1')
  profileMock.fetchProfileDisplayName.mockResolvedValue('Dev User')
  cyclesMock.fetchCycle.mockResolvedValue({
    ...cycle,
    status: options.cycleStatus ?? options.board?.status ?? 'reveal',
  })
  boardMock.fetchCycleBoard.mockResolvedValue(
    options.board ?? boardOf('reveal'),
  )
  membersMock.fetchProjectMembers.mockResolvedValue(
    options.members ?? asFacilitator,
  )
  return renderApp({
    initialEntries: [PATH],
    strictMode: options.strictMode,
  })
}

async function modeHeading(name: string): Promise<HTMLElement> {
  return screen.findByRole('heading', { level: 2, name })
}

function liveSubscriptions() {
  return cyclesMock
    .activeCycleEventsSubscriptions()
    .filter((subscription) => subscription.cycleId === CYCLE_ID)
}

async function subscribed(): Promise<void> {
  await waitFor(() => {
    expect(liveSubscriptions()).toHaveLength(1)
  })
}

function emitStatus(
  status: 'SUBSCRIBED' | 'CHANNEL_ERROR' | 'TIMED_OUT' | 'CLOSED',
) {
  act(() => {
    cyclesMock.emitCycleEventsStatus(CYCLE_ID, status)
  })
}

function emitEvent() {
  act(() => {
    cyclesMock.emitCycleEvent(CYCLE_ID)
  })
}

function cardTexts(list: HTMLElement): string[] {
  return within(list)
    .getAllByRole('listitem')
    .map((item) => item.querySelector('p')?.textContent ?? '')
}

afterEach(() => {
  vi.useRealTimers()
})

describe('board modes', () => {
  const MODES: ReadonlyArray<
    [CycleStatus, boolean, string, string, string | null]
  > = [
    [
      'collecting',
      false,
      'The retrospective has not started yet',
      'Cards appear here when the facilitator starts the retrospective.',
      null,
    ],
    [
      'reveal',
      true,
      'Reveal',
      'All feedback for this cycle, grouped by Start, Stop and Continue.',
      'Start clustering',
    ],
    [
      'cluster',
      true,
      'Cluster',
      'Grouping cards into clusters is not available yet.',
      'Start voting',
    ],
    ['vote', true, 'Vote', 'Voting is not available yet.', null],
    [
      'discuss',
      true,
      'Discuss',
      'The discussion agenda is not available yet.',
      null,
    ],
    ['closed', true, 'Closed', 'This retrospective is closed.', null],
    [
      'closed',
      false,
      'Closed',
      'This cycle was closed before the retrospective started, so no feedback was revealed.',
      null,
    ],
  ]

  const BADGES: Record<CycleStatus, string> = {
    collecting: 'Collecting feedback',
    reveal: 'Revealed',
    cluster: 'Clustering',
    vote: 'Voting',
    discuss: 'Discussing',
    closed: 'Closed',
  }

  it.each(MODES)(
    '%s / %s shows its h2, copy, header, and the facilitator control only where listed',
    async (status, isRevealed, heading, copy, control) => {
      const view = setup({ board: boardOf(status, isRevealed) })

      expect(await modeHeading(heading)).toBeInTheDocument()
      expect(screen.getAllByRole('heading', { level: 2 })).toHaveLength(1)
      expect(screen.getByText(copy)).toBeInTheDocument()
      expect(
        screen.getByRole('heading', { level: 1, name: 'Sprint twelve retro' }),
      ).toBeInTheDocument()
      expect(screen.getByText('Week of Oct 26, 2026')).toBeInTheDocument()
      expect(
        screen.getByText(BADGES[status], { selector: 'span' }),
      ).toBeInTheDocument()
      expect(
        screen.getByRole('link', { name: 'Back to project' }),
      ).toHaveAttribute('href', `/projects/${PROJECT_ID}`)
      const feedbackName =
        status === 'collecting' ? 'Add feedback' : 'View my feedback'
      expect(screen.getByRole('link', { name: feedbackName })).toHaveAttribute(
        'href',
        `/cycles/${CYCLE_ID}/feedback`,
      )

      const main = screen.getByRole('main')
      if (control === null) {
        await waitFor(() => {
          expect(membersMock.fetchProjectMembers).toHaveBeenCalled()
        })
        expect(within(main).queryAllByRole('button')).toHaveLength(0)
      } else {
        expect(
          await screen.findByRole('button', { name: control }),
        ).toBeInTheDocument()
        expect(within(main).getAllByRole('button')).toHaveLength(1)
      }
      if (status === 'collecting') {
        expect(
          await screen.findByText(
            'Start the retrospective from the project page.',
          ),
        ).toBeInTheDocument()
        // No link besides the header's two.
        expect(within(main).getAllByRole('link')).toHaveLength(2)
      }
      view.unmount()
    },
  )

  it('a member sees no control in reveal or cluster, and no facilitator hint in collecting', async () => {
    for (const status of ['reveal', 'cluster', 'collecting'] as const) {
      const view = setup({ board: boardOf(status), members: asMember })
      await screen.findByRole('heading', { level: 2 })
      await waitFor(() => {
        expect(membersMock.fetchProjectMembers).toHaveBeenCalled()
      })
      expect(
        within(screen.getByRole('main')).queryAllByRole('button'),
      ).toHaveLength(0)
      expect(
        screen.queryByText('Start the retrospective from the project page.'),
      ).not.toBeInTheDocument()
      view.unmount()
      queryClient.clear()
    }
  })

  it('the badge, h2, and indicator follow the board response, not the cycle query', async () => {
    setup({ board: boardOf('vote'), cycleStatus: 'cluster' })

    expect(await modeHeading('Vote')).toBeInTheDocument()
    expect(screen.getByText('Voting')).toBeInTheDocument()
    expect(screen.queryByText('Clustering')).not.toBeInTheDocument()
    const indicator = screen.getByRole('list', { name: 'Retrospective stages' })
    const current = within(indicator)
      .getAllByRole('listitem')
      .filter((item) => item.getAttribute('aria-current') === 'step')
    expect(current).toHaveLength(1)
    expect(current[0]).toHaveTextContent('Vote')
  })

  it.each([
    ['reveal', 0],
    ['cluster', 1],
    ['vote', 2],
    ['discuss', 3],
  ] as const)(
    'the stage indicator marks %s current and earlier stages done',
    async (status, index) => {
      setup({ board: boardOf(status) })
      await screen.findByRole('heading', { level: 2 })

      const indicator = screen.getByRole('list', {
        name: 'Retrospective stages',
      })
      expect(indicator.tagName).toBe('OL')
      const items = within(indicator).getAllByRole('listitem')
      expect(items.map((item) => item.firstChild?.textContent)).toEqual([
        'Reveal',
        'Cluster',
        'Vote',
        'Discuss',
      ])
      items.forEach((item, i) => {
        if (i === index) {
          expect(item).toHaveAttribute('aria-current', 'step')
          expect(item).toHaveTextContent('Current')
          expect(item).not.toHaveTextContent('Done')
        } else if (i < index) {
          expect(item).not.toHaveAttribute('aria-current')
          expect(item).toHaveTextContent('Done')
          expect(item).not.toHaveTextContent('Current')
        } else {
          expect(item).not.toHaveAttribute('aria-current')
          expect(item).not.toHaveTextContent(/Done|Current/)
        }
      })
    },
  )

  it.each([
    ['collecting', false],
    ['closed', true],
    ['closed', false],
  ] as const)(
    'renders no stage indicator in %s / %s',
    async (status, isRevealed) => {
      setup({ board: boardOf(status, isRevealed) })
      await screen.findByRole('heading', { level: 2 })
      expect(
        screen.queryByRole('list', { name: 'Retrospective stages' }),
      ).not.toBeInTheDocument()
    },
  )

  it('follows the server stage after an invalidation, not local state', async () => {
    setup({ board: boardOf('reveal') })
    expect(await modeHeading('Reveal')).toBeInTheDocument()

    boardMock.fetchCycleBoard.mockResolvedValue(boardOf('cluster'))
    await act(async () => {
      await queryClient.invalidateQueries({ queryKey: ['cycle-board'] })
    })

    expect(await modeHeading('Cluster')).toBeInTheDocument()
    expect(screen.getByText('Clustering')).toBeInTheDocument()
  })

  it.each([
    ['collecting', false],
    ['closed', false],
  ] as const)(
    'shows none of the caller’s own cards in %s / %s',
    async (status, isRevealed) => {
      setup({ board: boardOf(status, isRevealed, OWN_CARDS) })
      await screen.findByRole('heading', { level: 2 })

      expect(screen.queryByText('My secret start')).not.toBeInTheDocument()
      expect(screen.queryByText('My hidden stop')).not.toBeInTheDocument()
      expect(document.body).not.toHaveTextContent(/My secret|My hidden/)
      expect(
        screen.queryByRole('list', { name: /cards$/ }),
      ).not.toBeInTheDocument()
    },
  )

  it.each([
    ['reveal', false],
    ['collecting', true],
  ] as const)(
    'treats an impossible %s / is_revealed %s response as a load error',
    async (status, isRevealed) => {
      setup({ board: boardOf(status, isRevealed) })

      expect(await screen.findByRole('alert')).toHaveTextContent(LOAD_ERROR)
      expect(screen.getByRole('button', { name: 'Retry' })).toBeInTheDocument()
      for (const card of SIX_CARDS) {
        expect(document.body).not.toHaveTextContent(card.text)
      }
    },
  )

  it.each(['cluster', 'vote', 'discuss'] as const)(
    'the %s placeholder is plain text with no control',
    async (status) => {
      setup({ board: boardOf(status) })
      await screen.findByRole('heading', { level: 2 })

      const panel = screen.getByTestId('mode-placeholder')
      expect(within(panel).queryAllByRole('button')).toHaveLength(0)
      expect(within(panel).queryAllByRole('link')).toHaveLength(0)
      expect(within(panel).queryAllByRole('textbox')).toHaveLength(0)
      expect(panel.querySelector('input, button, a, [aria-disabled]')).toBe(
        null,
      )
    },
  )
})

describe('board cards', () => {
  it('shows each section with its count and the cards in response order', async () => {
    setup({ board: boardOf('reveal') })
    await modeHeading('Reveal')

    expect(
      screen.getAllByRole('heading', { level: 3 }).map((h) => h.textContent),
    ).toEqual(['Start (3)', 'Stop (1)', 'Continue (2)'])
    expect(
      cardTexts(screen.getByRole('list', { name: 'Start cards' })),
    ).toEqual(['Start pairing', 'Start writing ADRs', 'Start on time'])
    expect(cardTexts(screen.getByRole('list', { name: 'Stop cards' }))).toEqual(
      ['Stop late merges'],
    )
    expect(
      cardTexts(screen.getByRole('list', { name: 'Continue cards' })),
    ).toEqual(['Continue demos', 'Continue retros'])
  })

  it('labels attributed, own, deleted-author, and anonymous cards', async () => {
    setup({ board: boardOf('reveal') })
    await modeHeading('Reveal')

    const label = (text: string) =>
      screen.getByText(text).closest('li')?.querySelectorAll('p')[1]
        ?.textContent
    expect(label('Start pairing')).toBe('Grace')
    expect(label('Stop late merges')).toBe('Ada (you)')
    expect(label('Start on time')).toBe('Deleted user')
    expect(label('Continue demos')).toBe('Anonymous')
    expect(label('Start writing ADRs')).toBe('Anonymous')
    expect(screen.getAllByText(/\(you\)/)).toHaveLength(1)
  })

  it('renders an anonymous card identically for two different users', async () => {
    const first = setup({ board: boardOf('reveal'), userId: 'user-1' })
    await modeHeading('Reveal')
    const html1 = screen.getByText('Continue demos').closest('li')?.outerHTML
    first.unmount()
    queryClient.clear()

    setup({
      board: boardOf('reveal'),
      userId: 'user-9',
      members: [memberRow({ userId: 'user-9' })],
    })
    await modeHeading('Reveal')
    const html2 = screen.getByText('Continue demos').closest('li')?.outerHTML

    expect(html1).toBeDefined()
    expect(html2).toBe(html1)
    expect(html1).not.toMatch(/you|svg|data-/)
  })

  it.each(['reveal', 'cluster', 'vote', 'discuss', 'closed'] as const)(
    'with zero cards %s shows one line and no section',
    async (status) => {
      setup({ board: boardOf(status, true, []) })
      await screen.findByRole('heading', { level: 2 })

      expect(
        screen.getByText('No feedback was submitted for this cycle.'),
      ).toBeInTheDocument()
      expect(screen.queryAllByRole('heading', { level: 3 })).toHaveLength(0)
    },
  )

  it('shows an empty category line', async () => {
    setup({
      board: boardOf('reveal', true, [SIX_CARDS[0] as BoardCard]),
    })
    await modeHeading('Reveal')

    expect(screen.getByText('No Stop cards.')).toBeInTheDocument()
    expect(screen.getByText('No Continue cards.')).toBeInTheDocument()
    expect(
      screen.getByRole('heading', { name: 'Stop (0)' }),
    ).toBeInTheDocument()
  })

  it('shows card text as text, wraps long words, and logs or stores nothing', async () => {
    const setItem = vi.spyOn(Storage.prototype, 'setItem')
    const log = vi.spyOn(console, 'log')
    const info = vi.spyOn(console, 'info')
    const error = vi.spyOn(console, 'error')
    const long = 'x'.repeat(300)
    setup({
      board: boardOf('reveal', true, [
        {
          cardId: 'a2000000-0000-4000-8000-000000000001',
          category: 'start',
          text: '<b>bold</b><script>alert(1)</script>',
          isAnonymous: true,
        },
        {
          cardId: 'a2000000-0000-4000-8000-000000000002',
          category: 'stop',
          text: long,
          isAnonymous: true,
        },
      ]),
    })
    await modeHeading('Reveal')

    expect(
      screen.getByText('<b>bold</b><script>alert(1)</script>'),
    ).toBeInTheDocument()
    expect(document.querySelector('main b')).toBeNull()
    expect(screen.getByText(long)).toHaveClass('[overflow-wrap:anywhere]')

    const secrets = ['a2000000', long, 'bold', 'user-1']
    for (const spy of [setItem, log, info, error]) {
      for (const call of spy.mock.calls) {
        const text = JSON.stringify(call)
        for (const secret of secrets) {
          expect(text).not.toContain(secret)
        }
      }
    }
  })
})

describe('advancing the stage', () => {
  it.each([
    ['a member', asMember],
    ['an owner who handed the role over', asFormerFacilitator],
  ])('%s sees no control', async (_label, members) => {
    setup({ board: boardOf('reveal'), members })
    await modeHeading('Reveal')
    await waitFor(() => {
      expect(membersMock.fetchProjectMembers).toHaveBeenCalled()
    })
    expect(
      screen.queryByRole('button', { name: 'Start clustering' }),
    ).not.toBeInTheDocument()
  })

  it('a facilitator whose members query is loading or failed sees no control', async () => {
    const pending = deferred<ProjectMember[] | null>()
    setup({ board: boardOf('cluster') })
    membersMock.fetchProjectMembers.mockReturnValue(pending.promise)
    await modeHeading('Cluster')
    expect(
      screen.queryByRole('button', { name: 'Start voting' }),
    ).not.toBeInTheDocument()

    await act(async () => {
      pending.reject(new Error('down'))
      await pending.promise.catch(() => undefined)
    })
    expect(
      screen.queryByRole('button', { name: 'Start voting' }),
    ).not.toBeInTheDocument()
  })

  it.each([
    [
      'reveal',
      'Start clustering',
      'Move everyone to the Cluster stage? You cannot go back to Reveal.',
    ],
    [
      'cluster',
      'Start voting',
      'Move everyone to the Vote stage? Clusters cannot be changed once voting starts, and you cannot go back to Cluster.',
    ],
  ] as const)(
    'in %s the confirmation opens with focus on Cancel; Escape and Cancel return focus',
    async (status, action, copy) => {
      setup({ board: boardOf(status) })
      const trigger = await screen.findByRole('button', { name: action })

      fireEvent.click(trigger)
      const group = screen.getByRole('group', { name: action })
      expect(within(group).getByText(copy)).toBeInTheDocument()
      const cancel = within(group).getByRole('button', { name: 'Cancel' })
      await waitFor(() => {
        expect(cancel).toHaveFocus()
      })
      expect(
        within(group).getByRole('button', { name: action }),
      ).toBeInTheDocument()

      fireEvent.keyDown(cancel, { key: 'Escape' })
      await waitFor(() => {
        expect(screen.getByRole('button', { name: action })).toHaveFocus()
      })
      expect(screen.queryByRole('group')).not.toBeInTheDocument()

      fireEvent.click(screen.getByRole('button', { name: action }))
      fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
      await waitFor(() => {
        expect(screen.getByRole('button', { name: action })).toHaveFocus()
      })
      expect(cyclesMock.advanceStage).not.toHaveBeenCalled()
    },
  )

  it('sends one request with the shown status, reads "Moving…" while pending, and changes the mode only after the refetch', async () => {
    const pending = deferred<{ id: string; status: CycleStatus }>()
    cyclesMock.advanceStage.mockReturnValue(pending.promise)
    setup({ board: boardOf('reveal') })
    fireEvent.click(
      await screen.findByRole('button', { name: 'Start clustering' }),
    )
    const group = screen.getByRole('group', { name: 'Start clustering' })
    const confirm = within(group).getByRole('button', {
      name: 'Start clustering',
    })
    fireEvent.click(confirm)
    fireEvent.click(confirm)
    fireEvent.keyDown(confirm, { key: 'Enter' })
    fireEvent.click(confirm)

    await waitFor(() => {
      expect(
        within(group).getByRole('button', { name: 'Moving…' }),
      ).toBeDisabled()
    })
    expect(cyclesMock.advanceStage).toHaveBeenCalledTimes(1)
    expect(cyclesMock.advanceStage).toHaveBeenCalledWith(CYCLE_ID, 'reveal')
    // Nothing is optimistic.
    expect(
      screen.getByRole('heading', { level: 2, name: 'Reveal' }),
    ).toBeInTheDocument()

    boardMock.fetchCycleBoard.mockResolvedValue(boardOf('cluster'))
    await act(async () => {
      pending.resolve({ id: CYCLE_ID, status: 'cluster' })
      await pending.promise
    })

    expect(await screen.findByText('The board moved to Cluster.')).toBeVisible()
    const heading = await modeHeading('Cluster')
    await waitFor(() => {
      expect(heading).toHaveFocus()
    })
    expect(cyclesMock.advanceStage).toHaveBeenCalledTimes(1)
  })

  async function confirmClustering(): Promise<void> {
    fireEvent.click(
      await screen.findByRole('button', { name: 'Start clustering' }),
    )
    fireEvent.click(
      within(screen.getByRole('group')).getByRole('button', {
        name: 'Start clustering',
      }),
    )
    await waitFor(() => {
      expect(cyclesMock.advanceStage).toHaveBeenCalledTimes(1)
    })
  }

  it('focuses the new h2 when a Realtime-driven refetch renders the stage before the call resolves', async () => {
    const pending = deferred<{ id: string; status: CycleStatus }>()
    cyclesMock.advanceStage.mockReturnValue(pending.promise)
    setup({ board: boardOf('reveal') })
    await subscribed()
    await confirmClustering()

    // The stage change reaches the board first, through the channel.
    boardMock.fetchCycleBoard.mockResolvedValue(boardOf('cluster'))
    emitEvent()
    const heading = await modeHeading('Cluster')
    expect(heading).not.toHaveFocus()

    await act(async () => {
      pending.resolve({ id: CYCLE_ID, status: 'cluster' })
      await pending.promise
    })
    await waitFor(() => {
      expect(
        screen.getByRole('heading', { level: 2, name: 'Cluster' }),
      ).toHaveFocus()
    })
  })

  it('focuses the new h2 when the board refetch lands only after the call resolved', async () => {
    cyclesMock.advanceStage.mockResolvedValue({
      id: CYCLE_ID,
      status: 'cluster',
    })
    setup({ board: boardOf('reveal') })
    await modeHeading('Reveal')
    const refetch = deferred<CycleBoard | null>()
    boardMock.fetchCycleBoard.mockReturnValue(refetch.promise)
    await confirmClustering()
    // The mutation waits for its invalidation, so release the refetch now.
    expect(
      screen.getByRole('heading', { level: 2, name: 'Reveal' }),
    ).toBeInTheDocument()

    await act(async () => {
      refetch.resolve(boardOf('cluster'))
      await refetch.promise
    })
    const heading = await modeHeading('Cluster')
    await waitFor(() => {
      expect(heading).toHaveFocus()
    })
  })

  it('does not move focus when its own advance fails, even if another tab moved the stage', async () => {
    const pending = deferred<{ id: string; status: CycleStatus }>()
    cyclesMock.advanceStage.mockReturnValue(pending.promise)
    setup({ board: boardOf('reveal') })
    await subscribed()
    await confirmClustering()

    boardMock.fetchCycleBoard.mockResolvedValue(boardOf('cluster'))
    emitEvent()
    await modeHeading('Cluster')

    await act(async () => {
      pending.reject(new CyclesApiError('stage_out_of_date'))
      await pending.promise.catch(() => undefined)
    })
    expect(
      await screen.findByText('The stage has already changed.'),
    ).toBeVisible()
    expect(
      screen.getByRole('heading', { level: 2, name: 'Cluster' }),
    ).not.toHaveFocus()
  })

  it('moves cluster to vote with its toast', async () => {
    cyclesMock.advanceStage.mockResolvedValue({ id: CYCLE_ID, status: 'vote' })
    setup({ board: boardOf('cluster') })
    fireEvent.click(await screen.findByRole('button', { name: 'Start voting' }))
    boardMock.fetchCycleBoard.mockResolvedValue(boardOf('vote'))
    fireEvent.click(
      within(screen.getByRole('group')).getByRole('button', {
        name: 'Start voting',
      }),
    )

    expect(await screen.findByText('The board moved to Vote.')).toBeVisible()
    const heading = await modeHeading('Vote')
    await waitFor(() => {
      expect(heading).toHaveFocus()
    })
    expect(cyclesMock.advanceStage).toHaveBeenCalledWith(CYCLE_ID, 'cluster')
  })

  it.each<[CyclesErrorCode, string]>([
    ['stage_out_of_date', 'The stage has already changed.'],
    [
      'invalid_stage_transition',
      'This stage cannot be changed from the board.',
    ],
    ['unknown', 'Could not change the stage.'],
  ])(
    '%s closes the confirmation, shows its message, and re-reads the board',
    async (code, message) => {
      cyclesMock.advanceStage.mockRejectedValue(new CyclesApiError(code))
      setup({ board: boardOf('reveal') })
      fireEvent.click(
        await screen.findByRole('button', { name: 'Start clustering' }),
      )
      const before = boardMock.fetchCycleBoard.mock.calls.length
      fireEvent.click(
        within(screen.getByRole('group')).getByRole('button', {
          name: 'Start clustering',
        }),
      )

      expect(await screen.findByText(message)).toBeVisible()
      await waitFor(() => {
        expect(screen.queryByRole('group')).not.toBeInTheDocument()
      })
      expect(
        screen.getByRole('button', { name: 'Start clustering' }),
      ).toBeEnabled()
      await waitFor(() => {
        expect(boardMock.fetchCycleBoard.mock.calls.length).toBeGreaterThan(
          before,
        )
      })
      expect(document.body).not.toHaveTextContent(/P0001|42501/)
    },
  )

  it('not_project_facilitator re-reads the members, so the control disappears (a transfer while open)', async () => {
    cyclesMock.advanceStage.mockRejectedValue(
      new CyclesApiError('not_project_facilitator'),
    )
    setup({ board: boardOf('reveal') })
    fireEvent.click(
      await screen.findByRole('button', { name: 'Start clustering' }),
    )
    membersMock.fetchProjectMembers.mockResolvedValue(asFormerFacilitator)
    fireEvent.click(
      within(screen.getByRole('group')).getByRole('button', {
        name: 'Start clustering',
      }),
    )

    expect(
      await screen.findByText('Only the facilitator can change the stage.'),
    ).toBeVisible()
    await waitFor(() => {
      expect(
        screen.queryByRole('button', { name: 'Start clustering' }),
      ).not.toBeInTheDocument()
    })
    expect(
      screen.getByRole('heading', { level: 2, name: 'Reveal' }),
    ).toBeInTheDocument()
  })

  it('not_project_member switches to the not-found state', async () => {
    cyclesMock.advanceStage.mockRejectedValue(
      new CyclesApiError('not_project_member'),
    )
    setup({ board: boardOf('reveal') })
    fireEvent.click(
      await screen.findByRole('button', { name: 'Start clustering' }),
    )
    fireEvent.click(
      within(screen.getByRole('group')).getByRole('button', {
        name: 'Start clustering',
      }),
    )

    expect(await screen.findByText(NOT_FOUND)).toBeInTheDocument()
    expect(screen.queryByText('Sprint twelve retro')).not.toBeInTheDocument()
  })

  it('the new facilitator sees the control after the members query refetches on window focus', async () => {
    setup({ board: boardOf('reveal'), members: asMember })
    await modeHeading('Reveal')
    await waitFor(() => {
      expect(membersMock.fetchProjectMembers).toHaveBeenCalledTimes(1)
    })
    expect(
      screen.queryByRole('button', { name: 'Start clustering' }),
    ).not.toBeInTheDocument()

    membersMock.fetchProjectMembers.mockResolvedValue(asFacilitator)
    act(() => {
      window.dispatchEvent(new Event('focus'))
    })
    expect(
      await screen.findByRole('button', { name: 'Start clustering' }),
    ).toBeInTheDocument()

    membersMock.fetchProjectMembers.mockResolvedValue(asMember)
    act(() => {
      window.dispatchEvent(new Event('online'))
    })
    await waitFor(() => {
      expect(
        screen.queryByRole('button', { name: 'Start clustering' }),
      ).not.toBeInTheDocument()
    })
  })
})

describe('live updates and polling', () => {
  it('keeps exactly one channel under strict mode and removes it on unmount', async () => {
    const view = setup({ board: boardOf('reveal'), strictMode: true })
    await modeHeading('Reveal')
    await subscribed()

    view.unmount()
    expect(liveSubscriptions()).toHaveLength(0)
  })

  it('an event invalidates the board, cycle, and members; collecting turns into the card list', async () => {
    setup({ board: boardOf('collecting', false, OWN_CARDS) })
    await modeHeading('The retrospective has not started yet')
    await subscribed()
    const invalidate = vi.spyOn(queryClient, 'invalidateQueries')

    boardMock.fetchCycleBoard.mockResolvedValue(boardOf('reveal'))
    emitEvent()

    expect(await modeHeading('Reveal')).toBeInTheDocument()
    expect(screen.getByText('Start pairing')).toBeInTheDocument()
    const keys = invalidate.mock.calls.map(([filters]) => filters?.queryKey)
    expect(keys).toContainEqual(['cycle-board', 'user-1', CYCLE_ID])
    expect(keys).toContainEqual(['cycle', 'user-1', CYCLE_ID])
    expect(keys).toContainEqual(['project-members', 'user-1', PROJECT_ID])
    expect(await screen.findByText('Stage: Reveal')).toBeInTheDocument()
  })

  it('reveal -> cluster arrives live and is announced, with focus left alone', async () => {
    setup({ board: boardOf('reveal') })
    await modeHeading('Reveal')
    await subscribed()
    expect(screen.queryByText(/^Stage:/)).not.toBeInTheDocument()

    boardMock.fetchCycleBoard.mockResolvedValue(boardOf('cluster'))
    emitEvent()

    const heading = await modeHeading('Cluster')
    const status = screen.getByText('Stage: Cluster')
    expect(status).toHaveAttribute('role', 'status')
    expect(heading).not.toHaveFocus()
  })

  it('#68: a close event on a live cluster board shows Closed with cards, removes the channel, and starts no polling', async () => {
    setup({ board: boardOf('cluster') })
    await modeHeading('Cluster')
    await subscribed()
    emitStatus('SUBSCRIBED')

    boardMock.fetchCycleBoard.mockResolvedValue(boardOf('closed'))
    emitEvent()

    expect(await modeHeading('Closed')).toBeInTheDocument()
    expect(
      screen.getByText('This retrospective is closed.'),
    ).toBeInTheDocument()
    expect(screen.getByText('Start pairing')).toBeInTheDocument()
    await waitFor(() => {
      expect(liveSubscriptions()).toHaveLength(0)
    })
    expect(screen.queryByText(LIVE_NOTICE)).not.toBeInTheDocument()
  })

  it('#68: a close event on a collecting board shows the closed-before-reveal state', async () => {
    setup({ board: boardOf('collecting', false, OWN_CARDS) })
    await modeHeading('The retrospective has not started yet')
    await subscribed()

    boardMock.fetchCycleBoard.mockResolvedValue(
      boardOf('closed', false, OWN_CARDS),
    )
    emitEvent()

    expect(
      await screen.findByText(
        'This cycle was closed before the retrospective started, so no feedback was revealed.',
      ),
    ).toBeInTheDocument()
    expect(screen.queryByText('My secret start')).not.toBeInTheDocument()
    await waitFor(() => {
      expect(liveSubscriptions()).toHaveLength(0)
    })
  })

  it('opens no channel for a closed cycle', async () => {
    setup({ board: boardOf('closed') })
    await modeHeading('Closed')
    expect(cyclesMock.subscribeToCycleEvents).not.toHaveBeenCalled()
  })

  it.each(['CHANNEL_ERROR', 'TIMED_OUT', 'CLOSED'] as const)(
    'after %s it shows the notice and polls every 4 s while visible, then stops on SUBSCRIBED',
    async (failure) => {
      setup({ board: boardOf('reveal') })
      await modeHeading('Reveal')
      await subscribed()
      emitStatus('SUBSCRIBED')
      await waitFor(() => {
        expect(boardMock.fetchCycleBoard).toHaveBeenCalledTimes(2)
      })

      vi.useFakeTimers({
        toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'],
      })
      emitStatus(failure)
      expect(screen.getByText(LIVE_NOTICE)).toHaveAttribute('role', 'status')

      const boardCalls = () => boardMock.fetchCycleBoard.mock.calls.length
      const cycleCalls = () => cyclesMock.fetchCycle.mock.calls.length
      const board0 = boardCalls()
      const cycle0 = cycleCalls()
      await act(async () => {
        await vi.advanceTimersByTimeAsync(4000)
      })
      expect(boardCalls()).toBe(board0 + 1)
      expect(cycleCalls()).toBe(cycle0 + 1)
      await act(async () => {
        await vi.advanceTimersByTimeAsync(4000)
      })
      expect(boardCalls()).toBe(board0 + 2)

      // Hidden tab: no polling.
      Object.defineProperty(document, 'visibilityState', {
        configurable: true,
        get: () => 'hidden',
      })
      act(() => {
        document.dispatchEvent(new Event('visibilitychange'))
      })
      const hidden0 = boardCalls()
      await act(async () => {
        await vi.advanceTimersByTimeAsync(12_000)
      })
      expect(boardCalls()).toBe(hidden0)
      Reflect.deleteProperty(document, 'visibilityState')
      act(() => {
        document.dispatchEvent(new Event('visibilitychange'))
      })
      await act(async () => {
        await vi.advanceTimersByTimeAsync(4000)
      })
      expect(boardCalls()).toBeGreaterThan(hidden0)

      // Back to live: one invalidation, the notice goes, polling stops.
      const live0 = boardCalls()
      emitStatus('SUBSCRIBED')
      await act(async () => {
        await vi.advanceTimersByTimeAsync(0)
      })
      expect(boardCalls()).toBe(live0 + 1)
      expect(screen.queryByText(LIVE_NOTICE)).not.toBeInTheDocument()
      await act(async () => {
        await vi.advanceTimersByTimeAsync(12_000)
      })
      expect(boardCalls()).toBe(live0 + 1)
    },
  )

  it('does not poll while connecting', async () => {
    setup({ board: boardOf('reveal') })
    await modeHeading('Reveal')
    await subscribed()
    vi.useFakeTimers({
      toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'],
    })
    const before = boardMock.fetchCycleBoard.mock.calls.length
    await act(async () => {
      await vi.advanceTimersByTimeAsync(12_000)
    })
    expect(boardMock.fetchCycleBoard.mock.calls.length).toBe(before)
    expect(screen.queryByText(LIVE_NOTICE)).not.toBeInTheDocument()
  })
})

describe('access, loading, and errors', () => {
  it('a non-member sees only the not-found state', async () => {
    setup()
    boardMock.fetchCycleBoard.mockRejectedValue(
      new BoardApiError('not_project_member'),
    )

    expect(await screen.findByText(NOT_FOUND)).toBeInTheDocument()
    expect(
      screen.getByRole('link', { name: 'Back to projects' }),
    ).toHaveAttribute('href', '/projects')
    expect(screen.queryByText('Sprint twelve retro')).not.toBeInTheDocument()
    expect(liveSubscriptions()).toHaveLength(0)
  })

  it('an unknown cycle id (the cycle query resolves null) sees only the not-found state', async () => {
    setup()
    cyclesMock.fetchCycle.mockResolvedValue(null)

    expect(await screen.findByText(NOT_FOUND)).toBeInTheDocument()
    expect(screen.queryByRole('heading', { level: 2 })).not.toBeInTheDocument()
  })

  it('a non-UUID id shows not found without a board request', async () => {
    mockRestoredSession()
    profileMock.fetchProfileDisplayName.mockResolvedValue('Dev User')
    renderApp({ initialEntries: ['/cycles/not-a-uuid/board'] })

    expect(await screen.findByText(NOT_FOUND)).toBeInTheDocument()
    expect(boardMock.fetchCycleBoard).not.toHaveBeenCalled()
    expect(cyclesMock.subscribeToCycleEvents).not.toHaveBeenCalled()
  })

  it.each([
    ['the board refetch returns not_project_member', 'board'],
    ['the cycle query resolves null', 'cycle'],
  ] as const)(
    'a member removed while open (%s) loses everything shown before, and no further board request is made',
    async (_label, which) => {
      setup({ board: boardOf('reveal') })
      await modeHeading('Reveal')
      await subscribed()

      if (which === 'board') {
        boardMock.fetchCycleBoard.mockRejectedValue(
          new BoardApiError('not_project_member'),
        )
      } else {
        cyclesMock.fetchCycle.mockResolvedValue(null)
      }
      emitEvent()

      expect(await screen.findByText(NOT_FOUND)).toBeInTheDocument()
      for (const text of [
        'Sprint twelve retro',
        'Start pairing',
        'Revealed',
        'Reveal',
      ]) {
        expect(screen.queryByText(text)).not.toBeInTheDocument()
      }
      expect(
        screen.queryByRole('list', { name: 'Retrospective stages' }),
      ).not.toBeInTheDocument()
      await waitFor(() => {
        expect(liveSubscriptions()).toHaveLength(0)
      })

      const calls = boardMock.fetchCycleBoard.mock.calls.length
      await act(async () => {
        await queryClient.invalidateQueries()
        window.dispatchEvent(new Event('focus'))
      })
      expect(boardMock.fetchCycleBoard.mock.calls.length).toBe(calls)
    },
  )

  it('shows "Loading board…" while the first read is pending', async () => {
    const pending = deferred<CycleBoard | null>()
    setup()
    boardMock.fetchCycleBoard.mockReturnValue(pending.promise)

    expect(await screen.findByText('Loading board…')).toHaveAttribute(
      'role',
      'status',
    )
    await act(async () => {
      pending.resolve(boardOf('reveal'))
      await pending.promise
    })
    expect(await modeHeading('Reveal')).toBeInTheDocument()
  })

  it('a failed first read shows the alert with Retry, which loads the board', async () => {
    setup()
    boardMock.fetchCycleBoard.mockRejectedValue(new BoardApiError('unknown'))

    const alert = await screen.findByRole('alert')
    expect(alert).toHaveTextContent(LOAD_ERROR)
    boardMock.fetchCycleBoard.mockResolvedValue(boardOf('reveal'))
    fireEvent.click(within(alert).getByRole('button', { name: 'Retry' }))
    expect(await modeHeading('Reveal')).toBeInTheDocument()
  })

  it('a failed later refetch keeps the last good data and shows the alert', async () => {
    setup({ board: boardOf('reveal') })
    await modeHeading('Reveal')
    await subscribed()

    boardMock.fetchCycleBoard.mockRejectedValue(new BoardApiError('unknown'))
    emitEvent()

    expect(await screen.findByRole('alert')).toHaveTextContent(LOAD_ERROR)
    expect(
      screen.getByRole('heading', { level: 2, name: 'Reveal' }),
    ).toBeInTheDocument()
    expect(screen.getByText('Start pairing')).toBeInTheDocument()
  })

  it('signed out: lands on /login with no board request or channel, and comes back after sign-in', async () => {
    mockEmptySession()
    profileMock.fetchProfileDisplayName.mockResolvedValue('Dev User')
    cyclesMock.fetchCycle.mockResolvedValue(cycle)
    boardMock.fetchCycleBoard.mockResolvedValue(boardOf('reveal'))
    membersMock.fetchProjectMembers.mockResolvedValue(asFacilitator)
    renderApp({ initialEntries: [PATH] })

    await waitFor(() => {
      expect(screen.getByTestId('location')).toHaveTextContent(
        `/login?redirectTo=${encodeURIComponent(PATH)}`,
      )
    })
    expect(boardMock.fetchCycleBoard).not.toHaveBeenCalled()
    expect(cyclesMock.subscribeToCycleEvents).not.toHaveBeenCalled()

    act(() => {
      authMock.emitAuthEvent('SIGNED_IN', makeSession('dev@example.com'))
    })
    expect(await modeHeading('Reveal')).toBeInTheDocument()
    expect(screen.getByTestId('location')).toHaveTextContent(PATH)
  })

  it('signing out while the board is open removes the channel and stops polling', async () => {
    setup({ board: boardOf('reveal') })
    await modeHeading('Reveal')
    await subscribed()
    emitStatus('CHANNEL_ERROR')
    expect(screen.getByText(LIVE_NOTICE)).toBeInTheDocument()

    act(() => {
      authMock.emitAuthEvent('SIGNED_OUT', null)
    })
    await waitFor(() => {
      expect(screen.getByTestId('location')).toHaveTextContent('/login')
    })
    expect(liveSubscriptions()).toHaveLength(0)

    vi.useFakeTimers({
      toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'],
    })
    const calls = boardMock.fetchCycleBoard.mock.calls.length
    await act(async () => {
      await vi.advanceTimersByTimeAsync(12_000)
    })
    expect(boardMock.fetchCycleBoard.mock.calls.length).toBe(calls)
  })
})
