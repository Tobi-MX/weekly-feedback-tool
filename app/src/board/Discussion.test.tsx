import { act, fireEvent, screen, waitFor, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { CycleDetail } from '../cycles/cyclesApi'
import type { CycleStatus } from '../cycles/cycleStatus'
import { queryClient } from '../lib/queryClient'
import type { ProjectMember } from '../projects/membersApi'
import { deferred, mockRestoredSession } from '../test/authMock'
import { boardMock } from '../test/boardMock'
import { cyclesMock } from '../test/cyclesMock'
import { actionsMock } from '../test/actionsMock'
import { discussionMock } from '../test/discussionMock'
import { membersMock } from '../test/membersMock'
import { profileMock } from '../test/profileMock'
import { renderApp } from '../test/renderApp'
import { votesMock } from '../test/votesMock'
import type { BoardCard, BoardCluster, CycleBoard } from './boardApi'
import type {
  CycleDiscussion,
  DiscussionNote,
  DiscussionStatus,
} from './discussionApi'
import {
  DiscussionApiError,
  discussionErrorMessage,
  type DiscussionErrorCode,
} from './discussionErrors'
import {
  DISCUSSION_LOAD_ERROR,
  NO_TOPICS,
  RESULTS_LOAD_ERROR,
  RESULTS_LOADING,
} from './DiscussMode'
import {
  DELETE_NOTE_QUESTION,
  EMPTY_NOTE_MESSAGE,
  NOTE_DELETED_ELSEWHERE_MESSAGE,
  NOTE_TOO_LONG_MESSAGE,
  NOTES_HINT,
} from './TopicNotes'
import type { VoteTotal } from './voteTotalsApi'

const CYCLE_ID = '30000000-0000-4000-8000-000000000001'
const PROJECT_ID = '10000000-0000-4000-8000-000000000001'
const PATH = `/cycles/${CYCLE_ID}/board`
const NOT_FOUND = 'Cycle not found or you do not have access.'
const LIVE_NOTICE =
  'Live updates are unavailable. The board refreshes every few seconds.'

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

// The totals' order: Docs, Process, Tools (not board order, not by name).
const TOTALS: VoteTotal[] = [
  { clusterId: DOCS.clusterId, totalVotes: 3 },
  { clusterId: PROCESS.clusterId, totalVotes: 2 },
  { clusterId: TOOLS.clusterId, totalVotes: 1 },
]
const ORDER = ['Docs (0)', 'Process (2)', 'Tools (0) AI suggestion']

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

let noteSeq = 0
function note(
  clusterId: string | null,
  text: string,
  overrides: Partial<DiscussionNote> = {},
): DiscussionNote {
  noteSeq += 1
  return {
    noteId: `e0000000-0000-4000-8000-${String(noteSeq).padStart(12, '0')}`,
    clusterId,
    text,
    authorName: 'Bob',
    isMine: false,
    createdAt: '2026-11-03T12:00:00Z',
    editedAt: null,
    ...overrides,
  }
}

function mine(clusterId: string | null, text: string): DiscussionNote {
  return note(clusterId, text, { authorName: 'Dev User', isMine: true })
}

function discussionOf(
  notes: readonly DiscussionNote[] = [],
  statuses: Partial<Record<string, DiscussionStatus>> = {},
  clusters: readonly BoardCluster[] = CLUSTERS,
): CycleDiscussion {
  return {
    cycleId: CYCLE_ID,
    statuses: clusters.map((cluster) => ({
      clusterId: cluster.clusterId,
      discussionStatus: statuses[cluster.clusterId] ?? 'pending',
    })),
    notes,
  }
}

function memberRow(overrides: Partial<ProjectMember>): ProjectMember {
  return {
    userId: 'user-1',
    displayName: 'Dev User',
    role: 'member',
    isOwner: false,
    isMe: true,
    joinedAt: '2026-10-30T12:00:00.000Z',
    ...overrides,
  }
}

const asFacilitator = [memberRow({ role: 'facilitator', isOwner: true })]
const asMember = [
  memberRow({}),
  memberRow({
    userId: 'user-2',
    displayName: 'Fac',
    role: 'facilitator',
    isMe: false,
    isOwner: true,
  }),
]
const asOwnerNotFacilitator = [
  memberRow({ isOwner: true }),
  memberRow({
    userId: 'user-2',
    displayName: 'Fac',
    role: 'facilitator',
    isMe: false,
  }),
]

interface SetupOptions {
  readonly board?: CycleBoard
  readonly members?: ProjectMember[]
  readonly discussion?: CycleDiscussion
}

function setup(options: SetupOptions = {}) {
  mockRestoredSession('dev@example.com', 'user-1')
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
  discussionMock.fetchDiscussion.mockResolvedValue(
    options.discussion ?? discussionOf([], {}, board.clusters),
  )
  // #26: discuss mode also reads the action items (none).
  actionsMock.fetchCycleActions.mockResolvedValue({
    cycleId: CYCLE_ID,
    actions: [],
  })
  return renderApp({ initialEntries: [PATH] })
}

function serverDiscussion(discussion: CycleDiscussion) {
  discussionMock.fetchDiscussion.mockResolvedValue(discussion)
}

async function refetchDiscussion(): Promise<void> {
  await act(async () => {
    await queryClient.invalidateQueries({ queryKey: ['cycle-discussion'] })
  })
}

async function agenda(): Promise<HTMLElement> {
  return screen.findByRole('list', { name: 'Agenda' }, { timeout: 5000 })
}

/** The agenda and, for the facilitator, the status groups. */
async function ready(facilitator = true): Promise<HTMLElement> {
  const list = await agenda()
  await waitFor(() => {
    expect(membersMock.fetchProjectMembers).toHaveBeenCalled()
  })
  if (facilitator) {
    await screen.findByRole('group', { name: 'Discussion status for Docs' })
  }
  return list
}

function topics(list: HTMLElement): HTMLElement[] {
  return within(list)
    .getAllByRole('listitem')
    .filter((item) => item.parentElement === list)
}

function topic(name: string): HTMLElement {
  const heading = screen
    .getAllByRole('heading', { level: 3 })
    .find((h) =>
      (h.querySelector('[data-cluster-name]')?.textContent ?? '').startsWith(
        `${name} (`,
      ),
    )
  const item = heading?.closest('li')
  if (!item) {
    throw new Error(`no topic ${name}`)
  }
  return item
}

/** The topic's `Status: {Label}` line. */
function statusLine(item: HTMLElement): string {
  const line = [...item.querySelectorAll('p')].find((p) =>
    (p.textContent ?? '').startsWith('Status: '),
  )
  return line?.textContent ?? ''
}

function topicHeading(item: HTMLElement): string {
  return (
    within(item).getByRole('heading', { level: 3 }).textContent ?? ''
  ).trim()
}

function generalSection(): HTMLElement {
  const section = screen
    .getByRole('heading', { level: 3, name: /^General notes \(\d+\)$/ })
    .closest('section')
  if (!section) {
    throw new Error('no General notes')
  }
  return section
}

function statusGroups(): HTMLElement[] {
  return screen.queryAllByRole('group', { name: /^Discussion status for / })
}

function statusButton(topicName: string, label: string): HTMLElement {
  return within(
    screen.getByRole('group', { name: `Discussion status for ${topicName}` }),
  ).getByRole('button', { name: label })
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

function addButton(name: string): HTMLElement {
  return screen.getByRole('button', {
    name: name === 'general' ? 'Add a general note' : `Add note to ${name}`,
  })
}

function textarea(label: string): HTMLTextAreaElement {
  return screen.getByLabelText(label, {
    selector: 'textarea',
  })
}

function saveButtonOf(field: HTMLElement): HTMLElement {
  const form = field.closest('form')
  if (!form) {
    throw new Error('no form')
  }
  return within(form).getByRole('button', { name: /^(Save note|Saving…)$/ })
}

function noteItem(text: string): HTMLElement {
  const item = screen
    .getAllByRole('listitem')
    .find(
      (li) =>
        li.hasAttribute('data-note-id') &&
        li.querySelector('p')?.textContent === text,
    )
  if (!item) {
    throw new Error(`no note ${text}`)
  }
  return item
}

function type(field: HTMLElement, value: string) {
  fireEvent.change(field, { target: { value } })
}

afterEach(() => {
  vi.useRealTimers()
})

describe('layout', () => {
  it("keeps #24's content and order and adds the status line, notes block, and Add note; General notes sits between the list and Ungrouped", async () => {
    const processNote = note(PROCESS.clusterId, 'Pair on reviews')
    const general = note(null, 'Thanks all')
    setup({
      members: asMember,
      discussion: discussionOf([processNote, general], {
        [DOCS.clusterId]: 'discussed',
        [PROCESS.clusterId]: 'skipped',
        [TOOLS.clusterId]: 'deferred',
      }),
    })
    const list = await ready(false)

    const items = topics(list)
    expect(items.map(topicHeading)).toEqual(ORDER)
    expect(items.map((item) => statusLine(item))).toEqual([
      'Status: Discussed',
      'Status: Skipped',
      'Status: Deferred',
    ])
    const process = items[1]
    const order = [
      within(process).getByRole('heading', { level: 3 }),
      within(process).getByText('2 votes'),
      [...process.querySelectorAll('p')].find((p) =>
        (p.textContent ?? '').startsWith('Status: '),
      ) as HTMLElement,
      within(process).getByRole('list', { name: 'Cards in Process' }),
      within(process).getByRole('heading', { level: 4, name: 'Notes (1)' }),
      within(process).getByText('Pair on reviews'),
      within(process).getByRole('button', { name: 'Add note to Process' }),
    ]
    for (let index = 1; index < order.length; index += 1) {
      expect(
        order[index - 1].compareDocumentPosition(order[index]) &
          Node.DOCUMENT_POSITION_FOLLOWING,
      ).toBeTruthy()
    }
    expect(within(items[0]).getByText('No notes yet.')).toBeInTheDocument()
    expect(
      within(items[0]).getByRole('heading', { level: 4, name: 'Notes (0)' }),
    ).toBeInTheDocument()

    const generalBlock = generalSection()
    expect(
      within(generalBlock).getByRole('heading', {
        level: 3,
        name: 'General notes (1)',
      }),
    ).toBeInTheDocument()
    expect(within(generalBlock).getByText('Thanks all')).toBeInTheDocument()
    expect(
      within(generalBlock).getByRole('button', { name: 'Add a general note' }),
    ).toBeInTheDocument()
    const ungrouped = screen
      .getByRole('heading', { level: 3, name: 'Ungrouped (1)' })
      .closest('section')
    expect(
      list.compareDocumentPosition(generalBlock) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy()
    expect(
      generalBlock.compareDocumentPosition(ungrouped as Node) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy()
    expect(discussionMock.fetchDiscussion).toHaveBeenCalledWith(CYCLE_ID)
  })

  it('an empty General notes block says so', async () => {
    setup()
    await ready()
    expect(
      within(generalSection()).getByText('No general notes yet.'),
    ).toBeInTheDocument()
  })
})

describe('status groups', () => {
  it('the facilitator gets one group per topic with four buttons; only the current one is pressed', async () => {
    setup({
      discussion: discussionOf([], { [PROCESS.clusterId]: 'deferred' }),
    })
    await ready()

    expect(statusGroups()).toHaveLength(3)
    const group = screen.getByRole('group', {
      name: 'Discussion status for Process',
    })
    const buttons = within(group).getAllByRole('button')
    expect(buttons.map((button) => button.textContent)).toEqual([
      'Pending',
      'Discussed',
      'Skipped',
      'Deferred',
    ])
    expect(
      buttons.map((button) => button.getAttribute('aria-pressed')),
    ).toEqual(['false', 'false', 'false', 'true'])
    expect(
      within(screen.getByRole('group', { name: 'Discussion status for Docs' }))
        .getAllByRole('button')
        .map((button) => button.getAttribute('aria-pressed')),
    ).toEqual(['true', 'false', 'false', 'false'])
  })

  it.each([
    ['a member', asMember],
    ['the owner who is not the facilitator', asOwnerNotFacilitator],
  ])('%s gets no status group but the status line', async (_label, members) => {
    setup({ members })
    const list = await ready(false)
    expect(statusGroups()).toHaveLength(0)
    expect(topics(list).map((item) => statusLine(item))).toEqual([
      'Status: Pending',
      'Status: Pending',
      'Status: Pending',
    ])
  })

  it('while the members query is loading or has failed, no status group renders', async () => {
    const members = deferred<ProjectMember[]>()
    membersMock.fetchProjectMembers.mockReturnValue(members.promise)
    mockRestoredSession('dev@example.com', 'user-1')
    profileMock.fetchProfileDisplayName.mockResolvedValue('Dev User')
    cyclesMock.fetchCycle.mockResolvedValue(cycle)
    boardMock.fetchCycleBoard.mockResolvedValue(boardOf())
    votesMock.fetchVoteTotals.mockResolvedValue(TOTALS)
    discussionMock.fetchDiscussion.mockResolvedValue(discussionOf())
    renderApp({ initialEntries: [PATH] })
    await agenda()
    expect(statusGroups()).toHaveLength(0)
    expect(
      screen
        .getAllByRole('listitem')
        .filter((li) => li.querySelector('h3'))
        .map(statusLine),
    ).toEqual(['Status: Pending', 'Status: Pending', 'Status: Pending'])

    await act(async () => {
      members.reject(new Error('down'))
      await members.promise.catch(() => undefined)
    })
    expect(statusGroups()).toHaveLength(0)
    expect(
      screen
        .getAllByRole('listitem')
        .filter((li) => li.querySelector('h3'))
        .map(statusLine),
    ).toEqual(['Status: Pending', 'Status: Pending', 'Status: Pending'])
  })
})

describe('status write', () => {
  it('sends once, disables every status button while pending, then shows, announces, and keeps focus and order', async () => {
    setup()
    const list = await ready()
    const pending = deferred<undefined>()
    discussionMock.setDiscussionStatus.mockReturnValue(pending.promise)

    const skipped = statusButton('Process', 'Skipped')
    skipped.focus()
    fireEvent.click(skipped)
    fireEvent.click(skipped)
    fireEvent.keyDown(skipped, { key: 'Enter' })
    fireEvent.click(statusButton('Docs', 'Discussed'))

    await waitFor(() => {
      expect(discussionMock.setDiscussionStatus).toHaveBeenCalledTimes(1)
    })
    expect(discussionMock.setDiscussionStatus).toHaveBeenCalledWith(
      PROCESS.clusterId,
      'skipped',
    )
    await waitFor(() => {
      for (const group of statusGroups()) {
        for (const button of within(group).getAllByRole('button')) {
          expect(button).toHaveAttribute('aria-disabled', 'true')
        }
      }
    })

    serverDiscussion(discussionOf([], { [PROCESS.clusterId]: 'skipped' }))
    await act(async () => {
      pending.resolve(undefined)
      await pending.promise
    })

    await waitFor(() => {
      expect(statusRegion()).toHaveTextContent('Process marked Skipped.')
    })
    expect(statusLine(topic('Process'))).toBe('Status: Skipped')
    expect(statusButton('Process', 'Skipped')).toHaveAttribute(
      'aria-pressed',
      'true',
    )
    expect(statusButton('Process', 'Skipped')).toHaveFocus()
    expect(topics(list).map(topicHeading)).toEqual(ORDER)
    expect(liveTexts().filter((text) => text.includes('marked'))).toEqual([
      'Process marked Skipped.',
    ])
    expect(statusButton('Process', 'Pending')).not.toHaveAttribute(
      'aria-disabled',
    )
  })

  it('pressing the already-pressed button sends nothing', async () => {
    setup({ discussion: discussionOf([], { [TOOLS.clusterId]: 'deferred' }) })
    await ready()
    fireEvent.click(statusButton('Tools', 'Deferred'))
    fireEvent.click(statusButton('Docs', 'Pending'))
    expect(discussionMock.setDiscussionStatus).not.toHaveBeenCalled()
  })
})

describe('add', () => {
  it('opens a labelled form with focus, sends the trimmed text once, then shows the note, announces, and focuses Add note', async () => {
    setup({ members: asMember })
    await ready(false)

    fireEvent.click(addButton('Process'))
    const field = textarea('Note on Process')
    expect(field).toHaveFocus()
    expect(field).toHaveAccessibleDescription(NOTES_HINT)
    expect(field).not.toHaveAttribute('maxlength')

    const pending = deferred<string>()
    discussionMock.addNote.mockReturnValue(pending.promise)
    type(field, '  hello\nworld  ')
    const save = saveButtonOf(field)
    fireEvent.click(save)
    fireEvent.click(save)
    await waitFor(() => {
      expect(discussionMock.addNote).toHaveBeenCalledTimes(1)
    })
    expect(discussionMock.addNote).toHaveBeenCalledWith(
      CYCLE_ID,
      PROCESS.clusterId,
      'hello\nworld',
    )
    expect(
      await screen.findByRole('button', { name: 'Saving…' }),
    ).toBeInTheDocument()

    serverDiscussion(discussionOf([mine(PROCESS.clusterId, 'hello\nworld')]))
    await act(async () => {
      pending.resolve('new-note')
      await pending.promise
    })

    await waitFor(() => {
      expect(statusRegion()).toHaveTextContent('Note added to Process.')
    })
    const item = noteItem('hello\nworld')
    expect(item.querySelector('p')?.className).toContain('whitespace-pre-wrap')
    expect(within(item).getByText('Dev User (you)')).toBeInTheDocument()
    expect(
      within(topic('Process')).getByRole('heading', {
        level: 4,
        name: 'Notes (1)',
      }),
    ).toBeInTheDocument()
    expect(screen.queryByLabelText('Note on Process')).not.toBeInTheDocument()
    expect(addButton('Process')).toHaveFocus()
  })

  it('a general note works the same way', async () => {
    setup({ members: asMember })
    await ready(false)

    fireEvent.click(addButton('general'))
    const field = textarea('General note')
    expect(field).toHaveFocus()
    discussionMock.addNote.mockResolvedValue('g')
    serverDiscussion(discussionOf([mine(null, 'Good meeting')]))
    type(field, 'Good meeting')
    fireEvent.click(saveButtonOf(field))
    await waitFor(() => {
      expect(discussionMock.addNote).toHaveBeenCalledWith(
        CYCLE_ID,
        null,
        'Good meeting',
      )
    })

    await waitFor(() => {
      expect(statusRegion()).toHaveTextContent('General note added.')
    })
    expect(
      screen.getByRole('heading', { level: 3, name: 'General notes (1)' }),
    ).toBeInTheDocument()
    expect(addButton('general')).toHaveFocus()
  })

  it.each([
    ['whitespace only', ' \n\t ', EMPTY_NOTE_MESSAGE],
    ['2001 code points', '😀'.repeat(2001), NOTE_TOO_LONG_MESSAGE],
  ])(
    '%s shows its alert, keeps the text, and sends nothing',
    async (_label, text, message) => {
      setup({ members: asMember })
      await ready(false)
      fireEvent.click(addButton('Docs'))
      const field = textarea('Note on Docs')
      type(field, text)
      fireEvent.click(saveButtonOf(field))

      const alert = await screen.findByRole('alert')
      expect(alert).toHaveTextContent(message)
      expect(field.getAttribute('aria-describedby')?.split(' ')).toContain(
        alert.id,
      )
      expect(field).toHaveAttribute('aria-invalid', 'true')
      expect(field.value).toBe(text)
      expect(discussionMock.addNote).not.toHaveBeenCalled()
    },
  )

  it('exactly 2000 code points sends', async () => {
    setup({ members: asMember })
    await ready(false)
    fireEvent.click(addButton('Docs'))
    const field = textarea('Note on Docs')
    discussionMock.addNote.mockResolvedValue('n')
    type(field, '😀'.repeat(2000))
    fireEvent.click(saveButtonOf(field))
    await waitFor(() => {
      expect(discussionMock.addNote).toHaveBeenCalledWith(
        CYCLE_ID,
        DOCS.clusterId,
        '😀'.repeat(2000),
      )
    })
  })

  it('Escape and Cancel close the form, discard the draft, and send nothing', async () => {
    setup({ members: asMember })
    await ready(false)
    fireEvent.click(addButton('Docs'))
    type(textarea('Note on Docs'), 'draft one')
    fireEvent.keyDown(textarea('Note on Docs'), { key: 'Escape' })
    expect(screen.queryByLabelText('Note on Docs')).not.toBeInTheDocument()
    await waitFor(() => {
      expect(addButton('Docs')).toHaveFocus()
    })
    fireEvent.click(addButton('Docs'))
    expect(textarea('Note on Docs').value).toBe('')
    const form = textarea('Note on Docs').closest('form') as HTMLElement
    fireEvent.click(within(form).getByRole('button', { name: 'Cancel' }))
    expect(screen.queryByLabelText('Note on Docs')).not.toBeInTheDocument()
    expect(discussionMock.addNote).not.toHaveBeenCalled()
  })
})

describe('edit', () => {
  it('only own notes have Edit; it opens pre-filled, sends once, then shows (edited), announces, and focuses Edit', async () => {
    const own = mine(DOCS.clusterId, 'My first thought')
    const other = note(DOCS.clusterId, 'Someone else')
    setup({ members: asMember, discussion: discussionOf([own, other]) })
    await ready(false)

    expect(
      within(noteItem('Someone else')).queryByRole('button', { name: /^Edit/ }),
    ).not.toBeInTheDocument()
    fireEvent.click(
      screen.getByRole('button', { name: 'Edit note: My first thought' }),
    )
    const field = textarea('Edit note')
    expect(field).toHaveFocus()
    expect(field.value).toBe('My first thought')

    discussionMock.updateNote.mockResolvedValue(undefined)
    serverDiscussion(
      discussionOf([
        { ...own, text: 'My second thought', editedAt: '2026-11-03T12:05:00Z' },
        other,
      ]),
    )
    type(field, ' My second thought ')
    fireEvent.click(saveButtonOf(field))
    fireEvent.click(saveButtonOf(field))
    await waitFor(() => {
      expect(discussionMock.updateNote).toHaveBeenCalledTimes(1)
    })
    expect(discussionMock.updateNote).toHaveBeenCalledWith(
      own.noteId,
      'My second thought',
    )

    await waitFor(() => {
      expect(statusRegion()).toHaveTextContent('Note updated.')
    })
    expect(
      within(noteItem('My second thought')).getByText(
        'Dev User (you) (edited)',
      ),
    ).toBeInTheDocument()
    expect(
      screen.getByRole('button', { name: 'Edit note: My second thought' }),
    ).toHaveFocus()
  })

  it('Escape and Cancel discard the draft with no call', async () => {
    const own = mine(null, 'Keep me')
    setup({ members: asMember, discussion: discussionOf([own]) })
    await ready(false)
    const edit = () =>
      screen.getByRole('button', { name: 'Edit note: Keep me' })

    fireEvent.click(edit())
    type(textarea('Edit note'), 'changed')
    fireEvent.keyDown(textarea('Edit note'), { key: 'Escape' })
    await waitFor(() => {
      expect(edit()).toHaveFocus()
    })
    fireEvent.click(edit())
    expect(textarea('Edit note').value).toBe('Keep me')
    const form = textarea('Edit note').closest('form') as HTMLElement
    fireEvent.click(within(form).getByRole('button', { name: 'Cancel' }))
    expect(screen.queryByLabelText('Edit note')).not.toBeInTheDocument()
    expect(discussionMock.updateNote).not.toHaveBeenCalled()
  })
})

describe('delete', () => {
  it('a member sees Delete only on their own notes; the facilitator on every note', async () => {
    const notes = [mine(DOCS.clusterId, 'Mine'), note(DOCS.clusterId, 'Theirs')]
    const view = setup({ members: asMember, discussion: discussionOf(notes) })
    await ready(false)
    expect(
      within(noteItem('Mine')).getByRole('button', {
        name: 'Delete note: Mine',
      }),
    ).toBeInTheDocument()
    expect(
      within(noteItem('Theirs')).queryByRole('button', { name: /^Delete/ }),
    ).not.toBeInTheDocument()
    view.unmount()
    queryClient.clear()

    setup({ members: asFacilitator, discussion: discussionOf(notes) })
    await ready()
    expect(
      screen.getByRole('button', { name: 'Delete note: Theirs' }),
    ).toBeInTheDocument()
    expect(
      screen.getByRole('button', { name: 'Delete note: Mine' }),
    ).toBeInTheDocument()
  })

  it('confirms inline with focus on Cancel; Escape cancels; confirming sends once, then the note is gone, announced, and focus is on Add note', async () => {
    const own = mine(
      TOOLS.clusterId,
      'A long note that goes on for more than forty characters',
    )
    setup({ members: asMember, discussion: discussionOf([own]) })
    await ready(false)
    const deleteName = 'Delete note: A long note that goes on for more than f…'

    fireEvent.click(screen.getByRole('button', { name: deleteName }))
    const group = screen.getByRole('group', { name: DELETE_NOTE_QUESTION })
    const cancel = within(group).getByRole('button', { name: 'Cancel' })
    await waitFor(() => {
      expect(cancel).toHaveFocus()
    })
    fireEvent.keyDown(cancel, { key: 'Escape' })
    expect(
      screen.queryByRole('group', { name: DELETE_NOTE_QUESTION }),
    ).not.toBeInTheDocument()
    expect(discussionMock.deleteNote).not.toHaveBeenCalled()

    fireEvent.click(screen.getByRole('button', { name: deleteName }))
    const pending = deferred<undefined>()
    discussionMock.deleteNote.mockReturnValue(pending.promise)
    const confirm = within(
      screen.getByRole('group', { name: DELETE_NOTE_QUESTION }),
    ).getByRole('button', { name: 'Delete' })
    confirm.focus()
    fireEvent.click(confirm)
    fireEvent.click(confirm)
    await waitFor(() => {
      expect(discussionMock.deleteNote).toHaveBeenCalledTimes(1)
    })
    expect(discussionMock.deleteNote).toHaveBeenCalledWith(own.noteId)
    expect(
      await screen.findByRole('button', { name: 'Deleting…' }),
    ).toHaveAttribute('aria-disabled', 'true')

    serverDiscussion(discussionOf([]))
    await act(async () => {
      pending.resolve(undefined)
      await pending.promise
    })
    await waitFor(() => {
      expect(statusRegion()).toHaveTextContent('Note deleted.')
    })
    expect(
      screen.queryByRole('button', { name: deleteName }),
    ).not.toBeInTheDocument()
    expect(addButton('Tools')).toHaveFocus()
  })
})

describe('one note write at a time', () => {
  it('while an add is pending, other Save note and confirm Delete buttons are aria-disabled and send nothing; typing still works', async () => {
    const own = mine(DOCS.clusterId, 'Old note')
    setup({ members: asMember, discussion: discussionOf([own]) })
    await ready(false)
    fireEvent.click(addButton('Docs'))
    fireEvent.click(addButton('Tools'))
    fireEvent.click(
      screen.getByRole('button', { name: 'Delete note: Old note' }),
    )
    const pending = deferred<string>()
    discussionMock.addNote.mockReturnValue(pending.promise)

    type(textarea('Note on Docs'), 'first')
    fireEvent.click(saveButtonOf(textarea('Note on Docs')))
    await waitFor(() => {
      expect(discussionMock.addNote).toHaveBeenCalledTimes(1)
    })

    const otherField = textarea('Note on Tools')
    type(otherField, 'second')
    expect(otherField.value).toBe('second')
    const otherSave = saveButtonOf(otherField)
    await waitFor(() => {
      expect(otherSave).toHaveAttribute('aria-disabled', 'true')
    })
    fireEvent.click(otherSave)
    const confirm = within(
      screen.getByRole('group', { name: DELETE_NOTE_QUESTION }),
    ).getByRole('button', { name: 'Delete' })
    expect(confirm).toHaveAttribute('aria-disabled', 'true')
    fireEvent.click(confirm)
    expect(discussionMock.addNote).toHaveBeenCalledTimes(1)
    expect(discussionMock.deleteNote).not.toHaveBeenCalled()

    await act(async () => {
      pending.resolve('n')
      await pending.promise
    })
    await waitFor(() => {
      expect(saveButtonOf(textarea('Note on Tools'))).not.toHaveAttribute(
        'aria-disabled',
      )
    })
    expect(textarea('Note on Tools').value).toBe('second')
  })
})

describe('errors', () => {
  const STATUS_CODES: DiscussionErrorCode[] = [
    'not_project_facilitator',
    'not_note_author',
    'cycle_not_discussing',
    'cluster_not_found',
    'note_not_found',
    'invalid_note_text',
    'note_limit_reached',
    'invalid_discussion_status',
    'unknown',
  ]

  it.each(STATUS_CODES)(
    'status / %s shows its exact toast once and re-reads the discussion',
    async (code) => {
      setup()
      await ready()
      discussionMock.setDiscussionStatus.mockRejectedValue(
        new DiscussionApiError(code),
      )
      const before = discussionMock.fetchDiscussion.mock.calls.length
      fireEvent.click(statusButton('Docs', 'Skipped'))
      const message = discussionErrorMessage(code, 'status') ?? ''
      expect(await screen.findByText(message)).toBeInTheDocument()
      expect(screen.getAllByText(message)).toHaveLength(1)
      await waitFor(() => {
        expect(
          discussionMock.fetchDiscussion.mock.calls.length,
        ).toBeGreaterThan(before)
      })
      expect(statusRegion()).toHaveTextContent('')
    },
  )

  it.each(STATUS_CODES)(
    'add / %s shows its exact toast once and keeps the form with its text',
    async (code) => {
      setup({ members: asMember })
      await ready(false)
      discussionMock.addNote.mockRejectedValue(new DiscussionApiError(code))
      const before = discussionMock.fetchDiscussion.mock.calls.length
      fireEvent.click(addButton('Docs'))
      type(textarea('Note on Docs'), 'keep this')
      fireEvent.click(saveButtonOf(textarea('Note on Docs')))
      const message = discussionErrorMessage(code, 'add') ?? ''
      expect(await screen.findByText(message)).toBeInTheDocument()
      expect(screen.getAllByText(message)).toHaveLength(1)
      await waitFor(() => {
        expect(
          discussionMock.fetchDiscussion.mock.calls.length,
        ).toBeGreaterThan(before)
      })
      expect(textarea('Note on Docs').value).toBe('keep this')
    },
  )

  it.each(STATUS_CODES)(
    'edit / %s shows its exact toast once',
    async (code) => {
      const own = mine(DOCS.clusterId, 'Edit me')
      setup({ members: asMember, discussion: discussionOf([own]) })
      await ready(false)
      discussionMock.updateNote.mockRejectedValue(new DiscussionApiError(code))
      fireEvent.click(
        screen.getByRole('button', { name: 'Edit note: Edit me' }),
      )
      type(textarea('Edit note'), 'changed')
      fireEvent.click(saveButtonOf(textarea('Edit note')))
      const message = discussionErrorMessage(code, 'edit') ?? ''
      expect(await screen.findByText(message)).toBeInTheDocument()
      expect(screen.getAllByText(message)).toHaveLength(1)
      if (code === 'note_not_found') {
        await waitFor(() => {
          expect(screen.queryByLabelText('Edit note')).not.toBeInTheDocument()
        })
      } else {
        expect(textarea('Edit note').value).toBe('changed')
      }
    },
  )

  it.each(STATUS_CODES)(
    'delete / %s shows its exact toast once',
    async (code) => {
      const own = mine(DOCS.clusterId, 'Delete me')
      setup({ members: asMember, discussion: discussionOf([own]) })
      await ready(false)
      discussionMock.deleteNote.mockRejectedValue(new DiscussionApiError(code))
      fireEvent.click(
        screen.getByRole('button', { name: 'Delete note: Delete me' }),
      )
      fireEvent.click(
        within(
          screen.getByRole('group', { name: DELETE_NOTE_QUESTION }),
        ).getByRole('button', { name: 'Delete' }),
      )
      const message = discussionErrorMessage(code, 'delete') ?? ''
      expect(await screen.findByText(message)).toBeInTheDocument()
      expect(screen.getAllByText(message)).toHaveLength(1)
    },
  )

  it('not_note_author on delete re-reads the members', async () => {
    setup({ discussion: discussionOf([note(DOCS.clusterId, 'Theirs')]) })
    await ready()
    discussionMock.deleteNote.mockRejectedValue(
      new DiscussionApiError('not_note_author'),
    )
    const before = membersMock.fetchProjectMembers.mock.calls.length
    fireEvent.click(screen.getByRole('button', { name: 'Delete note: Theirs' }))
    fireEvent.click(
      within(
        screen.getByRole('group', { name: DELETE_NOTE_QUESTION }),
      ).getByRole('button', { name: 'Delete' }),
    )
    expect(
      await screen.findByText('You can delete only your own notes.'),
    ).toBeInTheDocument()
    await waitFor(() => {
      expect(membersMock.fetchProjectMembers.mock.calls.length).toBeGreaterThan(
        before,
      )
    })
  })

  it.each(['status', 'add'] as const)(
    'not_project_member on %s shows the not-found state and no toast',
    async (write) => {
      setup()
      await ready()
      if (write === 'status') {
        discussionMock.setDiscussionStatus.mockRejectedValue(
          new DiscussionApiError('not_project_member'),
        )
        fireEvent.click(statusButton('Docs', 'Skipped'))
      } else {
        discussionMock.addNote.mockRejectedValue(
          new DiscussionApiError('not_project_member'),
        )
        fireEvent.click(addButton('Docs'))
        type(textarea('Note on Docs'), 'x')
        fireEvent.click(saveButtonOf(textarea('Note on Docs')))
      }
      expect(await screen.findByText(NOT_FOUND)).toBeInTheDocument()
      expect(screen.queryByTestId('discuss-board')).not.toBeInTheDocument()
      expect(screen.queryByText(/^Could not/)).not.toBeInTheDocument()
    },
  )

  it('not_project_member from get_cycle_discussion shows the not-found state', async () => {
    setup()
    discussionMock.fetchDiscussion.mockRejectedValue(
      new DiscussionApiError('not_project_member'),
    )
    expect(
      await screen.findByText(NOT_FOUND, {}, { timeout: 5000 }),
    ).toBeInTheDocument()
  })

  it('not_project_facilitator on a status hides the status groups and re-reads the members', async () => {
    setup()
    await ready()
    discussionMock.setDiscussionStatus.mockRejectedValue(
      new DiscussionApiError('not_project_facilitator'),
    )
    const members = deferred<ProjectMember[]>()
    membersMock.fetchProjectMembers.mockReturnValue(members.promise)
    const before = membersMock.fetchProjectMembers.mock.calls.length
    fireEvent.click(statusButton('Docs', 'Skipped'))

    await waitFor(() => {
      expect(statusGroups()).toHaveLength(0)
    })
    expect(membersMock.fetchProjectMembers.mock.calls.length).toBeGreaterThan(
      before,
    )
    await act(async () => {
      members.resolve(asMember)
      await members.promise
    })
    expect(statusGroups()).toHaveLength(0)
    expect(
      screen
        .getAllByRole('listitem')
        .filter((li) => li.querySelector('h3'))
        .map(statusLine),
    ).toEqual(['Status: Pending', 'Status: Pending', 'Status: Pending'])
  })
})

describe('refetches', () => {
  it("another member's note leaves every open form's text and focus untouched", async () => {
    const own = mine(DOCS.clusterId, 'Mine')
    setup({ members: asMember, discussion: discussionOf([own]) })
    await ready(false)
    fireEvent.click(addButton('Tools'))
    type(textarea('Note on Tools'), 'half written')
    fireEvent.click(screen.getByRole('button', { name: 'Edit note: Mine' }))
    type(textarea('Edit note'), 'Mine, edited')
    textarea('Note on Tools').focus()

    serverDiscussion(discussionOf([own, note(TOOLS.clusterId, 'New from Bob')]))
    act(() => {
      cyclesMock.emitCycleEvent(CYCLE_ID)
    })
    expect(await screen.findByText('New from Bob')).toBeInTheDocument()
    expect(textarea('Note on Tools').value).toBe('half written')
    expect(textarea('Note on Tools')).toHaveFocus()
    expect(textarea('Edit note').value).toBe('Mine, edited')
    expect(statusRegion()).toHaveTextContent('')
  })

  it('a refetch that removes the note being edited closes the form, toasts, and focuses Add note', async () => {
    const own = mine(PROCESS.clusterId, 'Going away')
    setup({ members: asMember, discussion: discussionOf([own]) })
    await ready(false)
    fireEvent.click(
      screen.getByRole('button', { name: 'Edit note: Going away' }),
    )
    expect(textarea('Edit note')).toHaveFocus()

    serverDiscussion(discussionOf([]))
    await refetchDiscussion()

    expect(
      await screen.findByText(NOTE_DELETED_ELSEWHERE_MESSAGE),
    ).toBeInTheDocument()
    expect(screen.queryByLabelText('Edit note')).not.toBeInTheDocument()
    await waitFor(() => {
      expect(addButton('Process')).toHaveFocus()
    })
  })

  it("another member's status change or note updates the view and announces nothing", async () => {
    setup({ members: asMember })
    const list = await ready(false)
    serverDiscussion(
      discussionOf([note(null, 'Remote note')], {
        [TOOLS.clusterId]: 'discussed',
      }),
    )
    await refetchDiscussion()
    await waitFor(() => {
      expect(statusLine(topic('Tools'))).toBe('Status: Discussed')
    })
    expect(screen.getByText('Remote note')).toBeInTheDocument()
    expect(topics(list).map(topicHeading)).toEqual(ORDER)
    expect(statusRegion()).toHaveTextContent('')
  })

  it("with Realtime unavailable, the discussion is re-read on the board's 4 s poll", async () => {
    setup()
    await ready()
    await waitFor(() => {
      expect(cyclesMock.activeCycleEventsSubscriptions()).toHaveLength(1)
    })
    vi.useFakeTimers({
      toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'],
    })
    act(() => {
      cyclesMock.emitCycleEventsStatus(CYCLE_ID, 'CHANNEL_ERROR')
    })
    expect(screen.getByText(LIVE_NOTICE)).toBeInTheDocument()
    const before = discussionMock.fetchDiscussion.mock.calls.length
    await act(async () => {
      await vi.advanceTimersByTimeAsync(4000)
    })
    expect(discussionMock.fetchDiscussion.mock.calls.length).toBe(before + 1)
    await act(async () => {
      await vi.advanceTimersByTimeAsync(4000)
    })
    expect(discussionMock.fetchDiscussion.mock.calls.length).toBe(before + 2)
  })
})

describe('bylines and text', () => {
  it('a null author shows Deleted account and no Edit; HTML-like text is text; long words wrap', async () => {
    const longWord = 'x'.repeat(2000)
    const longName: BoardCluster = {
      ...TOOLS,
      name: 'N'.repeat(100),
    }
    const clusters = [PROCESS, longName, DOCS]
    setup({
      board: boardOf('discuss', clusters),
      discussion: discussionOf(
        [
          note(DOCS.clusterId, 'Orphan', { authorName: null }),
          note(DOCS.clusterId, '<b>bold</b><script>alert(1)</script>'),
          note(longName.clusterId, longWord),
        ],
        {},
        clusters,
      ),
    })
    await ready()
    const orphan = noteItem('Orphan')
    expect(within(orphan).getByText('Deleted account')).toBeInTheDocument()
    expect(
      within(orphan).queryByRole('button', { name: /^Edit/ }),
    ).not.toBeInTheDocument()
    expect(
      within(orphan).getByRole('button', { name: 'Delete note: Orphan' }),
    ).toBeInTheDocument()
    const html = noteItem('<b>bold</b><script>alert(1)</script>')
    expect(html.querySelector('b, script')).toBeNull()
    expect(noteItem(longWord).querySelector('p')?.className).toContain(
      '[overflow-wrap:anywhere]',
    )
    expect(
      [...document.querySelectorAll('[data-cluster-name]')]
        .filter((element) => element.textContent?.startsWith('N'.repeat(100)))
        .every((element) =>
          element.className.includes('[overflow-wrap:anywhere]'),
        ),
    ).toBe(true)
  })
})

describe('states', () => {
  it('shows Loading results… and no list while the discussion loads', async () => {
    const pending = deferred<CycleDiscussion>()
    setup()
    discussionMock.fetchDiscussion.mockReturnValue(pending.promise)
    expect(
      await screen.findByText(RESULTS_LOADING, {}, { timeout: 5000 }),
    ).toBeInTheDocument()
    expect(
      screen.queryByRole('list', { name: 'Agenda' }),
    ).not.toBeInTheDocument()
    await act(async () => {
      pending.resolve(discussionOf())
      await pending.promise
    })
    expect(await agenda()).toBeInTheDocument()
  })

  it('a failed load shows the alert; Retry re-reads it and renders the list', async () => {
    setup()
    discussionMock.fetchDiscussion.mockRejectedValue(
      new DiscussionApiError('unknown'),
    )
    const alert = await screen.findByRole('alert', {}, { timeout: 5000 })
    expect(alert).toHaveTextContent(DISCUSSION_LOAD_ERROR)
    expect(
      screen.queryByRole('list', { name: 'Agenda' }),
    ).not.toBeInTheDocument()
    const before = discussionMock.fetchDiscussion.mock.calls.length
    discussionMock.fetchDiscussion.mockResolvedValue(discussionOf())
    fireEvent.click(within(alert).getByRole('button', { name: 'Retry' }))
    expect(await agenda()).toBeInTheDocument()
    expect(discussionMock.fetchDiscussion.mock.calls.length).toBe(before + 1)
  })

  it.each([
    ['a missing status', discussionOf([], {}, [PROCESS, TOOLS])],
    [
      'a note on an unknown cluster',
      discussionOf([note('99999999-0000-4000-8000-000000000000', 'Lost')]),
    ],
  ])('%s shows the discussion alert', async (_label, discussion) => {
    setup({ discussion })
    const alert = await screen.findByRole('alert', {}, { timeout: 5000 })
    expect(alert).toHaveTextContent(DISCUSSION_LOAD_ERROR)
  })

  it("a totals error keeps #24's alert and takes precedence", async () => {
    setup()
    votesMock.fetchVoteTotals.mockRejectedValue(new Error('x'))
    discussionMock.fetchDiscussion.mockRejectedValue(
      new DiscussionApiError('unknown'),
    )
    const alert = await screen.findByRole('alert', {}, { timeout: 5000 })
    expect(alert).toHaveTextContent(RESULTS_LOAD_ERROR)
    expect(screen.queryByText(DISCUSSION_LOAD_ERROR)).not.toBeInTheDocument()
  })

  it('zero clusters show the no-topics line and General notes, which still works', async () => {
    setup({ board: boardOf('discuss', []), members: asMember })
    expect(
      await screen.findByText(NO_TOPICS, {}, { timeout: 5000 }),
    ).toBeInTheDocument()
    const add = await screen.findByRole('button', {
      name: 'Add a general note',
    })
    discussionMock.addNote.mockResolvedValue('g')
    serverDiscussion(discussionOf([mine(null, 'Only general')], {}, []))
    fireEvent.click(add)
    type(textarea('General note'), 'Only general')
    fireEvent.click(saveButtonOf(textarea('General note')))
    await waitFor(() => {
      expect(noteItem('Only general')).toBeInTheDocument()
    })
    await waitFor(() => {
      expect(discussionMock.addNote).toHaveBeenCalledWith(
        CYCLE_ID,
        null,
        'Only general',
      )
    })
  })
})

describe('stage gating', () => {
  it.each(['collecting', 'reveal', 'cluster', 'vote', 'closed'] as const)(
    'never calls get_cycle_discussion in %s and renders no discussion control',
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
      expect(discussionMock.fetchDiscussion).not.toHaveBeenCalled()
      expect(statusGroups()).toHaveLength(0)
      expect(screen.queryByRole('button', { name: /^Add note/ })).toBeNull()
      expect(screen.queryByText(/^Notes \(/)).toBeNull()
      expect(document.querySelector('textarea')).toBeNull()
    },
  )
})

describe('leaving discuss', () => {
  it('a refetch to closed while a form holds a draft removes discuss mode with no error', async () => {
    setup({ members: asMember })
    await ready(false)
    fireEvent.click(addButton('Docs'))
    type(textarea('Note on Docs'), 'unsent')
    boardMock.fetchCycleBoard.mockResolvedValue(boardOf('closed'))
    await act(async () => {
      await queryClient.invalidateQueries({ queryKey: ['cycle-board'] })
    })
    expect(
      await screen.findByRole('heading', { level: 2, name: 'Closed' }),
    ).toBeInTheDocument()
    expect(screen.queryByTestId('discuss-board')).not.toBeInTheDocument()
    expect(document.querySelector('textarea')).toBeNull()
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('a pending add that then fails with cycle_not_discussing shows only its toast', async () => {
    setup({ members: asMember })
    await ready(false)
    const pending = deferred<string>()
    discussionMock.addNote.mockReturnValue(pending.promise)
    fireEvent.click(addButton('Docs'))
    type(textarea('Note on Docs'), 'late')
    fireEvent.click(saveButtonOf(textarea('Note on Docs')))

    boardMock.fetchCycleBoard.mockResolvedValue(boardOf('closed'))
    await act(async () => {
      await queryClient.invalidateQueries({ queryKey: ['cycle-board'] })
    })
    await screen.findByRole('heading', { level: 2, name: 'Closed' })
    await act(async () => {
      pending.reject(new DiscussionApiError('cycle_not_discussing'))
      await pending.promise.catch(() => undefined)
    })
    expect(
      await screen.findByText(
        'Notes can only be changed during the Discuss stage.',
      ),
    ).toBeInTheDocument()
    expect(liveTexts().filter((text) => text.startsWith('Note'))).toEqual([])
  })

  it('a pending add that resolves after the change announces nothing and moves no focus', async () => {
    setup({ members: asMember })
    await ready(false)
    const pending = deferred<string>()
    discussionMock.addNote.mockReturnValue(pending.promise)
    fireEvent.click(addButton('Docs'))
    type(textarea('Note on Docs'), 'late')
    fireEvent.click(saveButtonOf(textarea('Note on Docs')))

    boardMock.fetchCycleBoard.mockResolvedValue(boardOf('closed'))
    await act(async () => {
      await queryClient.invalidateQueries({ queryKey: ['cycle-board'] })
    })
    await screen.findByRole('heading', { level: 2, name: 'Closed' })
    const back = screen.getByRole('link', { name: 'Back to project' })
    back.focus()
    await act(async () => {
      pending.resolve('n')
      await pending.promise
    })
    expect(back).toHaveFocus()
    expect(liveTexts().filter((text) => text.startsWith('Note'))).toEqual([])
  })
})

describe('role change', () => {
  it("losing the role with focus on a status button hides the groups and Delete on others' notes, and focuses the Discuss h2", async () => {
    const notes = [note(DOCS.clusterId, 'Theirs'), mine(DOCS.clusterId, 'Mine')]
    setup({ discussion: discussionOf(notes) })
    await ready()
    statusButton('Docs', 'Skipped').focus()

    membersMock.fetchProjectMembers.mockResolvedValue(asMember)
    await act(async () => {
      await queryClient.invalidateQueries({ queryKey: ['project-members'] })
    })
    await waitFor(() => {
      expect(statusGroups()).toHaveLength(0)
    })
    expect(
      screen.queryByRole('button', { name: 'Delete note: Theirs' }),
    ).not.toBeInTheDocument()
    expect(
      screen.getByRole('button', { name: 'Delete note: Mine' }),
    ).toBeInTheDocument()
    await waitFor(() => {
      expect(
        screen.getByRole('heading', { level: 2, name: 'Discuss' }),
      ).toHaveFocus()
    })
  })

  it('with focus elsewhere, focus does not move', async () => {
    setup()
    await ready()
    const add = addButton('Docs')
    add.focus()
    membersMock.fetchProjectMembers.mockResolvedValue(asMember)
    await act(async () => {
      await queryClient.invalidateQueries({ queryKey: ['project-members'] })
    })
    await waitFor(() => {
      expect(statusGroups()).toHaveLength(0)
    })
    expect(add).toHaveFocus()
  })
})

describe('privacy and sameness', () => {
  it('an anonymous card has the same node as in cluster mode, with no control inside any card', async () => {
    const clusterView = setup({ board: boardOf('cluster'), members: asMember })
    await screen.findByTestId('cluster-board', {}, { timeout: 5000 })
    await waitFor(() => {
      expect(membersMock.fetchProjectMembers).toHaveBeenCalled()
    })
    const inCluster = document.querySelector(
      `[data-card-id="${ANON.cardId}"]`,
    )?.outerHTML
    clusterView.unmount()
    queryClient.clear()

    setup({ discussion: discussionOf([note(PROCESS.clusterId, 'A note')]) })
    await ready()
    const board = screen.getByTestId('discuss-board')
    expect(inCluster).toBeDefined()
    expect(
      board.querySelector(`[data-card-id="${ANON.cardId}"]`)?.outerHTML,
    ).toBe(inCluster)
    for (const card of board.querySelectorAll('[data-card-id]')) {
      expect(
        card.querySelector('button, input, textarea, [role="group"]'),
      ).toBeNull()
      expect(card.textContent).not.toMatch(/Status|Notes/)
    }
  })

  it('the facilitator, the owner who is not the facilitator, and a member get the same DOM except the status groups and moderation Delete', async () => {
    const discussion = discussionOf(
      [note(PROCESS.clusterId, 'From Bob'), note(null, 'General from Bob')],
      { [DOCS.clusterId]: 'discussed' },
    )
    const html: string[] = []
    for (const members of [asFacilitator, asOwnerNotFacilitator, asMember]) {
      const view = setup({ members, discussion })
      await ready(members === asFacilitator)
      const shared = screen
        .getByTestId('discuss-board')
        .cloneNode(true) as HTMLElement
      for (const element of shared.querySelectorAll(
        '[data-facilitator-control]',
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
    setup()
    await ready()
    discussionMock.setDiscussionStatus.mockResolvedValue(undefined)
    serverDiscussion(discussionOf([], { [PROCESS.clusterId]: 'discussed' }))
    fireEvent.click(statusButton('Process', 'Discussed'))
    await waitFor(() => {
      expect(statusRegion()).toHaveTextContent('Process marked Discussed.')
    })
    discussionMock.addNote.mockRejectedValue(new DiscussionApiError('unknown'))
    fireEvent.click(addButton('Process'))
    type(textarea('Note on Process'), 'x')
    fireEvent.click(saveButtonOf(textarea('Note on Process')))
    await screen.findByText('Could not save your note.')

    const outputs = [
      ...screen.queryAllByRole('alert'),
      ...screen.getAllByRole('status'),
      ...document.querySelectorAll('[data-sonner-toast]'),
    ].map((element) => element.textContent ?? '')
    for (const output of outputs) {
      for (const word of CARD_WORDS) {
        expect(output).not.toContain(word)
      }
    }
  })
})
