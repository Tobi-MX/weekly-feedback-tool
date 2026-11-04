import { act, fireEvent, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { CycleDetail } from '../cycles/cyclesApi'
import type { CycleStatus } from '../cycles/cycleStatus'
import { queryClient } from '../lib/queryClient'
import type { ProjectMember } from '../projects/membersApi'
import { actionsMock } from '../test/actionsMock'
import { deferred, mockRestoredSession } from '../test/authMock'
import { boardMock } from '../test/boardMock'
import { cyclesMock } from '../test/cyclesMock'
import { discussionMock } from '../test/discussionMock'
import { membersMock } from '../test/membersMock'
import { profileMock } from '../test/profileMock'
import { renderApp } from '../test/renderApp'
import { votesMock } from '../test/votesMock'
import {
  ActionApiError,
  actionErrorMessage,
  ACTION_ERROR_CODES,
  type ActionErrorCode,
  type ActionWrite,
} from './actionErrors'
import {
  ACTION_HINT,
  DESCRIPTION_TOO_LONG_MESSAGE,
  DUE_DATE_RANGE_MESSAGE,
  EMPTY_DESCRIPTION_MESSAGE,
  NO_OWNER_MESSAGE,
} from './ActionForm'
import {
  ACTION_DELETED_ELSEWHERE_MESSAGE,
  ACTIONS_LOAD_ERROR,
  ACTIONS_LOADING,
  DELETE_ACTION_QUESTION,
  NO_ACTIONS,
} from './ActionItems'
import type { CycleAction, CycleActions } from './actionsApi'
import type { BoardCard, BoardCluster, CycleBoard } from './boardApi'
import type { CycleDiscussion } from './discussionApi'
import type { VoteTotal } from './voteTotalsApi'

const CYCLE_ID = '30000000-0000-4000-8000-000000000001'
const PROJECT_ID = '10000000-0000-4000-8000-000000000001'
const PATH = `/cycles/${CYCLE_ID}/board`
const NOT_FOUND = 'Cycle not found or you do not have access.'
const LIVE_NOTICE =
  'Live updates are unavailable. The board refreshes every few seconds.'

const ME = 'user-1'
const FAC = 'user-2'
const DAN = 'user-3'

const cycle: CycleDetail = {
  id: CYCLE_ID,
  projectId: PROJECT_ID,
  title: 'Sprint twelve retro',
  weekStart: '2026-10-26',
  status: 'discuss',
}

const ANON: BoardCard = {
  cardId: 'c0000000-0000-4000-8000-000000000004',
  category: 'start',
  text: 'Start writing ADRs',
  isAnonymous: true,
}
const NAMED: BoardCard = {
  cardId: 'b0000000-0000-4000-8000-000000000003',
  category: 'stop',
  text: 'Stop late merges',
  isAnonymous: false,
  isMine: false,
  authorDisplayName: 'Grace',
}
const LOOSE: BoardCard = {
  cardId: 'f0000000-0000-4000-8000-000000000001',
  category: 'continue',
  text: 'Continue demos',
  isAnonymous: false,
  isMine: true,
  authorDisplayName: 'Ada',
}
const CARD_WORDS = [ANON.text, NAMED.text, LOOSE.text, 'Grace', 'Ada']

// The cluster-board order: Process, Tools, Docs.
const PROCESS: BoardCluster = {
  clusterId: 'd1000000-0000-4000-8000-000000000001',
  name: 'Process',
  source: 'manual',
  cardIds: [NAMED.cardId, ANON.cardId],
}
const TOOLS: BoardCluster = {
  clusterId: 'a1000000-0000-4000-8000-000000000002',
  name: 'Tools',
  source: 'ai',
  cardIds: [],
}
const DOCS: BoardCluster = {
  clusterId: 'b1000000-0000-4000-8000-000000000003',
  name: 'Docs',
  source: 'manual',
  cardIds: [],
}
const CLUSTERS = [PROCESS, TOOLS, DOCS]

// The agenda order: Docs, Process, Tools (not board order, not by name).
const TOTALS: VoteTotal[] = [
  { clusterId: DOCS.clusterId, totalVotes: 3 },
  { clusterId: PROCESS.clusterId, totalVotes: 2 },
  { clusterId: TOOLS.clusterId, totalVotes: 1 },
]

function boardOf(
  status: CycleStatus = 'discuss',
  clusters: readonly BoardCluster[] = CLUSTERS,
): CycleBoard {
  return {
    cycleId: CYCLE_ID,
    status,
    isRevealed: status !== 'collecting',
    cards: [NAMED, ANON, LOOSE],
    clusters,
    myVotes: [],
    votesRemaining: 3,
  }
}

function discussionOf(
  clusters: readonly BoardCluster[] = CLUSTERS,
): CycleDiscussion {
  return {
    cycleId: CYCLE_ID,
    statuses: clusters.map((cluster) => ({
      clusterId: cluster.clusterId,
      discussionStatus: 'pending',
    })),
    notes: [],
  }
}

const T = '2026-11-03T09:00:00.000000+00:00'
let actionSeq = 0
function action(
  description: string,
  overrides: Partial<CycleAction> = {},
): CycleAction {
  actionSeq += 1
  return {
    actionId: `a0000000-0000-4000-8000-${String(actionSeq).padStart(12, '0')}`,
    clusterId: null,
    description,
    ownerId: DAN,
    ownerName: 'Dan',
    ownerIsMe: false,
    createdByMe: false,
    dueDate: null,
    status: 'open',
    completedAt: null,
    source: 'manual',
    createdAt: T,
    updatedAt: T,
    ...overrides,
  }
}

/** Created by and owned by the caller. */
function mine(description: string, overrides: Partial<CycleAction> = {}) {
  return action(description, {
    ownerId: ME,
    ownerName: 'Dev User',
    ownerIsMe: true,
    createdByMe: true,
    ...overrides,
  })
}

function actionsOf(actions: readonly CycleAction[] = []): CycleActions {
  return { cycleId: CYCLE_ID, actions }
}

function memberRow(overrides: Partial<ProjectMember>): ProjectMember {
  return {
    userId: ME,
    displayName: 'Dev User',
    role: 'member',
    isOwner: false,
    isMe: true,
    joinedAt: '2026-10-30T12:00:00.000Z',
    ...overrides,
  }
}

const DAN_ROW = memberRow({
  userId: DAN,
  displayName: 'Dan',
  isMe: false,
})
const asFacilitator = [
  DAN_ROW,
  memberRow({ role: 'facilitator', isOwner: true }),
]
const asMember = [
  DAN_ROW,
  memberRow({}),
  memberRow({
    userId: FAC,
    displayName: 'Fac',
    role: 'facilitator',
    isMe: false,
    isOwner: true,
  }),
]
const asOwnerNotFacilitator = [
  DAN_ROW,
  memberRow({ isOwner: true }),
  memberRow({
    userId: FAC,
    displayName: 'Fac',
    role: 'facilitator',
    isMe: false,
  }),
]

interface SetupOptions {
  readonly board?: CycleBoard
  readonly members?: ProjectMember[]
  readonly actions?: CycleActions
}

function setup(options: SetupOptions = {}) {
  mockRestoredSession('dev@example.com', ME)
  profileMock.fetchProfileDisplayName.mockResolvedValue('Dev User')
  const board = options.board ?? boardOf()
  cyclesMock.fetchCycle.mockResolvedValue({ ...cycle, status: board.status })
  boardMock.fetchCycleBoard.mockResolvedValue(board)
  membersMock.fetchProjectMembers.mockResolvedValue(
    options.members ?? asFacilitator,
  )
  votesMock.fetchVoteTotals.mockResolvedValue(
    TOTALS.filter((total) =>
      board.clusters.some((cluster) => cluster.clusterId === total.clusterId),
    ),
  )
  discussionMock.fetchDiscussion.mockResolvedValue(discussionOf(board.clusters))
  actionsMock.fetchCycleActions.mockResolvedValue(
    options.actions ?? actionsOf(),
  )
  return renderApp({ initialEntries: [PATH] })
}

function serverActions(actions: readonly CycleAction[]) {
  actionsMock.fetchCycleActions.mockResolvedValue(actionsOf(actions))
}

async function refetchActions(): Promise<void> {
  await act(async () => {
    await queryClient.invalidateQueries({ queryKey: ['cycle-actions'] })
  })
}

async function refetchMembers(): Promise<void> {
  await act(async () => {
    await queryClient.invalidateQueries({ queryKey: ['project-members'] })
  })
}

/** The section, once the actions and the members are in. */
async function ready(withAdd = true): Promise<HTMLElement> {
  await screen.findByRole(
    'heading',
    { level: 3, name: /^Action items \(\d+\)$/ },
    { timeout: 5000 },
  )
  await waitFor(() => {
    expect(membersMock.fetchProjectMembers).toHaveBeenCalled()
  })
  if (withAdd) {
    await screen.findByRole('button', { name: 'Add action item' })
  }
  return section()
}

function section(): HTMLElement {
  const heading = screen.getByRole('heading', {
    level: 3,
    name: /^Action items/,
  })
  const found = heading.closest('section')
  if (!found) {
    throw new Error('no Action items section')
  }
  return found
}

function actionItem(description: string): HTMLElement {
  const item = [
    ...document.querySelectorAll<HTMLElement>('li[data-action-id]'),
  ].find((li) => li.querySelector('p')?.textContent === description)
  if (!item) {
    throw new Error(`no action ${description}`)
  }
  return item
}

function lines(item: HTMLElement): string[] {
  return [...item.querySelectorAll('p')].map((p) => p.textContent ?? '')
}

function itemDescriptions(): string[] {
  const list = screen.queryByRole('list', { name: 'Action items' })
  if (!list) {
    return []
  }
  return [...list.querySelectorAll<HTMLElement>('li[data-action-id]')].map(
    (li) => li.querySelector('p')?.textContent ?? '',
  )
}

function addButton(): HTMLElement {
  return screen.getByRole('button', { name: 'Add action item' })
}

function addForm(): HTMLElement {
  return screen.getByRole('form', { name: 'New action item' })
}

function editForm(excerpt: string): HTMLElement {
  return screen.getByRole('form', { name: `Editing action: ${excerpt}` })
}

function field<T extends HTMLElement>(form: HTMLElement, label: string): T {
  return within(form).getByLabelText(label)
}

function saveOf(form: HTMLElement): HTMLElement {
  return within(form).getByRole('button', { name: /^(Save action|Saving…)$/ })
}

function type(element: HTMLElement, value: string) {
  fireEvent.change(element, { target: { value } })
}

function fill(
  form: HTMLElement,
  values: {
    description?: string
    owner?: string
    due?: string
    topic?: string
  },
) {
  if (values.description !== undefined) {
    type(field(form, 'Description'), values.description)
  }
  if (values.owner !== undefined) {
    type(field(form, 'Owner'), values.owner)
  }
  if (values.due !== undefined) {
    type(field(form, 'Due date (optional)'), values.due)
  }
  if (values.topic !== undefined) {
    type(field(form, 'Related topic'), values.topic)
  }
}

function optionTexts(select: HTMLElement): string[] {
  return [...select.querySelectorAll('option')].map((o) => o.textContent ?? '')
}

function confirmGroup(): HTMLElement {
  return screen.getByRole('group', { name: DELETE_ACTION_QUESTION })
}

function statusRegion(): HTMLElement {
  const region = screen
    .getByTestId('discuss-board')
    .querySelector<HTMLElement>('p[aria-live="polite"]')
  if (!region) {
    throw new Error('no status region')
  }
  return region
}

function liveTexts(): string[] {
  return screen
    .getAllByRole('status')
    .map((element) => element.textContent ?? '')
    .filter((text) => text !== '')
}

beforeEach(() => {
  // Local noon on a fixed date, so "today" never depends on the host.
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(new Date(2026, 10, 3, 12, 0, 0))
})

afterEach(() => {
  vi.useRealTimers()
})

describe('layout', () => {
  it('places Action items (N) after General notes and before Ungrouped and lists the actions in server order with every line', async () => {
    const actions = [
      action('Write the runbook', {
        dueDate: '2026-11-12',
        clusterId: DOCS.clusterId,
      }),
      mine('Own and overdue', { dueDate: '2026-11-02' }),
      action('Due today', { dueDate: '2026-11-03' }),
      action('Done and late', {
        dueDate: '2026-11-02',
        status: 'done',
        completedAt: T,
        clusterId: TOOLS.clusterId,
      }),
    ]
    setup({ actions: actionsOf(actions) })
    await ready()

    expect(
      screen
        .getAllByRole('heading', { level: 3 })
        .map((heading) => heading.textContent)
        .filter((text) =>
          /^(General notes|Action items|Ungrouped)/.test(text ?? ''),
        ),
    ).toEqual(['General notes (0)', 'Action items (4)', 'Ungrouped (1)'])
    const headings = screen.getAllByRole('heading', { level: 3 })
    const general = headings.find((h) => h.textContent === 'General notes (0)')
    const actionsHeading = headings.find(
      (h) => h.textContent === 'Action items (4)',
    )
    const ungrouped = headings.find((h) => h.textContent === 'Ungrouped (1)')
    expect(general?.compareDocumentPosition(actionsHeading as Node) ?? 0).toBe(
      Node.DOCUMENT_POSITION_FOLLOWING,
    )
    expect(
      actionsHeading?.compareDocumentPosition(ungrouped as Node) ?? 0,
    ).toBe(Node.DOCUMENT_POSITION_FOLLOWING)

    expect(itemDescriptions()).toEqual([
      'Write the runbook',
      'Own and overdue',
      'Due today',
      'Done and late',
    ])
    expect(lines(actionItem('Write the runbook'))).toEqual([
      'Write the runbook',
      'Owner: Dan',
      'Due Nov 12, 2026',
      'Topic: Docs',
      'Status: Open',
    ])
    expect(lines(actionItem('Own and overdue'))).toEqual([
      'Own and overdue',
      'Owner: Dev User (you)',
      'Due Nov 2, 2026 · Overdue',
      'No related topic',
      'Status: Open',
    ])
    expect(lines(actionItem('Due today'))[2]).toBe('Due Nov 3, 2026')
    expect(lines(actionItem('Done and late'))).toEqual([
      'Done and late',
      'Owner: Dan',
      'Due Nov 2, 2026',
      'Topic: Tools',
      'Status: Done',
    ])
    // The agenda keeps #24's order.
    expect(
      within(screen.getByRole('list', { name: 'Agenda' }))
        .getAllByRole('heading', { level: 3 })
        .map((h) => h.querySelector('[data-cluster-name]')?.textContent),
    ).toEqual(['Docs (0)', 'Process (2)', 'Tools (0)'])
  })

  it('with no actions says so', async () => {
    setup()
    const found = await ready()
    expect(within(found).getByText(NO_ACTIONS)).toBeInTheDocument()
    expect(
      within(found).getByRole('heading', {
        level: 3,
        name: 'Action items (0)',
      }),
    ).toBeInTheDocument()
    expect(actionsMock.fetchCycleActions).toHaveBeenCalledWith(CYCLE_ID)
  })
})

describe('controls', () => {
  const actions = () => [
    action('Theirs'),
    action('Owned by me', {
      ownerId: ME,
      ownerName: 'Dev User',
      ownerIsMe: true,
    }),
    action('Created by me', { createdByMe: true }),
  ]

  function controlsOf(description: string): string[] {
    return within(actionItem(description))
      .queryAllByRole('button')
      .map((button) => button.textContent ?? '')
  }

  it('a member sees Mark done only on owned actions and Edit / Delete only on created ones', async () => {
    setup({ members: asMember, actions: actionsOf(actions()) })
    await ready()
    expect(controlsOf('Theirs')).toEqual([])
    expect(controlsOf('Owned by me')).toEqual(['Mark done'])
    expect(controlsOf('Created by me')).toEqual(['Edit', 'Delete'])
  })

  it('the project owner who is not the facilitator sees the same', async () => {
    setup({ members: asOwnerNotFacilitator, actions: actionsOf(actions()) })
    await ready()
    expect(controlsOf('Theirs')).toEqual([])
    expect(controlsOf('Owned by me')).toEqual(['Mark done'])
    expect(controlsOf('Created by me')).toEqual(['Edit', 'Delete'])
  })

  it('the facilitator sees all three on every action, with excerpt names', async () => {
    const long = 'L'.repeat(45)
    setup({ actions: actionsOf([...actions(), action(long)]) })
    await ready()
    for (const description of ['Theirs', 'Owned by me', 'Created by me']) {
      expect(controlsOf(description)).toEqual(['Mark done', 'Edit', 'Delete'])
    }
    expect(
      screen.getByRole('button', { name: `Mark done: ${'L'.repeat(40)}…` }),
    ).toBeInTheDocument()
    expect(
      screen.getByRole('button', { name: `Edit action: ${'L'.repeat(40)}…` }),
    ).toBeInTheDocument()
    expect(
      screen.getByRole('button', { name: `Delete action: ${'L'.repeat(40)}…` }),
    ).toBeInTheDocument()
  })

  it('while the members query is loading, no Add, Edit or Delete renders and the toggle shows only on own actions', async () => {
    const members = deferred<ProjectMember[]>()
    setup({ actions: actionsOf(actions()) })
    membersMock.fetchProjectMembers.mockReturnValue(members.promise)
    await ready(false)
    expect(screen.queryByRole('button', { name: 'Add action item' })).toBeNull()
    expect(controlsOf('Theirs')).toEqual([])
    expect(controlsOf('Owned by me')).toEqual(['Mark done'])
    expect(controlsOf('Created by me')).toEqual([])
    await act(async () => {
      members.resolve(asFacilitator)
      await members.promise
    })
    expect(
      await screen.findByRole('button', { name: 'Add action item' }),
    ).toBeInTheDocument()
  })

  it('when the members query has failed, the same holds', async () => {
    setup({ actions: actionsOf(actions()) })
    membersMock.fetchProjectMembers.mockRejectedValue(new Error('down'))
    await ready(false)
    await waitFor(() => {
      expect(controlsOf('Owned by me')).toEqual(['Mark done'])
    })
    expect(screen.queryByRole('button', { name: 'Add action item' })).toBeNull()
    expect(controlsOf('Theirs')).toEqual([])
    expect(controlsOf('Created by me')).toEqual([])
  })
})

describe('create', () => {
  it('opens the form, sends the trimmed input once despite a double click and held Enter, then shows, announces, and focuses Add', async () => {
    setup()
    await ready()
    fireEvent.click(addButton())
    const form = addForm()
    const description = field<HTMLTextAreaElement>(form, 'Description')
    expect(description).toHaveFocus()
    expect(description).toHaveAccessibleDescription(ACTION_HINT)
    expect(description).not.toHaveAttribute('maxlength')
    expect(optionTexts(field(form, 'Owner'))).toEqual([
      'Choose an owner',
      'Dan',
      'Dev User (you)',
    ])
    expect(field(form, 'Owner')).toHaveValue('')
    expect(optionTexts(field(form, 'Related topic'))).toEqual([
      'No related topic',
      'Docs',
      'Process',
      'Tools',
    ])
    const due = field<HTMLInputElement>(form, 'Due date (optional)')
    expect(due).toHaveAttribute('type', 'date')
    expect(due).toHaveAttribute('min', '2000-01-01')
    expect(due).toHaveAttribute('max', '2099-12-31')

    const pending = deferred<string>()
    actionsMock.createAction.mockReturnValue(pending.promise)
    fill(form, {
      description: '  Write the runbook\nfirst draft  ',
      owner: DAN,
      due: '2026-11-12',
      topic: DOCS.clusterId,
    })
    const save = saveOf(form)
    fireEvent.click(save)
    fireEvent.click(save)
    fireEvent.submit(form)
    fireEvent.submit(form)
    await waitFor(() => {
      expect(actionsMock.createAction).toHaveBeenCalledTimes(1)
    })
    expect(actionsMock.createAction).toHaveBeenCalledWith(CYCLE_ID, {
      description: 'Write the runbook\nfirst draft',
      ownerId: DAN,
      dueDate: '2026-11-12',
      clusterId: DOCS.clusterId,
    })
    expect(
      await screen.findByRole('button', { name: 'Saving…' }),
    ).toBeInTheDocument()
    expect(actionsMock.createAction).toHaveBeenCalledTimes(1)

    serverActions([
      action('Write the runbook\nfirst draft', {
        createdByMe: true,
        dueDate: '2026-11-12',
        clusterId: DOCS.clusterId,
      }),
    ])
    await act(async () => {
      pending.resolve('new')
      await pending.promise
    })
    await waitFor(() => {
      expect(statusRegion()).toHaveTextContent('Action item added.')
    })
    const item = actionItem('Write the runbook\nfirst draft')
    expect(item.querySelector('p')?.className).toContain('whitespace-pre-wrap')
    expect(
      screen.getByRole('heading', { level: 3, name: 'Action items (1)' }),
    ).toBeInTheDocument()
    expect(screen.queryByRole('form', { name: 'New action item' })).toBeNull()
    await waitFor(() => {
      expect(addButton()).toHaveFocus()
    })
  })

  it('saving with no date and no topic sends null for both', async () => {
    setup()
    await ready()
    actionsMock.createAction.mockResolvedValue('new')
    fireEvent.click(addButton())
    fill(addForm(), { description: 'Plain', owner: ME })
    fireEvent.click(saveOf(addForm()))
    await waitFor(() => {
      expect(actionsMock.createAction).toHaveBeenCalledWith(CYCLE_ID, {
        description: 'Plain',
        ownerId: ME,
        dueDate: null,
        clusterId: null,
      })
    })
  })

  it('Escape and Cancel close the form and discard the draft with no call', async () => {
    setup()
    await ready()
    fireEvent.click(addButton())
    fill(addForm(), { description: 'Gone' })
    fireEvent.keyDown(field(addForm(), 'Description'), { key: 'Escape' })
    expect(screen.queryByRole('form', { name: 'New action item' })).toBeNull()
    expect(addButton()).toHaveFocus()
    fireEvent.click(addButton())
    expect(field(addForm(), 'Description')).toHaveValue('')
    fireEvent.click(within(addForm()).getByRole('button', { name: 'Cancel' }))
    expect(screen.queryByRole('form', { name: 'New action item' })).toBeNull()
    expect(actionsMock.createAction).not.toHaveBeenCalled()
  })
})

describe('validation', () => {
  it.each<[string, Record<string, string>, string, string]>([
    [
      'an empty description',
      { owner: DAN },
      'Description',
      EMPTY_DESCRIPTION_MESSAGE,
    ],
    [
      'a whitespace-only description',
      { description: ' \n\t ', owner: DAN },
      'Description',
      EMPTY_DESCRIPTION_MESSAGE,
    ],
    [
      '501 code points',
      { description: '😀'.repeat(501), owner: DAN },
      'Description',
      DESCRIPTION_TOO_LONG_MESSAGE,
    ],
    ['no owner', { description: 'x' }, 'Owner', NO_OWNER_MESSAGE],
    [
      'a date before 2000',
      { description: 'x', owner: DAN, due: '1999-12-31' },
      'Due date (optional)',
      DUE_DATE_RANGE_MESSAGE,
    ],
    [
      'a date after 2099',
      { description: 'x', owner: DAN, due: '2100-01-01' },
      'Due date (optional)',
      DUE_DATE_RANGE_MESSAGE,
    ],
  ])(
    '%s shows its alert, keeps the input, and sends nothing',
    async (_label, values, label, message) => {
      setup()
      await ready()
      fireEvent.click(addButton())
      fill(addForm(), values)
      fireEvent.click(saveOf(addForm()))
      const alert = await within(addForm()).findByRole('alert')
      expect(alert).toHaveTextContent(message)
      const target = field(addForm(), label)
      expect(target).toHaveAttribute('aria-invalid', 'true')
      expect(target.getAttribute('aria-describedby')?.split(' ')).toContain(
        alert.id,
      )
      if (values.description !== undefined) {
        expect(field(addForm(), 'Description')).toHaveValue(values.description)
      }
      expect(actionsMock.createAction).not.toHaveBeenCalled()
    },
  )

  it('exactly 500 code points sends', async () => {
    setup()
    await ready()
    actionsMock.createAction.mockResolvedValue('new')
    fireEvent.click(addButton())
    fill(addForm(), { description: '😀'.repeat(500), owner: DAN })
    fireEvent.click(saveOf(addForm()))
    await waitFor(() => {
      expect(actionsMock.createAction).toHaveBeenCalledTimes(1)
    })
    expect(screen.queryByText(DESCRIPTION_TOO_LONG_MESSAGE)).toBeNull()
  })
})

describe('edit', () => {
  it('opens pre-filled, sends all four fields once, then shows the new values, announces, and focuses Edit', async () => {
    const own = mine('Old text', {
      ownerId: DAN,
      ownerName: 'Dan',
      ownerIsMe: false,
      dueDate: '2026-11-12',
      clusterId: PROCESS.clusterId,
    })
    setup({ members: asMember, actions: actionsOf([own]) })
    await ready()
    fireEvent.click(
      screen.getByRole('button', { name: 'Edit action: Old text' }),
    )
    const form = editForm('Old text')
    expect(field(form, 'Description')).toHaveFocus()
    expect(field(form, 'Description')).toHaveValue('Old text')
    expect(field(form, 'Owner')).toHaveValue(DAN)
    expect(field(form, 'Due date (optional)')).toHaveValue('2026-11-12')
    expect(field(form, 'Related topic')).toHaveValue(PROCESS.clusterId)

    const pending = deferred<undefined>()
    actionsMock.updateAction.mockReturnValue(pending.promise)
    fill(form, {
      description: 'New text',
      owner: ME,
      due: '',
      topic: TOOLS.clusterId,
    })
    fireEvent.click(saveOf(form))
    fireEvent.click(saveOf(form))
    await waitFor(() => {
      expect(actionsMock.updateAction).toHaveBeenCalledTimes(1)
    })
    expect(actionsMock.updateAction).toHaveBeenCalledWith(own.actionId, {
      description: 'New text',
      ownerId: ME,
      dueDate: null,
      clusterId: TOOLS.clusterId,
    })
    serverActions([
      {
        ...own,
        description: 'New text',
        ownerId: ME,
        ownerName: 'Dev User',
        ownerIsMe: true,
        dueDate: null,
        clusterId: TOOLS.clusterId,
      },
    ])
    await act(async () => {
      pending.resolve(undefined)
      await pending.promise
    })
    await waitFor(() => {
      expect(statusRegion()).toHaveTextContent('Action item updated.')
    })
    expect(lines(actionItem('New text'))).toEqual([
      'New text',
      'Owner: Dev User (you)',
      'No due date',
      'Topic: Tools',
      'Status: Open',
    ])
    await waitFor(() => {
      expect(
        screen.getByRole('button', { name: 'Edit action: New text' }),
      ).toHaveFocus()
    })
  })

  it('an action whose owner is not in the members list opens on Choose an owner', async () => {
    const orphan = mine('Orphan', {
      ownerId: null,
      ownerName: null,
      ownerIsMe: false,
    })
    setup({ actions: actionsOf([orphan]) })
    await ready()
    fireEvent.click(screen.getByRole('button', { name: 'Edit action: Orphan' }))
    expect(field(editForm('Orphan'), 'Owner')).toHaveValue('')
  })

  it('Escape and Cancel discard the draft with no call', async () => {
    const own = mine('Keep me')
    setup({ members: asMember, actions: actionsOf([own]) })
    await ready()
    const edit = screen.getByRole('button', { name: 'Edit action: Keep me' })
    fireEvent.click(edit)
    fill(editForm('Keep me'), { description: 'changed' })
    fireEvent.keyDown(field(editForm('Keep me'), 'Description'), {
      key: 'Escape',
    })
    expect(
      screen.queryByRole('form', { name: 'Editing action: Keep me' }),
    ).toBeNull()
    expect(
      screen.getByRole('button', { name: 'Edit action: Keep me' }),
    ).toHaveFocus()
    fireEvent.click(
      screen.getByRole('button', { name: 'Edit action: Keep me' }),
    )
    expect(field(editForm('Keep me'), 'Description')).toHaveValue('Keep me')
    fireEvent.click(
      within(editForm('Keep me')).getByRole('button', { name: 'Cancel' }),
    )
    expect(
      screen.queryByRole('form', { name: 'Editing action: Keep me' }),
    ).toBeNull()
    expect(actionsMock.updateAction).not.toHaveBeenCalled()
  })
})

describe('status', () => {
  it('Mark done sends once, disables every toggle and Save while pending, then shows Done, focuses Reopen, keeps the order, and announces once', async () => {
    const first = mine('First', { dueDate: '2026-11-02' })
    const second = action('Second')
    setup({ actions: actionsOf([first, second]) })
    await ready()
    fireEvent.click(addButton())
    const pending = deferred<undefined>()
    actionsMock.setActionStatus.mockReturnValue(pending.promise)
    const toggle = screen.getByRole('button', { name: 'Mark done: First' })
    fireEvent.click(toggle)
    fireEvent.click(toggle)
    await waitFor(() => {
      expect(actionsMock.setActionStatus).toHaveBeenCalledTimes(1)
    })
    expect(actionsMock.setActionStatus).toHaveBeenCalledWith(
      first.actionId,
      'done',
    )
    expect(
      await screen.findByRole('button', { name: 'Mark done: First' }),
    ).toHaveTextContent('Updating…')
    for (const button of [
      screen.getByRole('button', { name: 'Mark done: First' }),
      screen.getByRole('button', { name: 'Mark done: Second' }),
      saveOf(addForm()),
    ]) {
      expect(button).toHaveAttribute('aria-disabled', 'true')
    }
    fireEvent.click(screen.getByRole('button', { name: 'Mark done: Second' }))
    expect(actionsMock.setActionStatus).toHaveBeenCalledTimes(1)

    serverActions([{ ...first, status: 'done', completedAt: T }, second])
    await act(async () => {
      pending.resolve(undefined)
      await pending.promise
    })
    await waitFor(() => {
      expect(statusRegion()).toHaveTextContent('Action item marked done.')
    })
    expect(lines(actionItem('First'))[2]).toBe('Due Nov 2, 2026')
    expect(lines(actionItem('First'))[4]).toBe('Status: Done')
    expect(itemDescriptions()).toEqual(['First', 'Second'])
    await waitFor(() => {
      expect(
        screen.getByRole('button', { name: 'Reopen: First' }),
      ).toHaveFocus()
    })
    expect(
      liveTexts().filter((text) => text === 'Action item marked done.'),
    ).toHaveLength(1)
  })

  it('Reopen works the same way', async () => {
    const done = mine('Done one', { status: 'done', completedAt: T })
    setup({ members: asMember, actions: actionsOf([done]) })
    await ready()
    actionsMock.setActionStatus.mockResolvedValue(undefined)
    serverActions([{ ...done, status: 'open', completedAt: null }])
    fireEvent.click(screen.getByRole('button', { name: 'Reopen: Done one' }))
    await waitFor(() => {
      expect(statusRegion()).toHaveTextContent('Action item reopened.')
    })
    expect(actionsMock.setActionStatus).toHaveBeenCalledWith(
      done.actionId,
      'open',
    )
    expect(lines(actionItem('Done one'))[4]).toBe('Status: Open')
    await waitFor(() => {
      expect(
        screen.getByRole('button', { name: 'Mark done: Done one' }),
      ).toHaveFocus()
    })
  })
})

describe('delete', () => {
  it('confirms inline with focus on Cancel; Escape cancels; confirming sends once despite a double click, then the item is gone, announced, and Add has focus', async () => {
    const own = mine('Delete me')
    setup({ members: asMember, actions: actionsOf([own]) })
    await ready()
    fireEvent.click(
      screen.getByRole('button', { name: 'Delete action: Delete me' }),
    )
    expect(confirmGroup()).toHaveTextContent(DELETE_ACTION_QUESTION)
    expect(
      within(confirmGroup()).getByRole('button', { name: 'Cancel' }),
    ).toHaveFocus()
    fireEvent.keyDown(
      within(confirmGroup()).getByRole('button', { name: 'Cancel' }),
      { key: 'Escape' },
    )
    expect(
      screen.queryByRole('group', { name: DELETE_ACTION_QUESTION }),
    ).toBeNull()
    expect(actionsMock.deleteAction).not.toHaveBeenCalled()

    fireEvent.click(
      screen.getByRole('button', { name: 'Delete action: Delete me' }),
    )
    const pending = deferred<undefined>()
    actionsMock.deleteAction.mockReturnValue(pending.promise)
    const confirm = within(confirmGroup()).getByRole('button', {
      name: 'Delete',
    })
    fireEvent.click(confirm)
    fireEvent.click(confirm)
    await waitFor(() => {
      expect(actionsMock.deleteAction).toHaveBeenCalledTimes(1)
    })
    expect(actionsMock.deleteAction).toHaveBeenCalledWith(own.actionId)
    expect(
      await within(confirmGroup()).findByRole('button', { name: 'Deleting…' }),
    ).toHaveAttribute('aria-disabled', 'true')
    fireEvent.click(
      within(confirmGroup()).getByRole('button', { name: 'Deleting…' }),
    )
    expect(actionsMock.deleteAction).toHaveBeenCalledTimes(1)

    serverActions([])
    await act(async () => {
      pending.resolve(undefined)
      await pending.promise
    })
    await waitFor(() => {
      expect(statusRegion()).toHaveTextContent('Action item deleted.')
    })
    expect(itemDescriptions()).toEqual([])
    await waitFor(() => {
      expect(addButton()).toHaveFocus()
    })
  })
})

describe('one write at a time', () => {
  it('while a create is pending, an edit Save, every toggle and a confirm Delete are aria-disabled and send nothing; typing still works', async () => {
    const own = mine('Own')
    const other = mine('Other')
    setup({ members: asMember, actions: actionsOf([own, other]) })
    await ready()
    fireEvent.click(screen.getByRole('button', { name: 'Edit action: Own' }))
    fireEvent.click(
      screen.getByRole('button', { name: 'Delete action: Other' }),
    )
    fireEvent.click(addButton())
    const pending = deferred<string>()
    actionsMock.createAction.mockReturnValue(pending.promise)
    fill(addForm(), { description: 'New', owner: ME })
    fireEvent.click(saveOf(addForm()))
    await waitFor(() => {
      expect(actionsMock.createAction).toHaveBeenCalledTimes(1)
    })

    const edit = editForm('Own')
    type(field(edit, 'Description'), 'typed while pending')
    expect(field(edit, 'Description')).toHaveValue('typed while pending')
    await waitFor(() => {
      expect(saveOf(edit)).toHaveAttribute('aria-disabled', 'true')
    })
    const toggle = screen.getByRole('button', { name: 'Mark done: Other' })
    const confirm = within(confirmGroup()).getByRole('button', {
      name: 'Delete',
    })
    expect(toggle).toHaveAttribute('aria-disabled', 'true')
    expect(confirm).toHaveAttribute('aria-disabled', 'true')
    fireEvent.click(saveOf(edit))
    fireEvent.click(toggle)
    fireEvent.click(confirm)
    expect(actionsMock.updateAction).not.toHaveBeenCalled()
    expect(actionsMock.setActionStatus).not.toHaveBeenCalled()
    expect(actionsMock.deleteAction).not.toHaveBeenCalled()

    await act(async () => {
      pending.resolve('n')
      await pending.promise
    })
    await waitFor(() => {
      expect(saveOf(editForm('Own'))).not.toHaveAttribute('aria-disabled')
    })
    expect(field(editForm('Own'), 'Description')).toHaveValue(
      'typed while pending',
    )
  })

  it('a pending note write does not disable action controls, and the reverse', async () => {
    const own = mine('Own')
    setup({ members: asMember, actions: actionsOf([own]) })
    await ready()
    const note = deferred<string>()
    discussionMock.addNote.mockReturnValue(note.promise)
    fireEvent.click(screen.getByRole('button', { name: 'Add a general note' }))
    const noteField = screen.getByLabelText('General note', {
      selector: 'textarea',
    })
    type(noteField, 'a note')
    const noteForm = noteField.closest('form') as HTMLElement
    fireEvent.click(within(noteForm).getByRole('button', { name: 'Save note' }))
    await waitFor(() => {
      expect(discussionMock.addNote).toHaveBeenCalledTimes(1)
    })
    expect(
      screen.getByRole('button', { name: 'Mark done: Own' }),
    ).not.toHaveAttribute('aria-disabled')
    fireEvent.click(addButton())
    expect(saveOf(addForm())).not.toHaveAttribute('aria-disabled')

    const status = deferred<undefined>()
    actionsMock.setActionStatus.mockReturnValue(status.promise)
    fireEvent.click(screen.getByRole('button', { name: 'Mark done: Own' }))
    await waitFor(() => {
      expect(actionsMock.setActionStatus).toHaveBeenCalledTimes(1)
    })
    await act(async () => {
      note.resolve('n')
      await note.promise
    })
    fireEvent.click(screen.getByRole('button', { name: 'Add a general note' }))
    const second = screen.getByLabelText('General note', {
      selector: 'textarea',
    })
    expect(
      within(second.closest('form') as HTMLElement).getByRole('button', {
        name: 'Save note',
      }),
    ).not.toHaveAttribute('aria-disabled')
    await act(async () => {
      status.resolve(undefined)
      await status.promise
    })
  })
})

describe('errors', () => {
  const CODES: ActionErrorCode[] = [
    ...ACTION_ERROR_CODES.filter((code) => code !== 'not_project_member'),
    'unknown',
  ]
  const WRITES: ActionWrite[] = ['create', 'edit', 'status', 'delete']

  async function prepare() {
    setup({ members: asMember, actions: actionsOf([mine('Target')]) })
    await ready()
  }

  function trigger(write: ActionWrite, code: ActionErrorCode) {
    const error = new ActionApiError(code)
    switch (write) {
      case 'create':
        actionsMock.createAction.mockRejectedValue(error)
        fireEvent.click(addButton())
        fill(addForm(), { description: 'keep this', owner: ME })
        fireEvent.click(saveOf(addForm()))
        break
      case 'edit':
        actionsMock.updateAction.mockRejectedValue(error)
        fireEvent.click(
          screen.getByRole('button', { name: 'Edit action: Target' }),
        )
        fill(editForm('Target'), { description: 'changed' })
        fireEvent.click(saveOf(editForm('Target')))
        break
      case 'status':
        actionsMock.setActionStatus.mockRejectedValue(error)
        fireEvent.click(
          screen.getByRole('button', { name: 'Mark done: Target' }),
        )
        break
      case 'delete':
        actionsMock.deleteAction.mockRejectedValue(error)
        fireEvent.click(
          screen.getByRole('button', { name: 'Delete action: Target' }),
        )
        fireEvent.click(
          within(confirmGroup()).getByRole('button', { name: 'Delete' }),
        )
        break
    }
  }

  async function failWrite(write: ActionWrite, code: ActionErrorCode) {
    await prepare()
    trigger(write, code)
  }

  it.each(
    WRITES.flatMap((write) => CODES.map((code) => [write, code] as const)),
  )(
    '%s / %s shows its exact toast once and re-reads the actions',
    async (write, code) => {
      await prepare()
      const before = actionsMock.fetchCycleActions.mock.calls.length
      trigger(write, code)
      const message = actionErrorMessage(code, write) ?? ''
      expect(await screen.findByText(message)).toBeInTheDocument()
      expect(screen.getAllByText(message)).toHaveLength(1)
      await waitFor(() => {
        expect(actionsMock.fetchCycleActions.mock.calls.length).toBeGreaterThan(
          before,
        )
      })
      expect(statusRegion()).toHaveTextContent('')
      if (write === 'create') {
        expect(field(addForm(), 'Description')).toHaveValue('keep this')
      }
      if (write === 'edit') {
        if (code === 'action_not_found') {
          await waitFor(() => {
            expect(
              screen.queryByRole('form', { name: 'Editing action: Target' }),
            ).toBeNull()
          })
        } else {
          expect(field(editForm('Target'), 'Description')).toHaveValue(
            'changed',
          )
        }
      }
    },
  )

  it.each(WRITES)(
    'not_project_member on %s shows the not-found state and no toast',
    async (write) => {
      await failWrite(write, 'not_project_member')
      expect(await screen.findByText(NOT_FOUND)).toBeInTheDocument()
      expect(screen.queryByTestId('discuss-board')).not.toBeInTheDocument()
      expect(screen.queryByText(/^Could not/)).not.toBeInTheDocument()
    },
  )

  it('not_project_member from get_cycle_actions shows the not-found state', async () => {
    setup()
    actionsMock.fetchCycleActions.mockRejectedValue(
      new ActionApiError('not_project_member'),
    )
    expect(
      await screen.findByText(NOT_FOUND, {}, { timeout: 5000 }),
    ).toBeInTheDocument()
  })

  it.each([
    ['edit', 'not_action_editor'],
    ['delete', 'not_action_editor'],
    ['status', 'not_action_owner'],
  ] as const)(
    '%s / %s hides the facilitator controls and re-reads the members',
    async (write, code) => {
      const theirs = action('Theirs')
      setup({ actions: actionsOf([theirs]) })
      await ready()
      const error = new ActionApiError(code)
      actionsMock.updateAction.mockRejectedValue(error)
      actionsMock.deleteAction.mockRejectedValue(error)
      actionsMock.setActionStatus.mockRejectedValue(error)
      const members = deferred<ProjectMember[]>()
      membersMock.fetchProjectMembers.mockReturnValue(members.promise)
      const before = membersMock.fetchProjectMembers.mock.calls.length
      if (write === 'edit') {
        fireEvent.click(
          screen.getByRole('button', { name: 'Edit action: Theirs' }),
        )
        fireEvent.click(saveOf(editForm('Theirs')))
      } else if (write === 'delete') {
        fireEvent.click(
          screen.getByRole('button', { name: 'Delete action: Theirs' }),
        )
        fireEvent.click(
          within(confirmGroup()).getByRole('button', { name: 'Delete' }),
        )
      } else {
        fireEvent.click(
          screen.getByRole('button', { name: 'Mark done: Theirs' }),
        )
      }
      expect(
        await screen.findByText(actionErrorMessage(code, write) ?? ''),
      ).toBeInTheDocument()
      await waitFor(() => {
        expect(
          within(actionItem('Theirs')).queryAllByRole('button'),
        ).toHaveLength(0)
      })
      expect(membersMock.fetchProjectMembers.mock.calls.length).toBeGreaterThan(
        before,
      )
      await act(async () => {
        members.resolve(asMember)
        await members.promise
      })
      expect(
        within(actionItem('Theirs')).queryAllByRole('button'),
      ).toHaveLength(0)
    },
  )

  it('invalid_action_owner re-reads the members', async () => {
    setup()
    await ready()
    actionsMock.createAction.mockRejectedValue(
      new ActionApiError('invalid_action_owner'),
    )
    const before = membersMock.fetchProjectMembers.mock.calls.length
    fireEvent.click(addButton())
    fill(addForm(), { description: 'x', owner: DAN })
    fireEvent.click(saveOf(addForm()))
    expect(
      await screen.findByText(
        'Choose an owner who is a member of this project.',
      ),
    ).toBeInTheDocument()
    await waitFor(() => {
      expect(membersMock.fetchProjectMembers.mock.calls.length).toBeGreaterThan(
        before,
      )
    })
  })
})

describe('refetches', () => {
  it("another member's action leaves every open form's input and focus untouched and announces nothing", async () => {
    const own = mine('Mine')
    setup({ members: asMember, actions: actionsOf([own]) })
    await ready()
    fireEvent.click(addButton())
    fill(addForm(), { description: 'half written', owner: DAN })
    fireEvent.click(screen.getByRole('button', { name: 'Edit action: Mine' }))
    fill(editForm('Mine'), { description: 'Mine, edited' })
    field(addForm(), 'Description').focus()

    serverActions([own, action('New from Bob')])
    act(() => {
      cyclesMock.emitCycleEvent(CYCLE_ID)
    })
    expect(await screen.findByText('New from Bob')).toBeInTheDocument()
    expect(field(addForm(), 'Description')).toHaveValue('half written')
    expect(field(addForm(), 'Owner')).toHaveValue(DAN)
    expect(field(addForm(), 'Description')).toHaveFocus()
    expect(field(editForm('Mine'), 'Description')).toHaveValue('Mine, edited')
    expect(statusRegion()).toHaveTextContent('')
  })

  it('a refetch that removes the action being edited closes the form, toasts, and focuses Add', async () => {
    const own = mine('Going away')
    setup({ members: asMember, actions: actionsOf([own]) })
    await ready()
    fireEvent.click(
      screen.getByRole('button', { name: 'Edit action: Going away' }),
    )
    expect(field(editForm('Going away'), 'Description')).toHaveFocus()
    serverActions([])
    await refetchActions()
    expect(
      await screen.findByText(ACTION_DELETED_ELSEWHERE_MESSAGE),
    ).toBeInTheDocument()
    expect(
      screen.queryByRole('form', { name: 'Editing action: Going away' }),
    ).toBeNull()
    await waitFor(() => {
      expect(addButton()).toHaveFocus()
    })
  })

  it('a members re-read that drops the chosen owner resets only the Owner select', async () => {
    setup()
    await ready()
    fireEvent.click(addButton())
    fill(addForm(), {
      description: 'keep',
      owner: DAN,
      due: '2026-11-20',
      topic: DOCS.clusterId,
    })
    membersMock.fetchProjectMembers.mockResolvedValue([
      memberRow({ role: 'facilitator', isOwner: true }),
    ])
    await refetchMembers()
    await waitFor(() => {
      expect(field(addForm(), 'Owner')).toHaveValue('')
    })
    expect(optionTexts(field(addForm(), 'Owner'))).toEqual([
      'Choose an owner',
      'Dev User (you)',
    ])
    expect(field(addForm(), 'Description')).toHaveValue('keep')
    expect(field(addForm(), 'Due date (optional)')).toHaveValue('2026-11-20')
    expect(field(addForm(), 'Related topic')).toHaveValue(DOCS.clusterId)
  })

  it("another member's status change updates the view and announces nothing", async () => {
    const theirs = action('Theirs')
    setup({ members: asMember, actions: actionsOf([theirs]) })
    await ready()
    serverActions([{ ...theirs, status: 'done', completedAt: T }])
    await refetchActions()
    await waitFor(() => {
      expect(lines(actionItem('Theirs'))[4]).toBe('Status: Done')
    })
    expect(statusRegion()).toHaveTextContent('')
  })

  it("with Realtime unavailable, the actions are re-read on the board's 4 s poll", async () => {
    setup()
    await ready()
    await waitFor(() => {
      expect(cyclesMock.activeCycleEventsSubscriptions()).toHaveLength(1)
    })
    vi.useFakeTimers({
      toFake: [
        'Date',
        'setTimeout',
        'clearTimeout',
        'setInterval',
        'clearInterval',
      ],
    })
    act(() => {
      cyclesMock.emitCycleEventsStatus(CYCLE_ID, 'CHANNEL_ERROR')
    })
    expect(screen.getByText(LIVE_NOTICE)).toBeInTheDocument()
    const before = actionsMock.fetchCycleActions.mock.calls.length
    await act(async () => {
      await vi.advanceTimersByTimeAsync(4000)
    })
    expect(actionsMock.fetchCycleActions.mock.calls.length).toBe(before + 1)
    await act(async () => {
      await vi.advanceTimersByTimeAsync(4000)
    })
    expect(actionsMock.fetchCycleActions.mock.calls.length).toBe(before + 2)
  })
})

describe('states', () => {
  it('shows Loading action items… in the section while the agenda and notes render', async () => {
    const pending = deferred<CycleActions>()
    setup()
    actionsMock.fetchCycleActions.mockReturnValue(pending.promise)
    expect(
      await screen.findByText(ACTIONS_LOADING, {}, { timeout: 5000 }),
    ).toHaveAttribute('role', 'status')
    expect(
      await screen.findByRole('list', { name: 'Agenda' }),
    ).toBeInTheDocument()
    expect(
      screen.getByRole('heading', { level: 3, name: 'General notes (0)' }),
    ).toBeInTheDocument()
    await act(async () => {
      pending.resolve(actionsOf([action('Loaded')]))
      await pending.promise
    })
    expect(await screen.findByText('Loaded')).toBeInTheDocument()
  })

  it('a failed load shows the alert; Retry re-reads and then renders the list; the agenda still renders', async () => {
    setup()
    actionsMock.fetchCycleActions.mockRejectedValue(
      new ActionApiError('unknown'),
    )
    const alert = await screen.findByRole('alert', {}, { timeout: 5000 })
    expect(alert).toHaveTextContent(ACTIONS_LOAD_ERROR)
    expect(screen.getByRole('list', { name: 'Agenda' })).toBeInTheDocument()
    const before = actionsMock.fetchCycleActions.mock.calls.length
    serverActions([action('Back')])
    fireEvent.click(within(alert).getByRole('button', { name: 'Retry' }))
    expect(await screen.findByText('Back')).toBeInTheDocument()
    expect(actionsMock.fetchCycleActions.mock.calls.length).toBe(before + 1)
  })

  it.each([
    [
      'an unknown cluster_id',
      [action('Lost', { clusterId: '99999999-0000-4000-8000-000000000000' })],
    ],
    [
      'a repeated action_id',
      [
        action('One', { actionId: 'same' }),
        action('Two', { actionId: 'same' }),
      ],
    ],
  ])('%s shows the load error', async (_label, actions) => {
    setup({ actions: actionsOf(actions) })
    const alert = await screen.findByRole('alert', {}, { timeout: 5000 })
    expect(alert).toHaveTextContent(ACTIONS_LOAD_ERROR)
  })

  it('zero clusters show the section with only No related topic, and creating works', async () => {
    setup({ board: boardOf('discuss', []) })
    await ready()
    fireEvent.click(addButton())
    expect(optionTexts(field(addForm(), 'Related topic'))).toEqual([
      'No related topic',
    ])
    actionsMock.createAction.mockResolvedValue('n')
    serverActions([mine('Topicless')])
    fill(addForm(), { description: 'Topicless', owner: ME })
    fireEvent.click(saveOf(addForm()))
    await waitFor(() => {
      expect(actionsMock.createAction).toHaveBeenCalledTimes(1)
    })
    expect(
      await screen.findByText('Topicless', {}, { timeout: 5000 }),
    ).toBeInTheDocument()
    expect(actionsMock.createAction).toHaveBeenCalledWith(CYCLE_ID, {
      description: 'Topicless',
      ownerId: ME,
      dueDate: null,
      clusterId: null,
    })
  })
})

describe('rendering', () => {
  it('Deleted account, HTML-like text as text, long words and a long topic wrap, and an extraction action renders like a manual one', async () => {
    const longTopic: BoardCluster = { ...TOOLS, name: 'N'.repeat(100) }
    const clusters = [PROCESS, longTopic, DOCS]
    const longWord = 'x'.repeat(500)
    const extracted = action('Extracted', {
      source: 'extraction',
      ownerId: ME,
      ownerName: 'Dev User',
      ownerIsMe: true,
    })
    setup({
      board: boardOf('discuss', clusters),
      actions: actionsOf([
        action('Orphan', { ownerId: null, ownerName: null }),
        action('<b>bold</b><script>alert(1)</script>'),
        action(longWord, { clusterId: longTopic.clusterId }),
        extracted,
      ]),
    })
    await ready()
    expect(lines(actionItem('Orphan'))[1]).toBe('Owner: Deleted account')
    expect(
      actionItem('<b>bold</b><script>alert(1)</script>').querySelector(
        'b, script',
      ),
    ).toBeNull()
    const long = actionItem(longWord)
    expect(long.querySelector('p')?.className).toContain(
      '[overflow-wrap:anywhere]',
    )
    expect(lines(long)[3]).toBe(`Topic: ${'N'.repeat(100)}`)
    expect(long.querySelector('div')?.className).toContain(
      '[overflow-wrap:anywhere]',
    )
    expect(lines(actionItem('Extracted'))).toEqual([
      'Extracted',
      'Owner: Dev User (you)',
      'No due date',
      'No related topic',
      'Status: Open',
    ])
    expect(
      within(actionItem('Extracted'))
        .getAllByRole('button')
        .map((b) => b.textContent),
    ).toEqual(['Mark done', 'Edit', 'Delete'])
  })
})

describe('stage gating', () => {
  it.each(['collecting', 'reveal', 'cluster', 'vote', 'closed'] as const)(
    'never calls get_cycle_actions in %s and renders no action section or form',
    async (status) => {
      setup({ board: boardOf(status) })
      await screen.findByRole('heading', { level: 2 }, { timeout: 5000 })
      await waitFor(() => {
        expect(membersMock.fetchProjectMembers).toHaveBeenCalled()
      })
      act(() => {
        cyclesMock.emitCycleEvent(CYCLE_ID)
      })
      await act(async () => {
        await queryClient.invalidateQueries()
      })
      expect(actionsMock.fetchCycleActions).not.toHaveBeenCalled()
      expect(
        screen.queryByRole('heading', { name: /^Action items/ }),
      ).toBeNull()
      expect(
        screen.queryByRole('button', { name: 'Add action item' }),
      ).toBeNull()
      expect(screen.queryByRole('form', { name: /action/i })).toBeNull()
    },
  )
})

describe('leaving discuss', () => {
  async function toClosed() {
    boardMock.fetchCycleBoard.mockResolvedValue(boardOf('closed'))
    await act(async () => {
      await queryClient.invalidateQueries({ queryKey: ['cycle-board'] })
    })
    await screen.findByRole('heading', { level: 2, name: 'Closed' })
  }

  it('a refetch to closed while a form holds a draft removes discuss mode with no error', async () => {
    setup()
    await ready()
    fireEvent.click(addButton())
    fill(addForm(), { description: 'unsent' })
    await toClosed()
    expect(screen.queryByTestId('discuss-board')).not.toBeInTheDocument()
    expect(screen.queryByRole('form')).toBeNull()
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('a pending create that then fails with cycle_not_discussing shows only its toast', async () => {
    setup()
    await ready()
    const pending = deferred<string>()
    actionsMock.createAction.mockReturnValue(pending.promise)
    fireEvent.click(addButton())
    fill(addForm(), { description: 'late', owner: ME })
    fireEvent.click(saveOf(addForm()))
    await waitFor(() => {
      expect(actionsMock.createAction).toHaveBeenCalledTimes(1)
    })
    await toClosed()
    await act(async () => {
      pending.reject(new ActionApiError('cycle_not_discussing'))
      await pending.promise.catch(() => undefined)
    })
    expect(
      await screen.findByText(
        'Action items can only be added during the Discuss stage.',
      ),
    ).toBeInTheDocument()
    expect(liveTexts().filter((text) => text.startsWith('Action'))).toEqual([])
    expect(screen.queryByText(NOT_FOUND)).toBeNull()
  })

  it('a pending create that resolves after the change announces nothing and moves no focus', async () => {
    setup()
    await ready()
    const pending = deferred<string>()
    actionsMock.createAction.mockReturnValue(pending.promise)
    fireEvent.click(addButton())
    fill(addForm(), { description: 'late', owner: ME })
    fireEvent.click(saveOf(addForm()))
    await waitFor(() => {
      expect(actionsMock.createAction).toHaveBeenCalledTimes(1)
    })
    await toClosed()
    const back = screen.getByRole('link', { name: 'Back to project' })
    back.focus()
    await act(async () => {
      pending.resolve('n')
      await pending.promise
    })
    expect(back).toHaveFocus()
    expect(liveTexts().filter((text) => text.startsWith('Action'))).toEqual([])
  })
})

describe('role change', () => {
  it("losing the role with focus on Edit of another member's action hides the facilitator controls and focuses the Action items h3", async () => {
    const theirs = action('Theirs')
    const own = mine('Mine')
    setup({ actions: actionsOf([theirs, own]) })
    await ready()
    screen.getByRole('button', { name: 'Edit action: Theirs' }).focus()
    membersMock.fetchProjectMembers.mockResolvedValue(asMember)
    await refetchMembers()
    await waitFor(() => {
      expect(
        within(actionItem('Theirs')).queryAllByRole('button'),
      ).toHaveLength(0)
    })
    expect(
      within(actionItem('Mine'))
        .getAllByRole('button')
        .map((b) => b.textContent),
    ).toEqual(['Mark done', 'Edit', 'Delete'])
    await waitFor(() => {
      expect(
        screen.getByRole('heading', { level: 3, name: 'Action items (2)' }),
      ).toHaveFocus()
    })
  })

  it('with focus elsewhere, focus does not move', async () => {
    setup({ actions: actionsOf([action('Theirs')]) })
    await ready()
    const add = addButton()
    add.focus()
    membersMock.fetchProjectMembers.mockResolvedValue(asMember)
    await refetchMembers()
    await waitFor(() => {
      expect(
        within(actionItem('Theirs')).queryAllByRole('button'),
      ).toHaveLength(0)
    })
    expect(add).toHaveFocus()
  })
})

describe('privacy and sameness', () => {
  it('no action control or text is inside any card', async () => {
    setup({
      actions: actionsOf([
        action('An action', { clusterId: PROCESS.clusterId }),
      ]),
    })
    await ready()
    for (const card of screen
      .getByTestId('discuss-board')
      .querySelectorAll('[data-card-id]')) {
      expect(
        card.querySelector('[data-action-id], [data-action-focus], form'),
      ).toBeNull()
      expect(card.textContent).not.toMatch(/Action|Owner:|Due |Mark done/)
    }
  })

  it('the facilitator, the owner who is not the facilitator, and a member get the same DOM except the role-only parts', async () => {
    // Created by someone else and owned by Dan: no ` (you)`, owner toggle,
    // or creator controls for any of the three viewers.
    const actions = actionsOf([
      action('Shared one', {
        dueDate: '2026-11-12',
        clusterId: DOCS.clusterId,
      }),
      action('Shared two', { status: 'done', completedAt: T }),
    ])
    const html: string[] = []
    for (const members of [asFacilitator, asOwnerNotFacilitator, asMember]) {
      const view = setup({ members, actions })
      await ready()
      const shared = section().cloneNode(true) as HTMLElement
      for (const element of shared.querySelectorAll(
        '[data-action-facilitator-control]',
      )) {
        element.remove()
      }
      html.push(shared.outerHTML)
      view.unmount()
      queryClient.clear()
      membersMock.fetchProjectMembers.mockClear()
    }
    expect(html[1]).toBe(html[0])
    expect(html[2]).toBe(html[0])
  })

  it('no toast or announcement carries card text or a card author', async () => {
    const own = mine('Mine', { clusterId: PROCESS.clusterId })
    setup({ members: asMember, actions: actionsOf([own]) })
    await ready()
    actionsMock.setActionStatus.mockResolvedValue(undefined)
    serverActions([{ ...own, status: 'done', completedAt: T }])
    fireEvent.click(screen.getByRole('button', { name: 'Mark done: Mine' }))
    await waitFor(() => {
      expect(statusRegion()).toHaveTextContent('Action item marked done.')
    })
    actionsMock.createAction.mockRejectedValue(
      new ActionApiError('cluster_not_found'),
    )
    fireEvent.click(addButton())
    fill(addForm(), { description: 'x', owner: ME, topic: PROCESS.clusterId })
    fireEvent.click(saveOf(addForm()))
    await screen.findByText('This cluster no longer exists.')
    const outputs = [
      ...screen.queryAllByRole('alert'),
      ...screen.getAllByRole('status'),
      ...document.querySelectorAll('[data-sonner-toast]'),
    ]
    for (const output of outputs) {
      for (const word of CARD_WORDS) {
        expect(output.textContent ?? '').not.toContain(word)
      }
    }
  })
})
