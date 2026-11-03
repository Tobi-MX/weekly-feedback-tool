import {
  act,
  createEvent,
  fireEvent,
  screen,
  waitFor,
  within,
} from '@testing-library/react'
import { toast } from 'sonner'
import { describe, expect, it, vi } from 'vitest'
import type { CycleDetail } from '../cycles/cyclesApi'
import type { CycleStatus } from '../cycles/cycleStatus'
import { queryClient } from '../lib/queryClient'
import type { ProjectMember } from '../projects/membersApi'
import { aiClusteringMock } from '../test/aiClusteringMock'
import { deferred, mockRestoredSession } from '../test/authMock'
import { boardMock, NO_VOTES } from '../test/boardMock'
import { cyclesMock } from '../test/cyclesMock'
import { membersMock } from '../test/membersMock'
import { profileMock } from '../test/profileMock'
import { renderApp } from '../test/renderApp'
import type { AiClusteringResult } from './aiClusteringApi'
import {
  AI_CLUSTERING_ERRORS,
  AiClusteringError,
  KeepAiClustersError,
  type AiClusteringErrorCode,
  type KeepErrorCode,
} from './aiClusteringErrors'
import type { BoardCard, BoardCluster, CycleBoard } from './boardApi'
import { CARD_DRAG_TYPE } from './cardMove'
import { ClustersApiError } from './clusterErrors'

const CYCLE_ID = '30000000-0000-4000-8000-000000000001'
const PROJECT_ID = '10000000-0000-4000-8000-000000000001'
const PATH = `/cycles/${CYCLE_ID}/board`
const NOT_FOUND = 'Cycle not found or you do not have access.'
const PANEL_TEXT =
  'Ask AI to group the cards that are not in clusters you made or changed. Suggestions are marked "AI suggestion" and you can change them like any cluster.'
const PROGRESS =
  'This can take up to 2 minutes. Cluster changes are paused until the suggestions arrive.'
const FACILITATOR_ONLY = 'Only the facilitator can change clusters.'
const READ_ONLY_INTRO =
  'The facilitator is grouping the cards into clusters. Changes appear here as they are made, until voting starts.'
const REMOTE = 'New AI suggestions are on the board.'

const cycle: CycleDetail = {
  id: CYCLE_ID,
  projectId: PROJECT_ID,
  title: 'Sprint twelve retro',
  weekStart: '2026-10-26',
  status: 'cluster',
}

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
    authorDisplayName: 'Linus',
  },
]

/** A manual cluster: its cards are never available to a run. */
const PROCESS: BoardCluster = {
  clusterId: 'd1000000-0000-4000-8000-000000000001',
  name: 'Process',
  source: 'manual',
  cardIds: [CARDS[3].cardId, CARDS[4].cardId],
}

const TOOLS: BoardCluster = {
  clusterId: 'a1000000-0000-4000-8000-000000000002',
  name: 'Tools',
  source: 'ai',
  cardIds: [CARDS[0].cardId],
}

const DOCS: BoardCluster = {
  clusterId: 'b1000000-0000-4000-8000-000000000003',
  name: 'Docs',
  source: 'ai',
  cardIds: [CARDS[1].cardId],
}

function boardOf(
  clusters: readonly BoardCluster[] = [PROCESS],
  status: CycleStatus = 'cluster',
  cards: readonly BoardCard[] = CARDS,
): CycleBoard {
  return {
    cycleId: CYCLE_ID,
    status,
    isRevealed: true,
    cards,
    clusters,
    ...NO_VOTES,
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
  readonly members?: ProjectMember[] | 'loading' | 'failed'
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
  mockRestoredSession('dev@example.com', 'user-1')
  profileMock.fetchProfileDisplayName.mockResolvedValue('Dev User')
  cyclesMock.fetchCycle.mockResolvedValue(cycle)
  boardMock.fetchCycleBoard.mockResolvedValue(options.board ?? boardOf())
  const members = options.members ?? asFacilitator
  if (members === 'loading') {
    membersMock.fetchProjectMembers.mockReturnValue(
      new Promise(() => undefined),
    )
  } else if (members === 'failed') {
    membersMock.fetchProjectMembers.mockRejectedValue(new Error('failed'))
  } else {
    membersMock.fetchProjectMembers.mockResolvedValue(members)
  }
  return renderApp({ initialEntries: [PATH] })
}

function success(
  clusterCount: number,
  ungroupedCardCount: number,
): AiClusteringResult {
  return {
    runId: '60000000-0000-4000-8000-000000000001',
    clusterCount,
    clusteredCardCount: 3 - ungroupedCardCount,
    ungroupedCardCount,
  }
}

async function facilitatorPanel(): Promise<HTMLElement> {
  // A cheap selector first: role queries over a 301-card board are slow.
  await waitFor(
    () => {
      expect(document.querySelector('[data-ai-panel]')).not.toBeNull()
    },
    { timeout: 4000 },
  )
  expect(screen.getByRole('form', { name: 'New cluster' })).toBeInTheDocument()
  return panel()
}

function panel(): HTMLElement {
  return screen.getByRole('region', { name: 'AI suggestions' })
}

function queryPanel(): HTMLElement | null {
  return screen.queryByRole('region', { name: 'AI suggestions' })
}

function statusText(): string {
  return within(screen.getByTestId('cluster-board')).getByRole('status')
    .textContent
}

function mainButton(): HTMLElement {
  const button = panel().querySelector<HTMLElement>('[data-ai-focus="main"]')
  if (button === null) {
    throw new Error('no main button')
  }
  return button
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

async function membersSettled(): Promise<void> {
  await waitFor(() => {
    expect(membersMock.fetchProjectMembers).toHaveBeenCalled()
  })
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 20))
  })
}

/** Lets pending promises and the re-renders they cause run. */
async function settle(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 20))
  })
}

/** A browser blurs a control to <body> when it disappears or is disabled. */
function blurToBody() {
  const active = document.activeElement
  if (active instanceof HTMLElement) {
    active.blur()
  }
  if (document.activeElement !== document.body) {
    // jsdom ignores blur() on a disabled control: take focus with a
    // throwaway element and remove it, which drops focus to <body>.
    const sink = document.createElement('input')
    document.body.append(sink)
    sink.focus()
    sink.remove()
  }
  expect(document.activeElement).toBe(document.body)
}

/** Opens the Suggest or Regenerate confirmation and confirms it. */
async function confirmRun(): Promise<void> {
  fireEvent.click(mainButton())
  const group = await screen.findByRole('group', {
    name: /^(Suggest clusters|Regenerate suggestions)$/,
  })
  fireEvent.click(
    within(group).getByRole('button', {
      name: /^(Suggest clusters|Regenerate suggestions)$/,
    }),
  )
}

/** Starts a run that stays pending until the returned deferred settles. */
async function pendingRun() {
  const call = deferred<AiClusteringResult>()
  aiClusteringMock.requestAiClusters.mockReturnValue(call.promise)
  await confirmRun()
  await waitFor(() => {
    expect(mainButton()).toHaveTextContent('Generating suggestions…')
  })
  return call
}

function dataTransfer(initial: Record<string, string> = {}) {
  const data = new Map(Object.entries(initial))
  return {
    get types() {
      return [...data.keys()]
    },
    files: [],
    dropEffect: 'none',
    effectAllowed: 'all',
    setData: (type: string, value: string) => {
      data.set(type, value)
    },
    getData: (type: string) => data.get(type) ?? '',
  }
}

function clusterSection(name: string): HTMLElement {
  const heading = screen.getByRole('heading', {
    level: 3,
    name: new RegExp(`^${name} \\(`),
  })
  const section = heading.closest('section')
  if (section === null) {
    throw new Error(`no section for ${name}`)
  }
  return section
}

const INLINE_CODES = (
  Object.keys(AI_CLUSTERING_ERRORS) as AiClusteringErrorCode[]
).filter((code) => AI_CLUSTERING_ERRORS[code].shownAs === 'inline')

describe('the AI suggestions panel', () => {
  it('shows the facilitator Suggest clusters with no AI clusters, and Regenerate and Keep with some', async () => {
    const view = setup()
    const box = await facilitatorPanel()
    expect(
      within(box).getByRole('heading', { level: 3, name: 'AI suggestions' }),
    ).toBeInTheDocument()
    expect(within(box).getByText(PANEL_TEXT)).toBeInTheDocument()
    expect(
      within(box)
        .getAllByRole('button')
        .map((button) => button.textContent),
    ).toEqual(['Suggest clusters'])
    view.unmount()
    queryClient.clear()

    setup({ board: boardOf([PROCESS, TOOLS, DOCS]) })
    const withAi = await facilitatorPanel()
    expect(
      within(withAi)
        .getAllByRole('button')
        .map((button) => button.textContent),
    ).toEqual(['Regenerate suggestions', 'Keep suggestions'])
    // Between the mode intro and the New cluster form.
    const form = screen.getByRole('form', { name: 'New cluster' })
    expect(
      withAi.compareDocumentPosition(form) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy()
  })

  it.each<[string, ProjectMember[]]>([
    ['an ordinary member', asMember],
    ['the owner who is not the facilitator', asOwnerOnly],
  ])(
    '%s gets no panel, and sees the badge, names, and cards as the facilitator does',
    async (_label, members) => {
      const board = boardOf([PROCESS, TOOLS, DOCS])
      const facilitatorView = setup({ board })
      await facilitatorPanel()
      const clusterTexts = () =>
        Array.from(
          screen
            .getByTestId('cluster-board')
            .querySelectorAll('section[data-drop-target], section'),
        )
          .filter((section) => section.querySelector('[data-cluster-name]'))
          .map((section) => [
            section.querySelector('h3')?.textContent,
            ...Array.from(section.querySelectorAll('li')).map(
              (item) => item.querySelector('p')?.textContent,
            ),
          ])
      const expected = clusterTexts()
      facilitatorView.unmount()
      queryClient.clear()

      setup({ board, members })
      await screen.findByTestId('cluster-board')
      await membersSettled()
      expect(screen.getByText(READ_ONLY_INTRO)).toBeInTheDocument()
      expect(queryPanel()).toBeNull()
      expect(screen.queryByText('AI suggestions')).toBeNull()
      expect(screen.queryByText(PANEL_TEXT)).toBeNull()
      expect(
        screen.queryByRole('button', {
          name: /Suggest clusters|Regenerate suggestions|Keep suggestions/,
        }),
      ).toBeNull()
      expect(
        screen.getByRole('heading', {
          level: 3,
          name: 'Tools (1) AI suggestion',
        }),
      ).toBeInTheDocument()
      expect(
        screen.getByRole('heading', {
          level: 3,
          name: 'Docs (1) AI suggestion',
        }),
      ).toBeInTheDocument()
      expect(
        screen.getByRole('heading', { level: 3, name: 'Process (2)' }),
      ).toBeInTheDocument()
      expect(clusterTexts()).toEqual(expected)
    },
  )

  it('shows no panel while the members query loads or after it failed', async () => {
    const view = setup({ members: 'loading' })
    await screen.findByTestId('cluster-board')
    await settle()
    expect(queryPanel()).toBeNull()
    view.unmount()
    queryClient.clear()

    queryClient.clear()
    setup({ members: 'failed' })
    await screen.findByTestId('cluster-board')
    await membersSettled()
    expect(queryPanel()).toBeNull()
  })

  const manyCards: BoardCard[] = Array.from({ length: 301 }, (_, index) => ({
    cardId: `f0000000-0000-4000-8000-${String(index).padStart(12, '0')}`,
    category: 'start',
    text: `Card ${index}`,
    isAnonymous: true,
  }))
  const fiftyManual: BoardCluster[] = Array.from(
    { length: 50 },
    (_, index) => ({
      clusterId: `d2000000-0000-4000-8000-${String(index).padStart(12, '0')}`,
      name: `Manual ${index}`,
      source: 'manual',
      cardIds: [],
    }),
  )

  it.each<[string, CycleBoard, string]>([
    ['no cards', boardOf([], 'cluster', []), 'There are no cards to group.'],
    [
      '1 available card',
      boardOf([PROCESS], 'cluster', CARDS.slice(2)),
      'AI suggestions need at least 2 cards that are not in clusters you made or changed.',
    ],
    [
      '301 available cards',
      boardOf([], 'cluster', manyCards),
      'AI suggestions work with up to 300 cards that are not in clusters you made or changed. This board has 301.',
    ],
    [
      '50 manual clusters',
      boardOf(fiftyManual),
      'This cycle already has 50 clusters, so there is no room for suggestions.',
    ],
  ])(
    'shows its sentence and no trigger with %s',
    async (_label, board, text) => {
      setup({ board })
      const box = await facilitatorPanel()
      expect(within(box).getByText(text)).toBeInTheDocument()
      expect(within(box).queryAllByRole('button')).toEqual([])
    },
  )

  it('keeps Keep suggestions in a no-trigger row when AI clusters exist', async () => {
    setup({ board: boardOf([...fiftyManual, TOOLS]) })
    const box = await facilitatorPanel()
    expect(
      within(box).getByText(
        'This cycle already has 50 clusters, so there is no room for suggestions.',
      ),
    ).toBeInTheDocument()
    expect(
      within(box)
        .getAllByRole('button')
        .map((button) => button.textContent),
    ).toEqual(['Keep suggestions'])
  })
})

describe('confirmations', () => {
  it('Suggest opens its inline confirmation with the counts, focuses Cancel, and Escape returns focus', async () => {
    setup()
    await facilitatorPanel()
    const opener = mainButton()
    fireEvent.click(opener)
    const group = await screen.findByRole('group', { name: 'Suggest clusters' })
    expect(
      within(group).getByText(
        'Suggest clusters for the 3 cards that are not in clusters you made or changed? The suggestions appear as clusters marked "AI suggestion". Your clusters and their cards stay as they are.',
      ),
    ).toBeInTheDocument()
    expect(screen.queryByRole('dialog')).toBeNull()
    await waitFor(() => {
      expect(
        within(group).getByRole('button', { name: 'Cancel' }),
      ).toHaveFocus()
    })
    fireEvent.keyDown(within(group).getByRole('button', { name: 'Cancel' }), {
      key: 'Escape',
    })
    await waitFor(() => {
      expect(
        screen.queryByRole('group', { name: 'Suggest clusters' }),
      ).toBeNull()
    })
    await waitFor(() => {
      expect(mainButton()).toHaveFocus()
    })
    expect(aiClusteringMock.requestAiClusters).not.toHaveBeenCalled()
  })

  it('Regenerate shows the AI cluster count and the Ungrouped sentence; Cancel returns focus', async () => {
    setup({ board: boardOf([PROCESS, TOOLS, DOCS]) })
    await facilitatorPanel()
    fireEvent.click(mainButton())
    const group = await screen.findByRole('group', {
      name: 'Regenerate suggestions',
    })
    expect(
      within(group).getByText(
        'Regenerate suggestions? The 2 clusters marked "AI suggestion" will be replaced, and the 3 cards that are not in clusters you made or changed will be grouped again. Cards in Ungrouped may be grouped again, including cards you moved there. Your clusters and their cards stay as they are. To keep the current suggestions, choose Keep suggestions first.',
      ),
    ).toBeInTheDocument()
    fireEvent.click(within(group).getByRole('button', { name: 'Cancel' }))
    await waitFor(() => {
      expect(mainButton()).toHaveFocus()
    })
  })

  it('Keep opens its confirmation with the count; Escape returns focus to Keep', async () => {
    setup({ board: boardOf([PROCESS, TOOLS, DOCS]) })
    const box = await facilitatorPanel()
    fireEvent.click(
      within(box).getByRole('button', { name: 'Keep suggestions' }),
    )
    const group = await screen.findByRole('group', { name: 'Keep suggestions' })
    expect(
      within(group).getByText(
        'Keep the 2 suggested clusters? They become ordinary clusters: the "AI suggestion" label goes away and regenerating will no longer replace them.',
      ),
    ).toBeInTheDocument()
    await waitFor(() => {
      expect(
        within(group).getByRole('button', { name: 'Cancel' }),
      ).toHaveFocus()
    })
    fireEvent.keyDown(within(group).getByRole('button', { name: 'Cancel' }), {
      key: 'Escape',
    })
    await waitFor(() => {
      expect(
        within(panel()).getByRole('button', { name: 'Keep suggestions' }),
      ).toHaveFocus()
    })
  })

  it('shares the one open form with rename, both ways', async () => {
    setup({ board: boardOf([PROCESS, TOOLS, DOCS]) })
    await facilitatorPanel()
    fireEvent.click(
      screen.getByRole('button', { name: 'Rename cluster Process' }),
    )
    expect(
      await screen.findByRole('form', { name: 'Rename cluster Process' }),
    ).toBeInTheDocument()

    fireEvent.click(mainButton())
    expect(
      await screen.findByRole('group', { name: 'Regenerate suggestions' }),
    ).toBeInTheDocument()
    expect(
      screen.queryByRole('form', { name: 'Rename cluster Process' }),
    ).toBeNull()

    fireEvent.click(
      screen.getByRole('button', { name: 'Rename cluster Tools' }),
    )
    expect(
      await screen.findByRole('form', { name: 'Rename cluster Tools' }),
    ).toBeInTheDocument()
    expect(
      screen.queryByRole('group', { name: 'Regenerate suggestions' }),
    ).toBeNull()
  })

  it('follows a refetch while open', async () => {
    setup({ board: boardOf([PROCESS, TOOLS, DOCS]) })
    await facilitatorPanel()
    await subscribed()
    fireEvent.click(mainButton())
    const group = await screen.findByRole('group', {
      name: 'Regenerate suggestions',
    })
    expect(group).toHaveTextContent('The 2 clusters marked')

    boardMock.fetchCycleBoard.mockResolvedValue(
      boardOf([{ ...PROCESS, cardIds: [CARDS[4].cardId] }, TOOLS]),
    )
    emitEvent()
    await waitFor(() => {
      expect(group).toHaveTextContent(
        'The 1 cluster marked "AI suggestion" will be replaced, and the 4 cards that are not',
      )
    })
  })
})

describe('a run', () => {
  it('sends one request, shows the progress on the focused main button, and ignores repeats', async () => {
    setup()
    await facilitatorPanel()
    const call = deferred<AiClusteringResult>()
    aiClusteringMock.requestAiClusters.mockReturnValue(call.promise)
    fireEvent.click(mainButton())
    const group = await screen.findByRole('group', { name: 'Suggest clusters' })
    const confirm = within(group).getByRole('button', {
      name: 'Suggest clusters',
    })
    fireEvent.click(confirm)
    fireEvent.click(confirm)

    expect(aiClusteringMock.requestAiClusters).toHaveBeenCalledTimes(1)
    expect(aiClusteringMock.requestAiClusters).toHaveBeenCalledWith(CYCLE_ID)
    await waitFor(() => {
      expect(mainButton()).toHaveFocus()
    })
    const main = mainButton()
    expect(main).toHaveTextContent('Generating suggestions…')
    expect(main).toHaveAttribute('aria-disabled', 'true')
    expect(main).not.toBeDisabled()
    expect(within(panel()).getByText(PROGRESS)).toBeInTheDocument()
    expect(within(panel()).getByText(PROGRESS)).not.toHaveAttribute('role')
    expect(statusText()).toBe('Generating suggestions.')

    fireEvent.click(main)
    fireEvent.keyDown(main, { key: 'Enter' })
    fireEvent.click(main)
    await settle()
    expect(screen.queryByRole('group', { name: 'Suggest clusters' })).toBeNull()
    expect(aiClusteringMock.requestAiClusters).toHaveBeenCalledTimes(1)
    expect(statusText()).toBe('Generating suggestions.')
  })

  it('pauses every cluster write while pending', async () => {
    setup({ board: boardOf([PROCESS, TOOLS, DOCS]), pointer: 'fine' })
    await facilitatorPanel()
    await pendingRun()

    // Add cluster.
    fireEvent.change(screen.getByRole('textbox', { name: 'Cluster name' }), {
      target: { value: 'Brand new' },
    })
    fireEvent.submit(screen.getByRole('form', { name: 'New cluster' }))

    // Save a rename.
    fireEvent.click(
      screen.getByRole('button', { name: 'Rename cluster Tools' }),
    )
    const rename = await screen.findByRole('form', {
      name: 'Rename cluster Tools',
    })
    fireEvent.change(within(rename).getByRole('textbox'), {
      target: { value: 'Tooling' },
    })
    fireEvent.click(within(rename).getByRole('button', { name: 'Save' }))

    // Delete cluster.
    fireEvent.click(screen.getByRole('button', { name: 'Delete cluster Docs' }))
    const del = await screen.findByRole('group', {
      name: 'Delete cluster Docs',
    })
    fireEvent.click(within(del).getByRole('button', { name: 'Delete cluster' }))

    // Merge.
    fireEvent.click(screen.getByRole('button', { name: 'Merge cluster Tools' }))
    const merge = await screen.findByRole('group', {
      name: 'Merge cluster Tools',
    })
    fireEvent.click(
      within(merge).getByRole('button', { name: 'Merge clusters' }),
    )

    // Split.
    fireEvent.click(
      screen.getByRole('button', { name: 'Split cluster Process' }),
    )
    const split = await screen.findByRole('form', {
      name: 'Split cluster Process',
    })
    fireEvent.click(screen.getAllByRole('checkbox')[0])
    fireEvent.change(within(split).getByRole('textbox'), {
      target: { value: 'Split off' },
    })
    fireEvent.submit(split)

    // A drop.
    const transfer = dataTransfer({ [CARD_DRAG_TYPE]: CARDS[2].cardId })
    const target = clusterSection('Process')
    fireEvent(target, createEvent.dragOver(target, { dataTransfer: transfer }))
    fireEvent(target, createEvent.drop(target, { dataTransfer: transfer }))

    // A Move menu item: the menus are blocked while the run is pending.
    const move = screen.getByRole('button', {
      name: 'Move card: Start writing ADRs',
    })
    move.focus()
    fireEvent.keyDown(move, { key: 'Enter' })
    const menu = screen.queryByRole('menu')
    if (menu !== null) {
      const items = within(menu).queryAllByRole('menuitem')
      if (items.length > 0) {
        fireEvent.click(items[0])
      }
    }

    await settle()
    expect(boardMock.createCluster).not.toHaveBeenCalled()
    expect(boardMock.renameCluster).not.toHaveBeenCalled()
    expect(boardMock.deleteCluster).not.toHaveBeenCalled()
    expect(boardMock.mergeClusters).not.toHaveBeenCalled()
    expect(boardMock.splitCluster).not.toHaveBeenCalled()
    expect(boardMock.moveCard).not.toHaveBeenCalled()
  })

  it('sends nothing while a move or a merge is pending', async () => {
    setup({ board: boardOf([PROCESS, TOOLS, DOCS]) })
    await facilitatorPanel()

    const move = deferred<undefined>()
    boardMock.moveCard.mockReturnValue(move.promise)
    const moveButton = screen.getByRole('button', {
      name: 'Move card: Start writing ADRs',
    })
    moveButton.focus()
    fireEvent.keyDown(moveButton, { key: 'Enter' })
    const menu = await screen.findByRole('menu')
    fireEvent.click(
      within(menu).getByRole('menuitem', { name: 'Move to Tools' }),
    )
    await waitFor(() => {
      expect(boardMock.moveCard).toHaveBeenCalledTimes(1)
    })
    await waitFor(() => {
      expect(screen.queryByRole('menu')).toBeNull()
    })

    fireEvent.click(mainButton())
    let group = await screen.findByRole('group', {
      name: 'Regenerate suggestions',
    })
    fireEvent.click(
      within(group).getByRole('button', { name: 'Regenerate suggestions' }),
    )
    fireEvent.click(within(group).getByRole('button', { name: 'Cancel' }))
    fireEvent.click(
      within(panel()).getByRole('button', { name: 'Keep suggestions' }),
    )
    group = await screen.findByRole('group', { name: 'Keep suggestions' })
    fireEvent.click(
      within(group).getByRole('button', { name: 'Keep suggestions' }),
    )
    expect(aiClusteringMock.requestAiClusters).not.toHaveBeenCalled()
    expect(aiClusteringMock.acceptAiClusters).not.toHaveBeenCalled()
    await act(async () => {
      move.resolve(undefined)
      await move.promise
    })
    await settle()

    const merge = deferred<{
      clusterId: string
      name: string
      source: 'manual'
    }>()
    boardMock.mergeClusters.mockReturnValue(merge.promise)
    fireEvent.click(screen.getByRole('button', { name: 'Merge cluster Docs' }))
    const mergeGroup = await screen.findByRole('group', {
      name: 'Merge cluster Docs',
    })
    fireEvent.click(
      within(mergeGroup).getByRole('button', { name: 'Merge clusters' }),
    )
    await waitFor(() => {
      expect(boardMock.mergeClusters).toHaveBeenCalledTimes(1)
    })
    fireEvent.click(mainButton())
    group = await screen.findByRole('group', { name: 'Regenerate suggestions' })
    fireEvent.click(
      within(group).getByRole('button', { name: 'Regenerate suggestions' }),
    )
    expect(aiClusteringMock.requestAiClusters).not.toHaveBeenCalled()
    await act(async () => {
      merge.resolve({
        clusterId: PROCESS.clusterId,
        name: 'Process',
        source: 'manual',
      })
      await merge.promise
    })
  })

  it('announces a success with 3 clusters once, after the refetch', async () => {
    setup()
    await facilitatorPanel()
    const call = await pendingRun()
    const refetch = deferred<CycleBoard | null>()
    boardMock.fetchCycleBoard.mockReturnValue(refetch.promise)

    await act(async () => {
      call.resolve(success(3, 2))
      await call.promise
    })
    await settle()
    expect(statusText()).toBe('Generating suggestions.')
    expect(mainButton()).toHaveTextContent('Generating suggestions…')

    const after = boardOf([PROCESS, TOOLS, DOCS])
    boardMock.fetchCycleBoard.mockResolvedValue(after)
    await act(async () => {
      refetch.resolve(after)
      await refetch.promise
    })
    await waitFor(() => {
      expect(statusText()).toBe(
        'Added 3 suggested clusters. 2 cards are in Ungrouped.',
      )
    })
    const region = within(screen.getByTestId('cluster-board')).getByRole(
      'status',
    )
    const span = region.firstElementChild
    expect(
      screen.getByRole('heading', {
        level: 3,
        name: 'Tools (1) AI suggestion',
      }),
    ).toBeInTheDocument()
    expect(mainButton()).toHaveTextContent('Regenerate suggestions')

    // Further refetches and re-renders do not repeat it.
    await subscribed()
    emitEvent()
    await settle()
    emitEvent()
    await settle()
    expect(region.firstElementChild).toBe(span)
    expect(statusText()).toBe(
      'Added 3 suggested clusters. 2 cards are in Ungrouped.',
    )
  })

  it('announces a success with no clusters', async () => {
    setup()
    await facilitatorPanel()
    const call = await pendingRun()
    await act(async () => {
      call.resolve(success(0, 3))
      await call.promise
    })
    await waitFor(() => {
      expect(statusText()).toBe(
        'No clusters were suggested, so the cards stay in Ungrouped.',
      )
    })
  })

  it.each(INLINE_CODES)(
    '%s shows its copy in one alert, with Try again only when retryable',
    async (code) => {
      setup()
      await facilitatorPanel()
      const call = await pendingRun()
      await act(async () => {
        call.reject(new AiClusteringError(code))
        await call.promise.catch(() => undefined)
      })
      const { copy, retry } = AI_CLUSTERING_ERRORS[code]
      const alert = await within(panel()).findByRole('alert')
      expect(within(panel()).getAllByRole('alert')).toHaveLength(1)
      expect(alert).toHaveTextContent(copy ?? '')
      expect(alert.className).toContain('[overflow-wrap:anywhere]')
      expect(alert.className).not.toContain('break-words')
      expect(statusText()).toBe('Generating suggestions.')
      const tryAgain = within(panel()).queryByRole('button', {
        name: 'Try again',
      })
      if (retry) {
        expect(tryAgain).not.toBeNull()
      } else {
        expect(tryAgain).toBeNull()
      }
    },
  )

  it('Try again resends with no confirmation, and the same error twice is inserted twice', async () => {
    setup()
    await facilitatorPanel()
    const call = await pendingRun()
    await act(async () => {
      call.reject(new AiClusteringError('ai_timeout'))
      await call.promise.catch(() => undefined)
    })
    const first = await within(panel()).findByRole('alert')

    const again = deferred<AiClusteringResult>()
    aiClusteringMock.requestAiClusters.mockReturnValue(again.promise)
    fireEvent.click(within(panel()).getByRole('button', { name: 'Try again' }))
    expect(aiClusteringMock.requestAiClusters).toHaveBeenCalledTimes(2)
    expect(screen.queryByRole('group')).toBeNull()
    await waitFor(() => {
      expect(mainButton()).toHaveTextContent('Generating suggestions…')
    })
    await waitFor(() => {
      expect(mainButton()).toHaveFocus()
    })
    expect(within(panel()).queryByRole('alert')).toBeNull()

    await act(async () => {
      again.reject(new AiClusteringError('ai_timeout'))
      await again.promise.catch(() => undefined)
    })
    const second = await within(panel()).findByRole('alert')
    expect(second).not.toBe(first)
    expect(first.isConnected).toBe(false)
    expect(second).toHaveTextContent(AI_CLUSTERING_ERRORS.ai_timeout.copy ?? '')
  })

  it('ai_run_limit_reached hides Suggest and Regenerate for the rest of the mount; Keep stays', async () => {
    setup({ board: boardOf([PROCESS, TOOLS, DOCS]) })
    await facilitatorPanel()
    const call = await pendingRun()
    await act(async () => {
      call.reject(new AiClusteringError('ai_run_limit_reached'))
      await call.promise.catch(() => undefined)
    })
    await within(panel()).findByRole('alert')
    expect(
      within(panel())
        .getAllByRole('button')
        .map((button) => button.textContent),
    ).toEqual(['Keep suggestions'])
    await subscribed()
    emitEvent()
    await settle()
    expect(
      within(panel()).queryByRole('button', { name: 'Regenerate suggestions' }),
    ).toBeNull()
  })

  it('not_project_member shows the not-found state', async () => {
    setup()
    await facilitatorPanel()
    const call = await pendingRun()
    await act(async () => {
      call.reject(new AiClusteringError('not_project_member'))
      await call.promise.catch(() => undefined)
    })
    expect(await screen.findByText(NOT_FOUND)).toBeInTheDocument()
  })

  it("not_project_facilitator shows #100's toast, hides the panel and the controls at once, and re-reads the members", async () => {
    setup()
    await facilitatorPanel()
    const errorToast = vi.spyOn(toast, 'error')
    const call = await pendingRun()
    const reread = deferred<ProjectMember[]>()
    membersMock.fetchProjectMembers.mockClear()
    membersMock.fetchProjectMembers.mockReturnValue(reread.promise)
    await act(async () => {
      call.reject(new AiClusteringError('not_project_facilitator'))
      await call.promise.catch(() => undefined)
    })
    await waitFor(() => {
      expect(errorToast).toHaveBeenCalledWith(FACILITATOR_ONLY)
    })
    expect(queryPanel()).toBeNull()
    expect(screen.queryByRole('form', { name: 'New cluster' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Start voting' })).toBeNull()
    await waitFor(() => {
      expect(membersMock.fetchProjectMembers).toHaveBeenCalledTimes(1)
    })
    await waitFor(() => {
      expect(document.activeElement?.id).toBe('board-mode-heading')
    })
  })

  it('cycle_not_clustering shows its toast', async () => {
    setup()
    await facilitatorPanel()
    const errorToast = vi.spyOn(toast, 'error')
    const call = await pendingRun()
    await act(async () => {
      call.reject(new AiClusteringError('cycle_not_clustering'))
      await call.promise.catch(() => undefined)
    })
    await waitFor(() => {
      expect(errorToast).toHaveBeenCalledWith(
        'The suggestions were not added because the cycle has left the Cluster stage.',
      )
    })
    expect(within(panel()).queryByRole('alert')).toBeNull()
  })

  it('a stage change mid-run: the result toasts, throws nothing, and moves no focus', async () => {
    setup()
    await facilitatorPanel()
    await subscribed()
    const errorToast = vi.spyOn(toast, 'error')
    const call = await pendingRun()
    boardMock.fetchCycleBoard.mockResolvedValue(boardOf([PROCESS], 'vote'))
    cyclesMock.fetchCycle.mockResolvedValue({ ...cycle, status: 'vote' })
    emitEvent()
    expect(
      await screen.findByRole('heading', { level: 2, name: 'Vote' }),
    ).toBeInTheDocument()
    expect(screen.queryByTestId('cluster-board')).toBeNull()
    const link = screen.getByRole('link', { name: 'Back to project' })
    link.focus()

    await act(async () => {
      call.reject(new AiClusteringError('cycle_not_clustering'))
      await call.promise.catch(() => undefined)
    })
    await waitFor(() => {
      expect(errorToast).toHaveBeenCalledWith(
        'The suggestions were not added because the cycle has left the Cluster stage.',
      )
    })
    expect(link).toHaveFocus()
  })

  it('a stage change mid-run then an inline error shows it as a toast', async () => {
    setup()
    await facilitatorPanel()
    await subscribed()
    const errorToast = vi.spyOn(toast, 'error')
    const call = await pendingRun()
    boardMock.fetchCycleBoard.mockResolvedValue(boardOf([PROCESS], 'vote'))
    emitEvent()
    await screen.findByRole('heading', { level: 2, name: 'Vote' })
    await act(async () => {
      call.reject(new AiClusteringError('ai_timeout'))
      await call.promise.catch(() => undefined)
    })
    await waitFor(() => {
      expect(errorToast).toHaveBeenCalledWith(
        AI_CLUSTERING_ERRORS.ai_timeout.copy,
      )
    })
  })

  it('role lost mid-run: the panel goes, focus goes to the heading, and a later refusal toasts', async () => {
    setup()
    await facilitatorPanel()
    await subscribed()
    const errorToast = vi.spyOn(toast, 'error')
    const call = await pendingRun()
    expect(mainButton()).toHaveFocus()

    membersMock.fetchProjectMembers.mockResolvedValue(asMember)
    emitEvent()
    await waitFor(() => {
      expect(queryPanel()).toBeNull()
    })
    // The removed button drops focus to <body>, as in a browser.
    await waitFor(() => {
      expect(document.activeElement?.id).toBe('board-mode-heading')
    })

    await act(async () => {
      call.reject(new AiClusteringError('not_project_facilitator'))
      await call.promise.catch(() => undefined)
    })
    await waitFor(() => {
      expect(errorToast).toHaveBeenCalledWith(FACILITATOR_ONLY)
    })
  })

  it('role lost mid-run with focus elsewhere leaves focus there', async () => {
    setup()
    await facilitatorPanel()
    await subscribed()
    await pendingRun()
    const link = screen.getByRole('link', { name: 'Back to project' })
    link.focus()
    membersMock.fetchProjectMembers.mockResolvedValue(asMember)
    emitEvent()
    await waitFor(() => {
      expect(queryPanel()).toBeNull()
    })
    await settle()
    expect(link).toHaveFocus()
  })

  it('network loss: network_error with Try again, answered with ai_run_in_progress', async () => {
    setup()
    await facilitatorPanel()
    const call = await pendingRun()
    await act(async () => {
      call.reject(new AiClusteringError('network_error'))
      await call.promise.catch(() => undefined)
    })
    expect(await within(panel()).findByRole('alert')).toHaveTextContent(
      AI_CLUSTERING_ERRORS.network_error.copy ?? '',
    )
    aiClusteringMock.requestAiClusters.mockRejectedValue(
      new AiClusteringError('ai_run_in_progress'),
    )
    fireEvent.click(within(panel()).getByRole('button', { name: 'Try again' }))
    await waitFor(() => {
      expect(within(panel()).getByRole('alert')).toHaveTextContent(
        AI_CLUSTERING_ERRORS.ai_run_in_progress.copy ?? '',
      )
    })
  })
})

describe('focus after a result (#94)', () => {
  it.each(['success', 'error'] as const)(
    'stays on a Move button the user tabbed to (%s)',
    async (outcome) => {
      setup()
      await facilitatorPanel()
      const call = await pendingRun()
      const move = screen.getByRole('button', {
        name: 'Move card: Start writing ADRs',
      })
      move.focus()
      await act(async () => {
        if (outcome === 'success') {
          call.resolve(success(1, 1))
          await call.promise
        } else {
          call.reject(new AiClusteringError('ai_timeout'))
          await call.promise.catch(() => undefined)
        }
      })
      await settle()
      expect(move).toHaveFocus()
    },
  )

  it.each(['success', 'error'] as const)(
    'stays in an open rename input (%s)',
    async (outcome) => {
      setup()
      await facilitatorPanel()
      const call = await pendingRun()
      fireEvent.click(
        screen.getByRole('button', { name: 'Rename cluster Process' }),
      )
      const form = await screen.findByRole('form', {
        name: 'Rename cluster Process',
      })
      const input = within(form).getByRole('textbox')
      await waitFor(() => {
        expect(input).toHaveFocus()
      })
      await act(async () => {
        if (outcome === 'success') {
          call.resolve(success(1, 1))
          await call.promise
        } else {
          call.reject(new AiClusteringError('ai_timeout'))
          await call.promise.catch(() => undefined)
        }
      })
      await settle()
      expect(input).toHaveFocus()
    },
  )

  it.each([
    ['success', 'main button'],
    ['error', 'main button'],
    ['success', 'body'],
    ['error', 'body'],
  ] as const)(
    '%s: from the %s, focus is on the main button',
    async (outcome, from) => {
      setup()
      await facilitatorPanel()
      const call = await pendingRun()
      expect(mainButton()).toHaveFocus()
      if (from === 'body') {
        blurToBody()
      }
      if (outcome === 'success') {
        boardMock.fetchCycleBoard.mockResolvedValue(boardOf([PROCESS, TOOLS]))
      }
      await act(async () => {
        if (outcome === 'success') {
          call.resolve(success(1, 2))
          await call.promise
        } else {
          call.reject(new AiClusteringError('ai_timeout'))
          await call.promise.catch(() => undefined)
        }
      })
      await waitFor(() => {
        expect(mainButton()).toHaveFocus()
      })
      expect(mainButton()).toHaveTextContent(
        outcome === 'success' ? 'Regenerate suggestions' : 'Suggest clusters',
      )
    },
  )
})

describe('the AI badge', () => {
  it('is in the h3 of an AI cluster and goes after a refetch shows it manual', async () => {
    setup({ board: boardOf([PROCESS, TOOLS, DOCS]) })
    await facilitatorPanel()
    await subscribed()
    const heading = screen.getByRole('heading', {
      level: 3,
      name: 'Tools (1) AI suggestion',
    })
    expect(heading).toHaveAccessibleName(/AI suggestion$/)
    expect(heading.className).toContain('flex-wrap')
    const name = heading.querySelector('[data-cluster-name]')
    expect(name?.className).toContain('[overflow-wrap:anywhere]')
    expect(name?.className).not.toContain('break-words')
    expect(
      screen.getByRole('heading', { level: 3, name: 'Process (2)' }),
    ).toBeInTheDocument()

    boardMock.fetchCycleBoard.mockResolvedValue(
      boardOf([PROCESS, { ...TOOLS, source: 'manual' }, DOCS]),
    )
    emitEvent()
    expect(
      await screen.findByRole('heading', { level: 3, name: 'Tools (1)' }),
    ).toBeInTheDocument()
    expect(
      screen.getByRole('heading', { level: 3, name: 'Docs (1) AI suggestion' }),
    ).toBeInTheDocument()
  })

  it('keeps Merge and Move option labels the bare name', async () => {
    setup({ board: boardOf([PROCESS, TOOLS, DOCS]) })
    await facilitatorPanel()
    const move = screen.getByRole('button', {
      name: 'Move card: Start writing ADRs',
    })
    move.focus()
    fireEvent.keyDown(move, { key: 'Enter' })
    const menu = await screen.findByRole('menu')
    expect(
      within(menu).getByRole('menuitem', { name: 'Move to Tools' }),
    ).toBeInTheDocument()
  })
})

describe('keep', () => {
  it('keeps once, announces after the refetch, and focuses the main button', async () => {
    // Two ungrouped cards, so Suggest clusters is offered after the keep.
    const cards: readonly BoardCard[] = [
      ...CARDS,
      {
        cardId: 'c0000000-0000-4000-8000-000000000006',
        category: 'continue',
        text: 'Continue pairing',
        isAnonymous: true,
      },
    ]
    setup({ board: boardOf([PROCESS, TOOLS, DOCS], 'cluster', cards) })
    await facilitatorPanel()
    const kept = deferred<number>()
    aiClusteringMock.acceptAiClusters.mockReturnValue(kept.promise)
    fireEvent.click(
      within(panel()).getByRole('button', { name: 'Keep suggestions' }),
    )
    const group = await screen.findByRole('group', { name: 'Keep suggestions' })
    const confirm = within(group).getByRole('button', {
      name: 'Keep suggestions',
    })
    fireEvent.click(confirm)
    fireEvent.click(confirm)
    await waitFor(() => {
      expect(aiClusteringMock.acceptAiClusters).toHaveBeenCalledTimes(1)
    })
    await settle()
    expect(aiClusteringMock.acceptAiClusters).toHaveBeenCalledTimes(1)
    expect(aiClusteringMock.acceptAiClusters).toHaveBeenCalledWith(CYCLE_ID)
    // Chrome blurs the button that became disabled.
    blurToBody()

    const refetch = deferred<CycleBoard | null>()
    boardMock.fetchCycleBoard.mockReturnValue(refetch.promise)
    await act(async () => {
      kept.resolve(2)
      await kept.promise
    })
    await settle()
    expect(statusText()).toBe('')
    const after = boardOf(
      [PROCESS, { ...TOOLS, source: 'manual' }, { ...DOCS, source: 'manual' }],
      'cluster',
      cards,
    )
    boardMock.fetchCycleBoard.mockResolvedValue(after)
    await act(async () => {
      refetch.resolve(after)
      await refetch.promise
    })
    await waitFor(() => {
      expect(statusText()).toBe(
        'Kept 2 clusters. Regenerating will no longer replace them.',
      )
    })
    expect(
      screen.getByRole('heading', { level: 3, name: 'Tools (1)' }),
    ).toBeInTheDocument()
    await waitFor(() => {
      expect(mainButton()).toHaveFocus()
    })
    expect(mainButton()).toHaveTextContent('Suggest clusters')
  })

  it('announces when nothing was left to keep', async () => {
    setup({ board: boardOf([PROCESS, TOOLS, DOCS]) })
    await facilitatorPanel()
    aiClusteringMock.acceptAiClusters.mockResolvedValue(0)
    fireEvent.click(
      within(panel()).getByRole('button', { name: 'Keep suggestions' }),
    )
    const group = await screen.findByRole('group', { name: 'Keep suggestions' })
    fireEvent.click(
      within(group).getByRole('button', { name: 'Keep suggestions' }),
    )
    await waitFor(() => {
      expect(statusText()).toBe('There were no AI suggestions left to keep.')
    })
  })

  it('leaves focus where the user put it', async () => {
    setup({ board: boardOf([PROCESS, TOOLS, DOCS]) })
    await facilitatorPanel()
    const kept = deferred<number>()
    aiClusteringMock.acceptAiClusters.mockReturnValue(kept.promise)
    fireEvent.click(
      within(panel()).getByRole('button', { name: 'Keep suggestions' }),
    )
    const group = await screen.findByRole('group', { name: 'Keep suggestions' })
    fireEvent.click(
      within(group).getByRole('button', { name: 'Keep suggestions' }),
    )
    const move = screen.getByRole('button', {
      name: 'Move card: Start writing ADRs',
    })
    move.focus()
    await act(async () => {
      kept.resolve(2)
      await kept.promise
    })
    await settle()
    expect(move).toHaveFocus()
  })

  it.each<[KeepErrorCode, string | null]>([
    ['not_project_member', null],
    ['not_project_facilitator', FACILITATOR_ONLY],
    [
      'cycle_not_clustering',
      'Clusters can only be changed during the Cluster stage.',
    ],
    ['unknown', 'Could not keep the suggestions.'],
  ])('%s shows its toast or state', async (code, message) => {
    setup({ board: boardOf([PROCESS, TOOLS, DOCS]) })
    await facilitatorPanel()
    const errorToast = vi.spyOn(toast, 'error')
    membersMock.fetchProjectMembers.mockReturnValue(
      new Promise(() => undefined),
    )
    aiClusteringMock.acceptAiClusters.mockRejectedValue(
      new KeepAiClustersError(code),
    )
    fireEvent.click(
      within(panel()).getByRole('button', { name: 'Keep suggestions' }),
    )
    const group = await screen.findByRole('group', { name: 'Keep suggestions' })
    fireEvent.click(
      within(group).getByRole('button', { name: 'Keep suggestions' }),
    )
    if (message === null) {
      expect(await screen.findByText(NOT_FOUND)).toBeInTheDocument()
      expect(errorToast).not.toHaveBeenCalled()
    } else {
      await waitFor(() => {
        expect(errorToast).toHaveBeenCalledWith(message)
      })
    }
    if (code === 'not_project_facilitator') {
      expect(queryPanel()).toBeNull()
      expect(screen.queryByRole('form', { name: 'New cluster' })).toBeNull()
    }
  })
})

describe('suggestions from elsewhere', () => {
  it.each<[string, ProjectMember[]]>([
    ['a member', asMember],
    ['a facilitator tab that did not start the run', asFacilitator],
  ])(
    '%s hears new AI clusters once; first load, unchanged refetches, and a keep are silent',
    async (_label, members) => {
      setup({ board: boardOf([PROCESS, TOOLS]), members })
      await screen.findByTestId('cluster-board')
      await membersSettled()
      await subscribed()
      expect(statusText()).toBe('')

      emitEvent()
      await settle()
      expect(statusText()).toBe('')

      boardMock.fetchCycleBoard.mockResolvedValue(boardOf([PROCESS, DOCS]))
      emitEvent()
      await waitFor(() => {
        expect(statusText()).toBe(REMOTE)
      })
      const region = within(screen.getByTestId('cluster-board')).getByRole(
        'status',
      )
      const span = region.firstElementChild
      emitEvent()
      await settle()
      expect(region.firstElementChild).toBe(span)

      boardMock.fetchCycleBoard.mockResolvedValue(
        boardOf([PROCESS, { ...DOCS, source: 'manual' }]),
      )
      emitEvent()
      await waitFor(() => {
        expect(
          screen.getByRole('heading', { level: 3, name: 'Docs (1)' }),
        ).toBeInTheDocument()
      })
      expect(region.firstElementChild).toBe(span)
    },
  )

  it('the tab that ran the request announces only its own result', async () => {
    setup()
    await facilitatorPanel()
    await subscribed()
    const call = await pendingRun()
    // The run's write reaches this tab through Realtime before the response.
    boardMock.fetchCycleBoard.mockResolvedValue(boardOf([PROCESS, TOOLS, DOCS]))
    emitEvent()
    await screen.findByRole('heading', {
      level: 3,
      name: 'Tools (1) AI suggestion',
    })
    expect(statusText()).toBe('Generating suggestions.')
    await act(async () => {
      call.resolve(success(2, 1))
      await call.promise
    })
    await waitFor(() => {
      expect(statusText()).toBe(
        'Added 2 suggested clusters. 1 card is in Ungrouped.',
      )
    })
    emitEvent()
    await settle()
    expect(statusText()).toBe(
      'Added 2 suggested clusters. 1 card is in Ungrouped.',
    )
  })

  it('the tab that ran the request stays silent about ids its own re-read brought', async () => {
    setup()
    await facilitatorPanel()
    await subscribed()
    const call = await pendingRun()
    // No Realtime event first: the run's own re-read brings the new ids.
    boardMock.fetchCycleBoard.mockResolvedValue(boardOf([PROCESS, TOOLS, DOCS]))
    await act(async () => {
      call.resolve(success(2, 1))
      await call.promise
    })
    await screen.findByRole('heading', {
      level: 3,
      name: 'Tools (1) AI suggestion',
    })
    const region = within(screen.getByTestId('cluster-board')).getByRole(
      'status',
    )
    await waitFor(() => {
      expect(statusText()).toBe(
        'Added 2 suggested clusters. 1 card is in Ungrouped.',
      )
    })
    const span = region.firstElementChild
    emitEvent()
    await settle()
    expect(region.firstElementChild).toBe(span)
    expect(statusText()).toBe(
      'Added 2 suggested clusters. 1 card is in Ungrouped.',
    )
  })
})

describe('privacy', () => {
  it('no panel text, confirmation, announcement, alert, or badge has card text or an author', async () => {
    setup({ board: boardOf([PROCESS, TOOLS, DOCS]) })
    await facilitatorPanel()
    const forbidden = [
      ...CARDS.map((card) => card.text),
      'Grace',
      'Ada',
      'Linus',
    ]
    const expectClean = (text: string | null) => {
      for (const word of forbidden) {
        expect(text ?? '').not.toContain(word)
      }
    }
    expectClean(panel().textContent)
    fireEvent.click(mainButton())
    expectClean(
      (await screen.findByRole('group', { name: 'Regenerate suggestions' }))
        .textContent,
    )
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    fireEvent.click(
      within(panel()).getByRole('button', { name: 'Keep suggestions' }),
    )
    expectClean(
      (await screen.findByRole('group', { name: 'Keep suggestions' }))
        .textContent,
    )
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    for (const heading of screen.getAllByRole('heading', { level: 3 })) {
      expectClean(heading.textContent)
    }
    const call = await pendingRun()
    expectClean(statusText())
    await act(async () => {
      call.reject(new AiClusteringError('ai_refused'))
      await call.promise.catch(() => undefined)
    })
    expectClean((await within(panel()).findByRole('alert')).textContent)
    expectClean(panel().textContent)
  })

  it('an anonymous card in an AI cluster renders as in a manual cluster', async () => {
    const anonymous = CARDS[1]
    const view = setup({
      board: boardOf([PROCESS, { ...DOCS, source: 'manual' }]),
    })
    await facilitatorPanel()
    // The card's content node (category, text, author label); the Move
    // button beside it only differs by its generated Radix id.
    const content = `li[data-card-id="${anonymous.cardId}"] > div`
    const manualContent = document.querySelector(content)?.outerHTML
    expect(manualContent).toContain('Anonymous')
    view.unmount()
    queryClient.clear()

    setup({ board: boardOf([PROCESS, DOCS]) })
    await facilitatorPanel()
    expect(document.querySelector(content)?.outerHTML).toBe(manualContent)
  })
})

describe('the request contract', () => {
  it('a failed cluster write still toasts as before while no run is pending', async () => {
    setup({ board: boardOf([PROCESS, TOOLS, DOCS]) })
    await facilitatorPanel()
    const errorToast = vi.spyOn(toast, 'error')
    boardMock.deleteCluster.mockRejectedValue(new ClustersApiError('unknown'))
    fireEvent.click(screen.getByRole('button', { name: 'Delete cluster Docs' }))
    const del = await screen.findByRole('group', {
      name: 'Delete cluster Docs',
    })
    fireEvent.click(within(del).getByRole('button', { name: 'Delete cluster' }))
    await waitFor(() => {
      expect(errorToast).toHaveBeenCalledWith('Could not delete the cluster.')
    })
    expect(boardMock.deleteCluster).toHaveBeenCalledTimes(1)
  })
})
