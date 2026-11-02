import {
  act,
  createEvent,
  fireEvent,
  screen,
  waitFor,
  within,
} from '@testing-library/react'
import { toast } from 'sonner'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { CycleDetail } from '../cycles/cyclesApi'
import type { CycleStatus } from '../cycles/cycleStatus'
import { queryClient } from '../lib/queryClient'
import type { ProjectMember } from '../projects/membersApi'
import { deferred, mockRestoredSession } from '../test/authMock'
import { boardMock } from '../test/boardMock'
import { cyclesMock } from '../test/cyclesMock'
import { membersMock } from '../test/membersMock'
import { profileMock } from '../test/profileMock'
import { renderApp } from '../test/renderApp'
import type { BoardCard, BoardCluster, CycleBoard } from './boardApi'
import { CARD_DRAG_TYPE } from './cardMove'
import { ClustersApiError, type ClusterErrorCode } from './clusterErrors'
import type { SavedCluster } from './clustersApi'

const CYCLE_ID = '30000000-0000-4000-8000-000000000001'
const PROJECT_ID = '10000000-0000-4000-8000-000000000001'
const PATH = `/cycles/${CYCLE_ID}/board`
const NOT_FOUND = 'Cycle not found or you do not have access.'
const PLACEHOLDER = 'Grouping cards into clusters is not available yet.'
const INTRO =
  'Group related cards into clusters. Only you, as the facilitator, can change clusters until voting starts.'
const READ_ONLY_INTRO =
  'The facilitator is grouping the cards into clusters. Changes appear here as they are made, until voting starts.'
const LIVE_NOTICE =
  'Live updates are unavailable. The board refreshes every few seconds.'

const cycle: CycleDetail = {
  id: CYCLE_ID,
  projectId: PROJECT_ID,
  title: 'Sprint twelve retro',
  weekStart: '2026-10-26',
  status: 'cluster',
}

// Interleaved categories, ids out of alphabetical order: nothing is sorted.
const CARDS: readonly BoardCard[] = [
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
    category: 'stop',
    text: 'Stop long meetings',
    isAnonymous: false,
    isMine: false,
    authorDisplayName: null,
  },
]

const PROCESS: BoardCluster = {
  clusterId: 'd1000000-0000-4000-8000-000000000001',
  name: 'Process',
  source: 'manual',
  // card_ids order, not the cards' order.
  cardIds: [CARDS[3].cardId, CARDS[2].cardId],
}

const TOOLS: BoardCluster = {
  clusterId: 'a1000000-0000-4000-8000-000000000002',
  name: 'Tools',
  source: 'ai',
  cardIds: [],
}

function boardOf(
  status: CycleStatus,
  clusters: readonly BoardCluster[] = [PROCESS, TOOLS],
  cards: readonly BoardCard[] = CARDS,
): CycleBoard {
  return {
    cycleId: CYCLE_ID,
    status,
    isRevealed: status !== 'collecting',
    cards,
    clusters,
  }
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
const asOwnerOnly = [
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
  readonly userId?: string
  readonly pointer?: 'fine' | 'coarse'
}

function mockPointer(pointer: 'fine' | 'coarse') {
  vi.spyOn(window, 'matchMedia').mockImplementation(
    (query: string): MediaQueryList => ({
      matches: query === '(pointer: fine)' && pointer === 'fine',
      media: query,
      onchange: null,
      addListener: () => undefined,
      removeListener: () => undefined,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
      dispatchEvent: () => false,
    }),
  )
}

function setup(options: SetupOptions = {}) {
  mockPointer(options.pointer ?? 'coarse')
  mockRestoredSession('dev@example.com', options.userId ?? 'user-1')
  profileMock.fetchProfileDisplayName.mockResolvedValue('Dev User')
  cyclesMock.fetchCycle.mockResolvedValue(cycle)
  boardMock.fetchCycleBoard.mockResolvedValue(
    options.board ?? boardOf('cluster'),
  )
  const members = options.members ?? asFacilitator
  editableSetup = isFacilitatorOf(members)
  membersMock.fetchProjectMembers.mockResolvedValue(members)
  return renderApp({ initialEntries: [PATH] })
}

function saved(
  cluster: Pick<BoardCluster, 'clusterId' | 'name'>,
): SavedCluster {
  return { clusterId: cluster.clusterId, name: cluster.name, source: 'manual' }
}

/** Whether the last setup's caller is the facilitator (#19b). */
let editableSetup = true

function isFacilitatorOf(members: readonly ProjectMember[]): boolean {
  return members.some((member) => member.isMe && member.role === 'facilitator')
}

/**
 * The cluster board, once the members query has given the facilitator the
 * controls (#19b: the board shows read-only until then).
 */
async function clusterBoard(): Promise<HTMLElement> {
  const board = await screen.findByTestId('cluster-board')
  if (editableSetup) {
    await screen.findByRole('form', { name: 'New cluster' })
  }
  return board
}

function newForm(): HTMLElement {
  return screen.getByRole('form', { name: 'New cluster' })
}

function newInput(): HTMLElement {
  return within(newForm()).getByRole('textbox', { name: 'Cluster name' })
}

function addButton(): HTMLElement {
  return within(newForm()).getByRole('button', {
    name: /^(Add cluster|Adding…)$/,
  })
}

function typeInto(input: HTMLElement, value: string) {
  fireEvent.change(input, { target: { value } })
}

function section(name: string): HTMLElement {
  const heading = screen.getByRole('heading', { level: 3, name })
  const element = heading.closest('section')
  if (element === null) {
    throw new Error(`no section for ${name}`)
  }
  return element
}

function texts(list: HTMLElement): string[] {
  return within(list)
    .getAllByRole('listitem')
    .map((item) => item.querySelectorAll('p')[1]?.textContent ?? '')
}

function statusText(): string {
  const region = within(screen.getByTestId('cluster-board')).getByRole('status')
  return region.textContent
}

/**
 * React's generated ids (`useId`) come from a counter shared by every render
 * in a test file, so two renders of the same tree get different ids. Number
 * them by first appearance to compare structure.
 */
function normalizeIds(html: string): string {
  const seen = new Map<string, string>()
  return html.replace(/_r_[0-9a-z]+_/g, (id) => {
    const known = seen.get(id)
    if (known !== undefined) {
      return known
    }
    const next = `id-${seen.size}`
    seen.set(id, next)
    return next
  })
}

function emitEvent() {
  act(() => {
    cyclesMock.emitCycleEvent(CYCLE_ID)
  })
}

async function subscribed(): Promise<void> {
  await waitFor(() => {
    expect(
      cyclesMock
        .activeCycleEventsSubscriptions()
        .filter((subscription) => subscription.cycleId === CYCLE_ID),
    ).toHaveLength(1)
  })
}

afterEach(() => {
  vi.useRealTimers()
})

describe('cluster mode layout', () => {
  it('replaces the placeholder with the intro, the form, Ungrouped, and the clusters in response order', async () => {
    setup()
    const board = await clusterBoard()

    expect(screen.queryByText(PLACEHOLDER)).not.toBeInTheDocument()
    expect(screen.getByText(INTRO)).toBeInTheDocument()
    expect(newInput()).toHaveAttribute('type', 'text')
    expect(newInput()).not.toHaveAttribute('maxlength')
    expect(addButton()).toHaveTextContent('Add cluster')

    // Headings: one h1, one h2, one h3 per section.
    expect(screen.getAllByRole('heading', { level: 1 })).toHaveLength(1)
    expect(screen.getAllByRole('heading', { level: 2 })).toHaveLength(1)
    expect(
      within(board)
        .getAllByRole('heading', { level: 3 })
        .map((heading) => heading.textContent),
    ).toEqual([
      'AI suggestions',
      'Ungrouped (3)',
      'Process (2)',
      'Tools (0) AI suggestion',
    ])

    const ungrouped = within(section('Ungrouped (3)')).getByRole('list', {
      name: 'Ungrouped cards',
    })
    expect(texts(ungrouped)).toEqual([
      'Start pairing',
      'Continue demos',
      'Stop long meetings',
    ])
    const firstItem = within(ungrouped).getAllByRole('listitem')[0]
    expect(firstItem).toHaveTextContent('StartStart pairingGrace')

    const processList = within(section('Process (2)')).getByRole('list', {
      name: 'Cards in Process',
    })
    expect(texts(processList)).toEqual([
      'Stop late merges',
      'Start writing ADRs',
    ])
    expect(within(processList).getAllByRole('listitem')[0]).toHaveTextContent(
      'StopStop late mergesAda (you)',
    )
    expect(
      within(section('Tools (0) AI suggestion')).getByText(
        'No cards in this cluster yet.',
      ),
    ).toBeInTheDocument()

    for (const name of ['Process', 'Tools']) {
      expect(
        screen.getByRole('button', { name: `Rename cluster ${name}` }),
      ).toHaveTextContent('Rename')
      expect(
        screen.getByRole('button', { name: `Delete cluster ${name}` }),
      ).toHaveTextContent('Delete')
    }
    expect(screen.queryByText('No clusters yet. Add one above.')).toBeNull()
  })

  it('an anonymous card in a cluster renders as in Ungrouped, identically for two users', async () => {
    const anonymousInCluster: BoardCluster = {
      ...PROCESS,
      cardIds: [CARDS[2].cardId],
    }
    const html: string[] = []
    for (const userId of ['user-1', 'user-2']) {
      const view = setup({
        board: boardOf('cluster', [anonymousInCluster]),
        userId,
      })
      await clusterBoard()
      const clustered = within(
        within(section('Process (1)')).getByRole('list'),
      ).getByRole('listitem')
      const ungroupedAnonymous = within(
        within(section('Ungrouped (4)')).getByRole('list'),
      )
        .getAllByRole('listitem')
        .find((item) => item.textContent.includes('Continue demos'))
      expect(clustered).toHaveTextContent('StartStart writing ADRsAnonymous')
      expect(clustered.textContent).not.toMatch(/you/)
      // The Move control is part of both items (#18); its text and the card
      // id are the only differences besides the category.
      expect(
        normalizeIds(
          (ungroupedAnonymous?.outerHTML ?? '')
            .replaceAll('Continue demos', 'X')
            .replaceAll(CARDS[1].cardId, 'ID'),
        ),
      ).toBe(
        normalizeIds(
          clustered.outerHTML
            .replaceAll('Start writing ADRs', 'X')
            .replaceAll(CARDS[2].cardId, 'ID')
            .replace('>Start<', '>Continue<'),
        ),
      )
      html.push(normalizeIds(clustered.outerHTML))
      view.unmount()
      queryClient.clear()
    }
    expect(html[1]).toBe(html[0])
  })

  it('says when there are no clusters and when every card is in a cluster', async () => {
    const view = setup({ board: boardOf('cluster', []) })
    await clusterBoard()
    expect(
      screen.getByText('No clusters yet. Add one above.'),
    ).toBeInTheDocument()
    expect(
      screen.getByRole('heading', { level: 3, name: 'Ungrouped (5)' }),
    ).toBeInTheDocument()
    view.unmount()
    queryClient.clear()

    setup({
      board: boardOf('cluster', [
        { ...PROCESS, cardIds: CARDS.map((card) => card.cardId) },
      ]),
    })
    await clusterBoard()
    expect(screen.getByText('Every card is in a cluster.')).toBeInTheDocument()
    expect(
      screen.getByRole('heading', { level: 3, name: 'Ungrouped (0)' }),
    ).toBeInTheDocument()
  })

  it('with zero cards says no feedback was submitted', async () => {
    setup({ board: boardOf('cluster', [], []) })
    await clusterBoard()
    expect(
      screen.getByText('No feedback was submitted for this cycle.'),
    ).toBeInTheDocument()
  })

  it.each(['reveal', 'vote', 'discuss', 'closed'] as const)(
    'in %s there is no cluster form, Rename, or Delete, and the card list is unchanged',
    async (status) => {
      setup({ board: boardOf(status) })
      await screen.findByRole('heading', { level: 2 })

      expect(screen.queryByTestId('cluster-board')).not.toBeInTheDocument()
      expect(
        screen.queryByRole('form', { name: 'New cluster' }),
      ).not.toBeInTheDocument()
      expect(screen.queryByRole('button', { name: /Rename|Delete/ })).toBeNull()
      expect(screen.queryByText(INTRO)).not.toBeInTheDocument()
      expect(
        screen.getByRole('heading', { level: 3, name: 'Start (2)' }),
      ).toBeInTheDocument()
    },
  )
})

describe('adding a cluster', () => {
  it.each([
    ['', 'Enter a cluster name.'],
    ['  \t ', 'Enter a cluster name.'],
    ['x'.repeat(101), 'Use 100 characters or fewer.'],
    ['  process ', 'A cluster with this name already exists.'],
    ['TOOLS', 'A cluster with this name already exists.'],
    ['ungrouped', 'Choose a name other than Ungrouped.'],
    [' UNGROUPED ', 'Choose a name other than Ungrouped.'],
  ])('%j shows "%s" inline with no request', async (value, message) => {
    setup()
    await clusterBoard()

    typeInto(newInput(), value)
    fireEvent.click(addButton())

    const error = within(newForm()).getByText(message)
    expect(newInput()).toHaveAttribute('aria-invalid', 'true')
    expect(newInput()).toHaveAttribute('aria-describedby', error.id)
    expect(boardMock.createCluster).not.toHaveBeenCalled()

    // Typing clears the message.
    typeInto(newInput(), 'Docs')
    expect(within(newForm()).queryByText(message)).toBeNull()
    expect(newInput()).not.toHaveAttribute('aria-invalid')
  })

  it('accepts exactly 100 characters, trimmed', async () => {
    setup()
    await clusterBoard()
    const name = 'y'.repeat(100)
    boardMock.createCluster.mockResolvedValue(
      saved({ clusterId: 'e1000000-0000-4000-8000-000000000003', name }),
    )

    typeInto(newInput(), `  ${name}  `)
    fireEvent.submit(newForm())

    await waitFor(() => {
      expect(boardMock.createCluster).toHaveBeenCalledWith(CYCLE_ID, name)
    })
  })

  it('sends one request for a double click, shows Adding…, then clears the input, keeps focus, announces, and refetches', async () => {
    setup()
    await clusterBoard()
    const pending = deferred<SavedCluster>()
    boardMock.createCluster.mockReturnValue(pending.promise)
    const docs: BoardCluster = {
      clusterId: 'e1000000-0000-4000-8000-000000000003',
      name: 'Docs',
      source: 'manual',
      cardIds: [],
    }

    typeInto(newInput(), '  Docs ')
    fireEvent.click(addButton())
    fireEvent.click(addButton())
    fireEvent.submit(newForm())

    await waitFor(() => {
      expect(addButton()).toHaveTextContent('Adding…')
    })
    expect(boardMock.createCluster).toHaveBeenCalledTimes(1)
    expect(boardMock.createCluster).toHaveBeenCalledWith(CYCLE_ID, 'Docs')
    expect(addButton()).toBeDisabled()
    // Nothing is optimistic.
    expect(screen.queryByRole('heading', { name: 'Docs (0)' })).toBeNull()

    const before = boardMock.fetchCycleBoard.mock.calls.length
    boardMock.fetchCycleBoard.mockResolvedValue(
      boardOf('cluster', [PROCESS, TOOLS, docs]),
    )
    await act(async () => {
      pending.resolve(saved(docs))
      await pending.promise
    })

    expect(
      await screen.findByRole('heading', { level: 3, name: 'Docs (0)' }),
    ).toBeInTheDocument()
    expect(boardMock.fetchCycleBoard.mock.calls.length).toBeGreaterThan(before)
    expect(newInput()).toHaveValue('')
    expect(newInput()).toHaveFocus()
    expect(statusText()).toBe('Added cluster Docs.')
    expect(addButton()).toHaveTextContent('Add cluster')
    expect(addButton()).toBeEnabled()
  })

  it.each<[ClusterErrorCode, string, boolean]>([
    ['cluster_not_found', 'This cluster no longer exists.', true],
    [
      'cycle_not_clustering',
      'Clusters can only be changed during the Cluster stage.',
      false,
    ],
    [
      'invalid_cluster_name',
      'Enter a cluster name of 1 to 100 characters on one line.',
      true,
    ],
    ['cluster_name_taken', 'A cluster with this name already exists.', true],
    ['cluster_limit_reached', 'This cycle already has 50 clusters.', true],
    ['unknown', 'Could not save the cluster.', true],
  ])(
    'a create failing with %s shows "%s" and keeps the draft: %s',
    async (code, message, keepsDraft) => {
      setup()
      await clusterBoard()
      boardMock.createCluster.mockRejectedValue(new ClustersApiError(code))
      const before = boardMock.fetchCycleBoard.mock.calls.length

      typeInto(newInput(), 'Docs')
      fireEvent.click(addButton())

      expect(await screen.findByText(message)).toBeVisible()
      expect(screen.queryByText(code)).toBeNull()
      expect(newInput()).toHaveValue(keepsDraft ? 'Docs' : '')
      await waitFor(() => {
        expect(addButton()).toBeEnabled()
      })
      await waitFor(() => {
        expect(boardMock.fetchCycleBoard.mock.calls.length).toBeGreaterThan(
          before,
        )
      })
    },
  )

  it('not_project_member switches to the not-found state with no toast', async () => {
    setup()
    await clusterBoard()
    boardMock.createCluster.mockRejectedValue(
      new ClustersApiError('not_project_member'),
    )

    typeInto(newInput(), 'Docs')
    fireEvent.click(addButton())

    expect(await screen.findByText(NOT_FOUND)).toBeInTheDocument()
    expect(screen.queryByTestId('cluster-board')).not.toBeInTheDocument()
    expect(screen.queryByText('Docs')).toBeNull()
  })
})

describe('renaming a cluster', () => {
  async function openRename(name: string): Promise<HTMLElement> {
    fireEvent.click(
      screen.getByRole('button', { name: `Rename cluster ${name}` }),
    )
    const form = screen.getByRole('form', { name: `Rename cluster ${name}` })
    const input = within(form).getByRole('textbox', { name: 'Cluster name' })
    await waitFor(() => {
      expect(input).toHaveFocus()
    })
    return form
  }

  function renameInput(form: HTMLElement): HTMLElement {
    return within(form).getByRole('textbox', { name: 'Cluster name' })
  }

  it('opens prefilled with focus in the input, swapping the heading', async () => {
    setup()
    await clusterBoard()
    const form = await openRename('Process')

    expect(renameInput(form)).toHaveValue('Process')
    expect(
      screen.queryByRole('heading', { level: 3, name: 'Process (2)' }),
    ).toBeNull()
    expect(within(form).getByRole('button', { name: 'Save' })).toBeEnabled()
    expect(within(form).getByRole('button', { name: 'Cancel' })).toBeEnabled()
  })

  it.each(['Escape', 'Cancel'])(
    '%s closes it with no request and returns focus to Rename',
    async (how) => {
      setup()
      await clusterBoard()
      const form = await openRename('Process')
      typeInto(renameInput(form), 'Changed')

      if (how === 'Escape') {
        fireEvent.keyDown(renameInput(form), { key: 'Escape' })
      } else {
        fireEvent.click(within(form).getByRole('button', { name: 'Cancel' }))
      }

      const rename = await screen.findByRole('button', {
        name: 'Rename cluster Process',
      })
      await waitFor(() => {
        expect(rename).toHaveFocus()
      })
      expect(boardMock.renameCluster).not.toHaveBeenCalled()
      expect(
        screen.getByRole('heading', { level: 3, name: 'Process (2)' }),
      ).toBeInTheDocument()
    },
  )

  it('saving an unchanged name (after trimming) closes it with no request', async () => {
    setup()
    await clusterBoard()
    const form = await openRename('Process')
    typeInto(renameInput(form), '  Process\t')

    fireEvent.click(within(form).getByRole('button', { name: 'Save' }))

    const rename = await screen.findByRole('button', {
      name: 'Rename cluster Process',
    })
    await waitFor(() => {
      expect(rename).toHaveFocus()
    })
    expect(boardMock.renameCluster).not.toHaveBeenCalled()
  })

  it('validates inline, ignoring its own name but not the others', async () => {
    setup()
    await clusterBoard()
    const form = await openRename('Process')

    typeInto(renameInput(form), 'tools')
    fireEvent.submit(form)
    expect(
      within(form).getByText('A cluster with this name already exists.'),
    ).toBeInTheDocument()
    expect(renameInput(form)).toHaveAttribute('aria-invalid', 'true')

    typeInto(renameInput(form), '')
    fireEvent.submit(form)
    expect(within(form).getByText('Enter a cluster name.')).toBeInTheDocument()
    expect(boardMock.renameCluster).not.toHaveBeenCalled()
  })

  it('a case-only change is a real rename', async () => {
    setup()
    await clusterBoard()
    boardMock.renameCluster.mockResolvedValue(
      saved({ clusterId: PROCESS.clusterId, name: 'PROCESS' }),
    )
    const form = await openRename('Process')
    typeInto(renameInput(form), 'PROCESS')
    fireEvent.submit(form)

    await waitFor(() => {
      expect(boardMock.renameCluster).toHaveBeenCalledWith(
        PROCESS.clusterId,
        'PROCESS',
      )
    })
  })

  it.each(['the call resolves first', 'the refetch lands first'])(
    'a successful save closes the form, returns focus to Rename, and announces, when %s',
    async (order) => {
      setup()
      await clusterBoard()
      await subscribed()
      const pending = deferred<SavedCluster>()
      boardMock.renameCluster.mockReturnValue(pending.promise)
      const renamed = { ...PROCESS, name: 'Process and tools' }
      const form = await openRename('Process')
      typeInto(renameInput(form), ' Process and tools ')

      fireEvent.click(within(form).getByRole('button', { name: 'Save' }))
      fireEvent.click(
        within(form).getByRole('button', { name: /Save|Saving…/ }),
      )
      await waitFor(() => {
        expect(
          within(form).getByRole('button', { name: 'Saving…' }),
        ).toBeDisabled()
      })
      expect(boardMock.renameCluster).toHaveBeenCalledTimes(1)
      expect(boardMock.renameCluster).toHaveBeenCalledWith(
        PROCESS.clusterId,
        'Process and tools',
      )

      if (order === 'the refetch lands first') {
        // Realtime delivers the change before the call answers.
        boardMock.fetchCycleBoard.mockResolvedValue(
          boardOf('cluster', [renamed, TOOLS]),
        )
        emitEvent()
        await waitFor(() => {
          expect(
            screen.getByRole('form', {
              name: 'Rename cluster Process and tools',
            }),
          ).toBeInTheDocument()
        })
        // The draft is untouched by the refetch and the form stays open.
        expect(
          renameInput(
            screen.getByRole('form', {
              name: 'Rename cluster Process and tools',
            }),
          ),
        ).toHaveValue(' Process and tools ')
        await act(async () => {
          pending.resolve(saved(renamed))
          await pending.promise
        })
      } else {
        const refetch = deferred<CycleBoard>()
        boardMock.fetchCycleBoard.mockReturnValue(refetch.promise)
        await act(async () => {
          pending.resolve(saved(renamed))
          await pending.promise
        })
        const oldRename = await screen.findByRole('button', {
          name: 'Rename cluster Process',
        })
        await waitFor(() => {
          expect(oldRename).toHaveFocus()
        })
        await act(async () => {
          refetch.resolve(boardOf('cluster', [renamed, TOOLS]))
          await refetch.promise
        })
      }

      const rename = await screen.findByRole('button', {
        name: 'Rename cluster Process and tools',
      })
      await waitFor(() => {
        expect(rename).toHaveFocus()
      })
      expect(screen.queryByRole('form', { name: /^Rename cluster/ })).toBeNull()
      expect(statusText()).toBe('Renamed cluster to Process and tools.')
      expect(
        screen.getByRole('heading', {
          level: 3,
          name: 'Process and tools (2)',
        }),
      ).toBeInTheDocument()
    },
  )

  it.each<[ClusterErrorCode, string]>([
    ['cluster_name_taken', 'A cluster with this name already exists.'],
    [
      'invalid_cluster_name',
      'Enter a cluster name of 1 to 100 characters on one line.',
    ],
    ['unknown', 'Could not save the cluster.'],
  ])(
    'a rename failing with %s shows "%s", keeps the draft and the form, and re-enables Save',
    async (code, message) => {
      setup()
      await clusterBoard()
      boardMock.renameCluster.mockRejectedValue(new ClustersApiError(code))
      const form = await openRename('Process')
      typeInto(renameInput(form), 'Renamed')
      fireEvent.submit(form)

      expect(await screen.findByText(message)).toBeVisible()
      expect(screen.queryByText(code)).toBeNull()
      await waitFor(() => {
        expect(within(form).getByRole('button', { name: 'Save' })).toBeEnabled()
      })
      expect(renameInput(form)).toHaveValue('Renamed')
    },
  )

  it('a rename failing with cycle_not_clustering shows its toast and drops the draft', async () => {
    setup()
    await clusterBoard()
    boardMock.renameCluster.mockRejectedValue(
      new ClustersApiError('cycle_not_clustering'),
    )
    const form = await openRename('Process')
    typeInto(renameInput(form), 'Renamed')
    fireEvent.submit(form)

    expect(
      await screen.findByText(
        'Clusters can only be changed during the Cluster stage.',
      ),
    ).toBeVisible()
    expect(screen.queryByRole('form', { name: /^Rename cluster/ })).toBeNull()
    expect(screen.queryByDisplayValue('Renamed')).toBeNull()
  })

  it('a rename failing with cluster_not_found toasts, and the refetch without the cluster closes the form and focuses Cluster name', async () => {
    setup()
    await clusterBoard()
    boardMock.renameCluster.mockRejectedValue(
      new ClustersApiError('cluster_not_found'),
    )
    const form = await openRename('Process')
    typeInto(renameInput(form), 'Renamed')
    boardMock.fetchCycleBoard.mockResolvedValue(boardOf('cluster', [TOOLS]))
    fireEvent.submit(form)

    expect(
      await screen.findByText('This cluster no longer exists.'),
    ).toBeVisible()
    await waitFor(() => {
      expect(screen.queryByRole('form', { name: /^Rename cluster/ })).toBeNull()
    })
    await waitFor(() => {
      expect(newInput()).toHaveFocus()
    })
  })

  it('a refetch that renames the cluster being edited leaves the draft untouched', async () => {
    setup()
    await clusterBoard()
    await subscribed()
    const form = await openRename('Process')
    typeInto(renameInput(form), 'My draft')

    boardMock.fetchCycleBoard.mockResolvedValue(
      boardOf('cluster', [{ ...PROCESS, name: 'Someone else' }, TOOLS]),
    )
    emitEvent()

    const renamedForm = await screen.findByRole('form', {
      name: 'Rename cluster Someone else',
    })
    expect(renameInput(renamedForm)).toHaveValue('My draft')
    expect(renameInput(renamedForm)).toHaveFocus()
  })

  it('a refetch where the cluster is gone closes the form and moves focus to Cluster name', async () => {
    setup()
    await clusterBoard()
    await subscribed()
    const form = await openRename('Process')
    typeInto(renameInput(form), 'My draft')
    typeInto(newInput(), 'New draft')
    fireEvent.focus(renameInput(form))

    boardMock.fetchCycleBoard.mockResolvedValue(boardOf('cluster', [TOOLS]))
    emitEvent()

    await waitFor(() => {
      expect(screen.queryByRole('form', { name: /^Rename cluster/ })).toBeNull()
    })
    await waitFor(() => {
      expect(newInput()).toHaveFocus()
    })
    // Another member's edit never overwrites the new-cluster draft.
    expect(newInput()).toHaveValue('New draft')
    expect(boardMock.renameCluster).not.toHaveBeenCalled()
  })
})

describe('deleting a cluster', () => {
  async function openDelete(name: string): Promise<HTMLElement> {
    fireEvent.click(
      screen.getByRole('button', { name: `Delete cluster ${name}` }),
    )
    const group = screen.getByRole('group', { name: `Delete cluster ${name}` })
    await waitFor(() => {
      expect(
        within(group).getByRole('button', { name: 'Cancel' }),
      ).toHaveFocus()
    })
    return group
  }

  it.each([
    [
      PROCESS,
      'Delete the cluster "Process"? Its 2 cards go back to Ungrouped.',
    ],
    [TOOLS, 'Delete the cluster "Tools"? It has no cards.'],
    [
      { ...PROCESS, cardIds: [CARDS[3].cardId] },
      'Delete the cluster "Process"? Its 1 card goes back to Ungrouped.',
    ],
  ])(
    'the confirmation for %o reads "%s", with focus on Cancel',
    async (cluster, copy) => {
      setup({
        board: boardOf(
          'cluster',
          cluster.clusterId === TOOLS.clusterId
            ? [PROCESS, cluster]
            : [cluster, TOOLS],
        ),
      })
      await clusterBoard()
      const group = await openDelete(cluster.name)

      expect(within(group).getByText(copy)).toBeInTheDocument()
      expect(
        within(group).getByRole('button', { name: 'Delete cluster' }),
      ).toBeEnabled()
    },
  )

  it.each(['Escape', 'Cancel'])(
    '%s closes it with no request and returns focus to Delete',
    async (how) => {
      setup()
      await clusterBoard()
      const group = await openDelete('Process')

      if (how === 'Escape') {
        fireEvent.keyDown(
          within(group).getByRole('button', { name: 'Cancel' }),
          {
            key: 'Escape',
          },
        )
      } else {
        fireEvent.click(within(group).getByRole('button', { name: 'Cancel' }))
      }

      const trigger = await screen.findByRole('button', {
        name: 'Delete cluster Process',
      })
      await waitFor(() => {
        expect(trigger).toHaveFocus()
      })
      expect(boardMock.deleteCluster).not.toHaveBeenCalled()
    },
  )

  it.each(['the call resolves first', 'the refetch lands first'])(
    'confirming calls deleteCluster once, moves focus to Cluster name, and announces, when %s',
    async (order) => {
      setup()
      await clusterBoard()
      await subscribed()
      const pending = deferred<undefined>()
      boardMock.deleteCluster.mockReturnValue(pending.promise)
      const group = await openDelete('Process')
      const confirm = within(group).getByRole('button', {
        name: 'Delete cluster',
      })

      fireEvent.click(confirm)
      fireEvent.click(confirm)
      await waitFor(() => {
        expect(
          within(group).getByRole('button', { name: 'Deleting…' }),
        ).toBeDisabled()
      })
      expect(boardMock.deleteCluster).toHaveBeenCalledTimes(1)
      expect(boardMock.deleteCluster).toHaveBeenCalledWith(PROCESS.clusterId)

      if (order === 'the refetch lands first') {
        boardMock.fetchCycleBoard.mockResolvedValue(boardOf('cluster', [TOOLS]))
        emitEvent()
        await waitFor(() => {
          expect(
            screen.queryByRole('group', { name: /^Delete cluster/ }),
          ).toBeNull()
        })
        await act(async () => {
          pending.resolve(undefined)
          await pending.promise
        })
      } else {
        const refetch = deferred<CycleBoard>()
        boardMock.fetchCycleBoard.mockReturnValue(refetch.promise)
        await act(async () => {
          pending.resolve(undefined)
          await pending.promise
        })
        await waitFor(() => {
          expect(newInput()).toHaveFocus()
        })
        await act(async () => {
          refetch.resolve(boardOf('cluster', [TOOLS]))
          await refetch.promise
        })
      }

      await waitFor(() => {
        expect(
          screen.queryByRole('heading', { level: 3, name: 'Process (2)' }),
        ).toBeNull()
      })
      await waitFor(() => {
        expect(newInput()).toHaveFocus()
      })
      expect(statusText()).toBe('Deleted cluster Process.')
      expect(
        screen.getByRole('heading', { level: 3, name: 'Ungrouped (5)' }),
      ).toBeInTheDocument()
    },
  )

  it.each<[ClusterErrorCode, string]>([
    ['unknown', 'Could not delete the cluster.'],
    ['cluster_not_found', 'This cluster no longer exists.'],
  ])(
    'a delete failing with %s shows "%s" and re-enables the confirmation',
    async (code, message) => {
      setup()
      await clusterBoard()
      boardMock.deleteCluster.mockRejectedValue(new ClustersApiError(code))
      const group = await openDelete('Process')
      fireEvent.click(
        within(group).getByRole('button', { name: 'Delete cluster' }),
      )

      expect(await screen.findByText(message)).toBeVisible()
      await waitFor(() => {
        expect(
          within(group).getByRole('button', { name: 'Delete cluster' }),
        ).toBeEnabled()
      })
    },
  )

  it('a delete failing with not_project_member switches to the not-found state', async () => {
    setup()
    await clusterBoard()
    boardMock.deleteCluster.mockRejectedValue(
      new ClustersApiError('not_project_member'),
    )
    const group = await openDelete('Process')
    fireEvent.click(
      within(group).getByRole('button', { name: 'Delete cluster' }),
    )

    expect(await screen.findByText(NOT_FOUND)).toBeInTheDocument()
  })
})

describe('stage changes and live updates', () => {
  it('a stage change to vote while a rename form is open removes every cluster form and control and renders Vote', async () => {
    setup()
    await clusterBoard()
    await subscribed()
    fireEvent.click(
      screen.getByRole('button', { name: 'Rename cluster Process' }),
    )
    typeInto(
      within(
        screen.getByRole('form', { name: 'Rename cluster Process' }),
      ).getByRole('textbox'),
      'Draft',
    )

    boardMock.fetchCycleBoard.mockResolvedValue(boardOf('vote'))
    emitEvent()

    expect(
      await screen.findByRole('heading', { level: 2, name: 'Vote' }),
    ).toBeInTheDocument()
    expect(screen.queryByTestId('cluster-board')).toBeNull()
    expect(screen.queryByRole('form')).toBeNull()
    expect(
      screen.queryByRole('button', { name: /Rename|Delete|Add cluster/ }),
    ).toBeNull()
    expect(screen.queryByDisplayValue('Draft')).toBeNull()
  })

  it('a create that loses the race to the stage change shows its toast', async () => {
    setup()
    await clusterBoard()
    await subscribed()
    const pending = deferred<SavedCluster>()
    boardMock.createCluster.mockReturnValue(pending.promise)
    typeInto(newInput(), 'Late')
    fireEvent.click(addButton())

    boardMock.fetchCycleBoard.mockResolvedValue(boardOf('vote'))
    emitEvent()
    expect(
      await screen.findByRole('heading', { level: 2, name: 'Vote' }),
    ).toBeInTheDocument()

    await act(async () => {
      pending.reject(new ClustersApiError('cycle_not_clustering'))
      await pending.promise.catch(() => undefined)
    })
    expect(
      await screen.findByText(
        'Clusters can only be changed during the Cluster stage.',
      ),
    ).toBeVisible()
  })

  it('a clusters_changed event refetches the board and renders the new clusters without polling while live', async () => {
    setup({ board: boardOf('cluster', []) })
    await clusterBoard()
    await subscribed()
    act(() => {
      cyclesMock.emitCycleEventsStatus(CYCLE_ID, 'SUBSCRIBED')
    })
    const invalidate = vi.spyOn(queryClient, 'invalidateQueries')

    boardMock.fetchCycleBoard.mockResolvedValue(boardOf('cluster', [PROCESS]))
    emitEvent()

    expect(
      await screen.findByRole('heading', { level: 3, name: 'Process (2)' }),
    ).toBeInTheDocument()
    expect(
      invalidate.mock.calls.map(([filters]) => filters?.queryKey),
    ).toContainEqual(['cycle-board', 'user-1', CYCLE_ID])
    expect(screen.queryByText(LIVE_NOTICE)).toBeNull()

    vi.useFakeTimers({
      toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'],
    })
    const before = boardMock.fetchCycleBoard.mock.calls.length
    await act(async () => {
      await vi.advanceTimersByTimeAsync(12_000)
    })
    expect(boardMock.fetchCycleBoard.mock.calls.length).toBe(before)
  })
})

describe('"Start voting" confirmation', () => {
  it.each<[string, readonly BoardCluster[], string]>([
    [
      'two clusters and three ungrouped cards',
      [PROCESS, TOOLS],
      'There are 2 clusters and 3 ungrouped cards. Ungrouped cards cannot receive votes.',
    ],
    [
      'one cluster and one ungrouped card',
      [{ ...PROCESS, cardIds: CARDS.slice(1).map((card) => card.cardId) }],
      'There is 1 cluster and 1 ungrouped card. Ungrouped cards cannot receive votes.',
    ],
    [
      'no clusters',
      [],
      'There are no clusters yet, so there is nothing to vote on.',
    ],
  ])(
    'with %s shows the counts before its own copy',
    async (_label, clusters, note) => {
      setup({ board: boardOf('cluster', clusters), members: asFacilitator })
      fireEvent.click(
        await screen.findByRole('button', { name: 'Start voting' }),
      )

      const group = screen.getByRole('group', { name: 'Start voting' })
      const paragraphs = Array.from(group.querySelectorAll('p')).map(
        (p) => p.textContent,
      )
      expect(paragraphs).toEqual([
        note,
        'Move everyone to the Vote stage? Clusters cannot be changed once voting starts, and you cannot go back to Cluster.',
      ])
      // It does not block the advance.
      expect(
        within(group).getByRole('button', { name: 'Start voting' }),
      ).toBeEnabled()
    },
  )
})

// ---------------------------------------------------------------------------
// #19b: only the facilitator edits clusters.
// ---------------------------------------------------------------------------

const FACILITATOR_ONLY = 'Only the facilitator can change clusters.'

/** Lets the members query resolve and the board render its answer. */
async function membersSettled(): Promise<void> {
  await waitFor(() => {
    expect(membersMock.fetchProjectMembers).toHaveBeenCalled()
  })
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 20))
  })
}

/** Re-reads the members the way the board does on window focus. */
function refocusWindow() {
  act(() => {
    window.dispatchEvent(new Event('focus'))
  })
}

function modeHeading(): HTMLElement {
  return screen.getByRole('heading', { level: 2, name: 'Cluster' })
}

/** A minimal DataTransfer: jsdom has none. */
function cardTransfer(cardId: string) {
  const data = new Map([[CARD_DRAG_TYPE, cardId]])
  return {
    get types() {
      return [...data.keys()]
    },
    files: [],
    dropEffect: 'none',
    effectAllowed: 'all',
    setData: vi.fn(),
    getData: (type: string) => data.get(type) ?? '',
  }
}

function fireDrag(
  kind: 'dragOver' | 'drop',
  element: Element,
  transfer: ReturnType<typeof cardTransfer>,
) {
  fireEvent(element, createEvent[kind](element, { dataTransfer: transfer }))
}

/** Every control a read-only viewer must not get, by role and name. */
function expectNoClusterControls() {
  const board = screen.getByTestId('cluster-board')
  expect(screen.queryByRole('form', { name: 'New cluster' })).toBeNull()
  expect(within(board).queryAllByRole('textbox')).toEqual([])
  expect(within(board).queryAllByRole('button')).toEqual([])
  expect(
    screen.queryByRole('button', {
      name: /^(Rename|Delete|Merge|Split) cluster |^Move card: /,
    }),
  ).toBeNull()
  expect(screen.queryByRole('checkbox')).toBeNull()
  expect(screen.queryByRole('menu')).toBeNull()
  expect(document.querySelector('[draggable]')).toBeNull()
  // Not only by role: an open Move menu would hide the rest from role queries.
  expect(
    board.querySelectorAll('button, input, select, textarea'),
  ).toHaveLength(0)
  expect(
    document.querySelector('[data-move-menu], [data-move-card]'),
  ).toBeNull()
  expect(board.querySelector('[data-drop-target]')).toBeNull()
  expect(board.innerHTML).not.toMatch(/cursor-grab|data-drop-line/)
}

function boardTexts() {
  const board = screen.getByTestId('cluster-board')
  return {
    headings: within(board)
      .getAllByRole('heading', { level: 3 })
      .map((heading) => heading.textContent),
    lists: within(board)
      .getAllByRole('list')
      .map((list) => [list.getAttribute('aria-label'), ...texts(list)]),
  }
}

describe('facilitator-only cluster editing (#19b)', () => {
  it('the facilitator gets every control of #17 to #19 and the facilitator intro', async () => {
    setup({ pointer: 'fine' })
    await clusterBoard()

    expect(screen.getByText(INTRO)).toBeInTheDocument()
    expect(screen.queryByText(READ_ONLY_INTRO)).toBeNull()
    expect(newInput()).toBeInTheDocument()
    for (const name of ['Process', 'Tools']) {
      expect(
        screen.getByRole('button', { name: `Rename cluster ${name}` }),
      ).toBeInTheDocument()
      expect(
        screen.getByRole('button', { name: `Delete cluster ${name}` }),
      ).toBeInTheDocument()
      expect(
        screen.getByRole('button', { name: `Merge cluster ${name}` }),
      ).toBeInTheDocument()
    }
    expect(
      screen.getByRole('button', { name: 'Split cluster Process' }),
    ).toBeInTheDocument()
    expect(
      screen.getAllByRole('button', { name: /^Move card: / }),
    ).toHaveLength(CARDS.length)
    expect(document.querySelectorAll('li[draggable="true"]')).toHaveLength(
      CARDS.length,
    )
    expect(
      screen.getByRole('button', { name: 'Start voting' }),
    ).toBeInTheDocument()
    fireEvent.click(
      screen.getByRole('button', { name: 'Split cluster Process' }),
    )
    expect(screen.getAllByRole('checkbox')).toHaveLength(2)
  })

  it.each<[string, ProjectMember[]]>([
    ['an ordinary member', asMember],
    ['the owner who is not the facilitator', asOwnerOnly],
  ])(
    '%s sees the same board read-only: no control, no drag, no drop',
    async (_label, members) => {
      const facilitatorView = setup({ pointer: 'fine' })
      await clusterBoard()
      // The same board without the facilitator's AI suggestions panel (#21).
      const facilitatorTexts = boardTexts()
      const expected = {
        ...facilitatorTexts,
        headings: facilitatorTexts.headings.filter(
          (heading) => heading !== 'AI suggestions',
        ),
      }
      facilitatorView.unmount()
      queryClient.clear()
      membersMock.fetchProjectMembers.mockClear()

      setup({ members, pointer: 'fine' })
      const board = await clusterBoard()
      await membersSettled()

      expect(screen.getByText(READ_ONLY_INTRO)).toBeInTheDocument()
      expect(screen.queryByText(INTRO)).toBeNull()
      expect(boardTexts()).toEqual(expected)
      expectNoClusterControls()
      expect(screen.queryByRole('button', { name: 'Start voting' })).toBeNull()
      expect(screen.queryByText('No clusters yet. Add one above.')).toBeNull()

      const transfer = cardTransfer(CARDS[0].cardId)
      const process = section('Process (2)')
      fireDrag('dragOver', process, transfer)
      expect(process).not.toHaveClass('ring-2')
      fireDrag('drop', process, transfer)
      fireDrag('drop', section('Ungrouped (3)'), transfer)
      expect(boardMock.moveCard).not.toHaveBeenCalled()
      expect(board.textContent).not.toMatch(/facilitator|read-only/i)
    },
  )

  it('a member and the non-facilitator owner get byte-identical boards', async () => {
    const html: string[] = []
    for (const [userId, members] of [
      ['user-1', asMember],
      ['user-2', asOwnerOnly],
    ] as const) {
      const view = setup({ userId, members: [...members], pointer: 'fine' })
      await clusterBoard()
      await membersSettled()
      html.push(normalizeIds(screen.getByTestId('cluster-board').outerHTML))
      view.unmount()
      queryClient.clear()
      membersMock.fetchProjectMembers.mockClear()
    }
    expect(html[1]).toBe(html[0])
  })

  it('a board with no clusters tells a member only that there are none', async () => {
    setup({ board: boardOf('cluster', []), members: asMember })
    await clusterBoard()
    await membersSettled()
    expect(screen.getByText('No clusters yet.')).toBeInTheDocument()
    expect(screen.queryByText('No clusters yet. Add one above.')).toBeNull()
  })

  it('while the members query loads, and after it fails, the board is read-only', async () => {
    const pending = deferred<ProjectMember[]>()
    setup({ pointer: 'fine' })
    membersMock.fetchProjectMembers.mockReturnValue(pending.promise)
    await screen.findByTestId('cluster-board')
    await waitFor(() => {
      expect(membersMock.fetchProjectMembers).toHaveBeenCalled()
    })
    expect(screen.getByText(READ_ONLY_INTRO)).toBeInTheDocument()
    expectNoClusterControls()

    await act(async () => {
      pending.reject(new Error('offline'))
      await new Promise((resolve) => setTimeout(resolve, 20))
    })
    expect(screen.getByText(READ_ONLY_INTRO)).toBeInTheDocument()
    expectNoClusterControls()
  })

  describe('when a re-read moves the role away', () => {
    type Opener = () => Promise<void>
    const openers: [string, Opener][] = [
      [
        'an open rename form',
        async () => {
          fireEvent.click(
            screen.getByRole('button', { name: 'Rename cluster Process' }),
          )
          const input = within(
            screen.getByRole('form', { name: 'Rename cluster Process' }),
          ).getByRole('textbox')
          typeInto(input, 'Draft name')
          await waitFor(() => {
            expect(input).toHaveFocus()
          })
        },
      ],
      [
        'a delete confirmation',
        async () => {
          fireEvent.click(
            screen.getByRole('button', { name: 'Delete cluster Process' }),
          )
          await waitFor(() => {
            expect(screen.getByRole('button', { name: 'Cancel' })).toHaveFocus()
          })
        },
      ],
      [
        'a merge form',
        async () => {
          fireEvent.click(
            screen.getByRole('button', { name: 'Merge cluster Process' }),
          )
          await waitFor(() => {
            expect(
              screen.getByRole('combobox', { name: 'Merge into' }),
            ).toHaveFocus()
          })
        },
      ],
      [
        'a split form with a selection',
        async () => {
          fireEvent.click(
            screen.getByRole('button', { name: 'Split cluster Process' }),
          )
          const [first] = screen.getAllByRole('checkbox')
          await waitFor(() => {
            expect(first).toHaveFocus()
          })
          fireEvent.click(first)
          expect(first).toBeChecked()
        },
      ],
      [
        'a New cluster draft',
        async () => {
          newInput().focus()
          typeInto(newInput(), 'Half typed')
          expect(newInput()).toHaveFocus()
        },
      ],
      [
        'an open Move menu',
        async () => {
          const move = screen.getByRole('button', {
            name: 'Move card: Start pairing',
          })
          move.focus()
          fireEvent.keyDown(move, { key: 'Enter' })
          await screen.findByRole('menu')
        },
      ],
    ]

    it.each(openers)(
      'closes %s and moves focus from the vanished control to the mode heading',
      async (_label, open) => {
        setup()
        await clusterBoard()
        await open()

        membersMock.fetchProjectMembers.mockResolvedValue(asMember)
        refocusWindow()

        // Not a role query: an open Move menu hides the rest from them.
        expect(await screen.findByText(READ_ONLY_INTRO)).toBeInTheDocument()
        expectNoClusterControls()
        expect(screen.queryByRole('group')).toBeNull()
        expect(screen.queryByRole('form')).toBeNull()
        await waitFor(() => {
          expect(modeHeading()).toHaveFocus()
        })
        expect(screen.getByText(READ_ONLY_INTRO)).toBeInTheDocument()

        // The drafts and selections are gone: getting the role back starts
        // clean, and moves no focus.
        membersMock.fetchProjectMembers.mockResolvedValue(asFacilitator)
        refocusWindow()
        await screen.findByRole('form', { name: 'New cluster' })
        expect(newInput()).toHaveValue('')
        expect(
          screen.queryByRole('form', { name: /^(Rename|Split) cluster/ }),
        ).toBeNull()
        expect(screen.queryByRole('group')).toBeNull()
        expect(screen.queryByRole('checkbox')).toBeNull()
        expect(screen.queryByRole('menu')).toBeNull()
        expect(modeHeading()).toHaveFocus()
        expect(boardMock.renameCluster).not.toHaveBeenCalled()
        expect(boardMock.createCluster).not.toHaveBeenCalled()
      },
    )

    it('ends a drag in progress: no ring, no drop target, and a drop sends nothing', async () => {
      setup({ pointer: 'fine' })
      await clusterBoard()
      const transfer = cardTransfer(CARDS[0].cardId)
      const card = document.querySelector(
        `li[data-card-id="${CARDS[0].cardId}"]`,
      )
      if (card === null) {
        throw new Error('no card')
      }
      fireEvent(card, createEvent.dragStart(card, { dataTransfer: transfer }))
      fireDrag('dragOver', section('Process (2)'), transfer)
      expect(section('Process (2)')).toHaveClass('ring-2')

      membersMock.fetchProjectMembers.mockResolvedValue(asMember)
      refocusWindow()

      expect(await screen.findByText(READ_ONLY_INTRO)).toBeInTheDocument()
      expect(section('Process (2)')).not.toHaveClass('ring-2')
      fireDrag('drop', section('Process (2)'), transfer)
      expectNoClusterControls()
      expect(boardMock.moveCard).not.toHaveBeenCalled()
    })

    it('also follows a re-read after a cycle event', async () => {
      setup()
      await clusterBoard()
      await subscribed()
      fireEvent.click(
        screen.getByRole('button', { name: 'Rename cluster Process' }),
      )
      const input = within(
        screen.getByRole('form', { name: 'Rename cluster Process' }),
      ).getByRole('textbox')
      await waitFor(() => {
        expect(input).toHaveFocus()
      })

      membersMock.fetchProjectMembers.mockResolvedValue(asOwnerOnly)
      emitEvent()

      expect(await screen.findByText(READ_ONLY_INTRO)).toBeInTheDocument()
      expectNoClusterControls()
      await waitFor(() => {
        expect(modeHeading()).toHaveFocus()
      })
    })

    it('leaves focus alone when it was outside the cluster controls', async () => {
      setup()
      await clusterBoard()
      fireEvent.click(
        screen.getByRole('button', { name: 'Rename cluster Process' }),
      )
      const back = screen.getByRole('link', { name: 'Back to project' })
      back.focus()

      membersMock.fetchProjectMembers.mockResolvedValue(asMember)
      refocusWindow()

      expect(await screen.findByText(READ_ONLY_INTRO)).toBeInTheDocument()
      expectNoClusterControls()
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 20))
      })
      expect(back).toHaveFocus()
    })
  })

  it('when the role moves to the viewer, the controls appear without a reload and focus stays', async () => {
    setup({ members: asMember })
    await clusterBoard()
    await membersSettled()
    await subscribed()
    const back = screen.getByRole('link', { name: 'Back to project' })
    back.focus()

    membersMock.fetchProjectMembers.mockResolvedValue(asFacilitator)
    emitEvent()

    await screen.findByRole('form', { name: 'New cluster' })
    expect(
      screen.getByRole('button', { name: 'Rename cluster Process' }),
    ).toBeInTheDocument()
    expect(screen.getByText(INTRO)).toBeInTheDocument()
    expect(back).toHaveFocus()
  })

  describe('a write refused with not_project_facilitator', () => {
    type Refusal = () => Promise<void>
    const refusals: [string, Refusal][] = [
      [
        'create',
        async () => {
          const call = deferred<SavedCluster>()
          boardMock.createCluster.mockReturnValue(call.promise)
          typeInto(newInput(), 'Ideas')
          fireEvent.click(addButton())
          await waitFor(() => {
            expect(boardMock.createCluster).toHaveBeenCalledTimes(1)
          })
          call.reject(new ClustersApiError('not_project_facilitator'))
        },
      ],
      [
        'rename',
        async () => {
          const call = deferred<SavedCluster>()
          boardMock.renameCluster.mockReturnValue(call.promise)
          fireEvent.click(
            screen.getByRole('button', { name: 'Rename cluster Process' }),
          )
          const form = screen.getByRole('form', {
            name: 'Rename cluster Process',
          })
          typeInto(within(form).getByRole('textbox'), 'Renamed')
          fireEvent.submit(form)
          await waitFor(() => {
            expect(boardMock.renameCluster).toHaveBeenCalledTimes(1)
          })
          call.reject(new ClustersApiError('not_project_facilitator'))
        },
      ],
      [
        'delete',
        async () => {
          const call = deferred<undefined>()
          boardMock.deleteCluster.mockReturnValue(call.promise)
          fireEvent.click(
            screen.getByRole('button', { name: 'Delete cluster Process' }),
          )
          fireEvent.click(
            screen.getByRole('button', { name: 'Delete cluster' }),
          )
          await waitFor(() => {
            expect(boardMock.deleteCluster).toHaveBeenCalledTimes(1)
          })
          call.reject(new ClustersApiError('not_project_facilitator'))
        },
      ],
      [
        'merge',
        async () => {
          const call = deferred<SavedCluster>()
          boardMock.mergeClusters.mockReturnValue(call.promise)
          fireEvent.click(
            screen.getByRole('button', { name: 'Merge cluster Process' }),
          )
          fireEvent.click(
            screen.getByRole('button', { name: 'Merge clusters' }),
          )
          await waitFor(() => {
            expect(boardMock.mergeClusters).toHaveBeenCalledTimes(1)
          })
          call.reject(new ClustersApiError('not_project_facilitator'))
        },
      ],
      [
        'split',
        async () => {
          const call = deferred<SavedCluster>()
          boardMock.splitCluster.mockReturnValue(call.promise)
          fireEvent.click(
            screen.getByRole('button', { name: 'Split cluster Process' }),
          )
          fireEvent.click(screen.getAllByRole('checkbox')[0])
          const form = screen.getByRole('form', {
            name: 'Split cluster Process',
          })
          typeInto(
            within(form).getByRole('textbox', { name: 'New cluster name' }),
            'Split off',
          )
          fireEvent.submit(form)
          await waitFor(() => {
            expect(boardMock.splitCluster).toHaveBeenCalledTimes(1)
          })
          call.reject(new ClustersApiError('not_project_facilitator'))
        },
      ],
      [
        'move',
        async () => {
          const call = deferred<undefined>()
          boardMock.moveCard.mockReturnValue(call.promise)
          const move = screen.getByRole('button', {
            name: 'Move card: Start pairing',
          })
          move.focus()
          fireEvent.keyDown(move, { key: 'Enter' })
          const menu = await screen.findByRole('menu')
          fireEvent.click(
            within(menu).getByRole('menuitem', { name: 'Move to Tools' }),
          )
          // The pending move is drawn over the board at once.
          await waitFor(() => {
            expect(
              screen.getByRole('heading', {
                level: 3,
                name: 'Tools (1) AI suggestion',
              }),
            ).toBeInTheDocument()
          })
          call.reject(new ClustersApiError('not_project_facilitator'))
        },
      ],
    ]

    it.each(refusals)(
      '%s: toasts, hides every control and Start voting at once, re-reads the members once, and follows the answer',
      async (_op, refuse) => {
        setup()
        await clusterBoard()
        const errorToast = vi.spyOn(toast, 'error')
        const reread = deferred<ProjectMember[]>()
        membersMock.fetchProjectMembers.mockClear()
        membersMock.fetchProjectMembers.mockReturnValue(reread.promise)

        await refuse()

        await waitFor(() => {
          expect(errorToast).toHaveBeenCalledWith(FACILITATOR_ONLY)
        })
        expect(errorToast).toHaveBeenCalledTimes(1)
        // Hidden at once, before the re-read answers.
        // Not a role query: an open Move menu hides the rest from them.
        expect(await screen.findByText(READ_ONLY_INTRO)).toBeInTheDocument()
        expectNoClusterControls()
        expect(
          screen.queryByRole('button', { name: 'Start voting' }),
        ).toBeNull()
        expect(screen.getByText(READ_ONLY_INTRO)).toBeInTheDocument()
        // A refused move's card is back in its server place.
        expect(
          screen.getByRole('heading', {
            level: 3,
            name: 'Tools (0) AI suggestion',
          }),
        ).toBeInTheDocument()
        expect(
          screen.getByRole('heading', { level: 3, name: 'Ungrouped (3)' }),
        ).toBeInTheDocument()
        await waitFor(() => {
          expect(membersMock.fetchProjectMembers).toHaveBeenCalledTimes(1)
        })

        // Still the facilitator after all (a stale refusal): the controls
        // come back only once the re-read says so.
        await act(async () => {
          reread.resolve(asFacilitator)
          await reread.promise
        })
        await screen.findByRole('form', { name: 'New cluster' })
        expect(
          screen.getByRole('button', { name: 'Start voting' }),
        ).toBeInTheDocument()
        expect(membersMock.fetchProjectMembers).toHaveBeenCalledTimes(1)
      },
    )

    // A real browser blurs a button to <body> when it turns disabled while
    // its request is pending; jsdom does not, so the blur is done by hand.
    type Start = () => { reject: (error: unknown) => void }
    const keyboardStarts: [string, Start][] = [
      [
        'Delete cluster',
        () => {
          const call = deferred<undefined>()
          boardMock.deleteCluster.mockReturnValue(call.promise)
          fireEvent.click(
            screen.getByRole('button', { name: 'Delete cluster Process' }),
          )
          const confirm = screen.getByRole('button', { name: 'Delete cluster' })
          confirm.focus()
          fireEvent.click(confirm)
          return call
        },
      ],
      [
        'Merge clusters',
        () => {
          const call = deferred<SavedCluster>()
          boardMock.mergeClusters.mockReturnValue(call.promise)
          fireEvent.click(
            screen.getByRole('button', { name: 'Merge cluster Process' }),
          )
          const confirm = screen.getByRole('button', { name: 'Merge clusters' })
          confirm.focus()
          fireEvent.click(confirm)
          return call
        },
      ],
      [
        'Add cluster',
        () => {
          const call = deferred<SavedCluster>()
          boardMock.createCluster.mockReturnValue(call.promise)
          typeInto(newInput(), 'Ideas')
          addButton().focus()
          fireEvent.click(addButton())
          return call
        },
      ],
    ]

    it.each(keyboardStarts)(
      '%s refused after its button blurred to <body>: focus goes to the mode heading',
      async (_label, start) => {
        setup()
        await clusterBoard()
        // The re-read the refusal starts confirms the role is gone.
        membersMock.fetchProjectMembers.mockResolvedValue(asMember)
        const call = start()
        await act(async () => {
          await new Promise((resolve) => setTimeout(resolve, 0))
        })
        act(() => {
          // jsdom ignores blur() on a disabled button; lift it for the blur.
          const active = document.activeElement
          if (active instanceof HTMLButtonElement && active.disabled) {
            active.disabled = false
            active.blur()
            active.disabled = true
          } else if (active instanceof HTMLElement) {
            active.blur()
          }
        })
        expect(document.activeElement).toBe(document.body)

        await act(async () => {
          call.reject(new ClustersApiError('not_project_facilitator'))
          await new Promise((resolve) => setTimeout(resolve, 0))
        })

        expect(await screen.findByText(FACILITATOR_ONLY)).toBeVisible()
        expectNoClusterControls()
        await waitFor(() => {
          expect(modeHeading()).toHaveFocus()
        })
      },
    )

    it.each(keyboardStarts)(
      '%s refused after the user focused another element: focus stays there (#94)',
      async (_label, start) => {
        setup()
        await clusterBoard()
        membersMock.fetchProjectMembers.mockResolvedValue(asMember)
        const call = start()
        const back = screen.getByRole('link', { name: 'Back to project' })
        back.focus()

        await act(async () => {
          call.reject(new ClustersApiError('not_project_facilitator'))
          await new Promise((resolve) => setTimeout(resolve, 0))
        })

        expect(await screen.findByText(FACILITATOR_ONLY)).toBeVisible()
        expectNoClusterControls()
        await act(async () => {
          await new Promise((resolve) => setTimeout(resolve, 20))
        })
        expect(back).toHaveFocus()
      },
    )

    it('keeps the controls hidden when the re-read says the viewer is a member', async () => {
      setup()
      await clusterBoard()
      const reread = deferred<ProjectMember[]>()
      membersMock.fetchProjectMembers.mockClear()
      membersMock.fetchProjectMembers.mockReturnValue(reread.promise)
      boardMock.renameCluster.mockRejectedValue(
        new ClustersApiError('not_project_facilitator'),
      )
      fireEvent.click(
        screen.getByRole('button', { name: 'Rename cluster Process' }),
      )
      const form = screen.getByRole('form', { name: 'Rename cluster Process' })
      const input = within(form).getByRole('textbox')
      typeInto(input, 'Renamed')
      input.focus()
      fireEvent.submit(form)

      expect(await screen.findByText(FACILITATOR_ONLY)).toBeVisible()
      await waitFor(() => {
        expect(modeHeading()).toHaveFocus()
      })
      await act(async () => {
        reread.resolve(asMember)
        await reread.promise
        await new Promise((resolve) => setTimeout(resolve, 20))
      })
      expectNoClusterControls()
      expect(screen.getByText(READ_ONLY_INTRO)).toBeInTheDocument()
    })

    it('not_project_member from a write still shows the not-found state', async () => {
      setup()
      await clusterBoard()
      boardMock.deleteCluster.mockRejectedValue(
        new ClustersApiError('not_project_member'),
      )
      fireEvent.click(
        screen.getByRole('button', { name: 'Delete cluster Tools' }),
      )
      fireEvent.click(screen.getByRole('button', { name: 'Delete cluster' }))
      expect(await screen.findByText(NOT_FOUND)).toBeInTheDocument()
    })
  })
})
