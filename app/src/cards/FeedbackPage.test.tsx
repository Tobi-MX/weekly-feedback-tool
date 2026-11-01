import { act, fireEvent, screen, waitFor, within } from '@testing-library/react'
import { onlineManager } from '@tanstack/react-query'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { CycleDetail } from '../cycles/cyclesApi'
import type { CycleStatus } from '../cycles/cycleStatus'
import { CyclesApiError } from '../cycles/cyclesErrors'
import { deferred, mockRestoredSession } from '../test/authMock'
import { cardsMock } from '../test/cardsMock'
import { cyclesMock } from '../test/cyclesMock'
import { membersMock } from '../test/membersMock'
import { profileMock } from '../test/profileMock'
import { renderApp } from '../test/renderApp'
import type { CreateCardInput, MyCard, SavedCard } from './cardsApi'
import type { CardCategory } from './cardCategories'
import { CardsApiError, type CardsErrorCode } from './cardsErrors'

const CYCLE_ID = '30000000-0000-4000-8000-000000000001'
const PROJECT_ID = '10000000-0000-4000-8000-000000000001'
const PATH = `/cycles/${CYCLE_ID}/feedback`

const HINT_ATTRIBUTED =
  'Your name will be shown with this card when the team reveals feedback.'
const HINT_ANONYMOUS =
  'No one on the team, including the facilitator, will see that you wrote this card.'
const ENDED = 'Feedback collection has ended for this cycle.'
const CLOSED_NOTICE =
  'Feedback collection has ended for this cycle. You can still read your cards.'
const NOT_FOUND = 'Cycle not found or you do not have access.'
const OFFLINE = 'You are offline. Cards cannot be saved until you reconnect.'
const GENERIC = 'Could not save the card. Try again.'

const LABELS: Record<CardCategory, string> = {
  start: 'Start',
  stop: 'Stop',
  continue: 'Continue',
}

const collectingCycle: CycleDetail = {
  id: CYCLE_ID,
  projectId: PROJECT_ID,
  title: 'Week of Oct 26, 2026',
  weekStart: '2026-10-26',
  status: 'collecting',
}

let nextId = 1

function cardId(): string {
  const id = `40000000-0000-4000-8000-${String(nextId).padStart(12, '0')}`
  nextId += 1
  return id
}

function makeCard(
  category: CardCategory,
  text: string,
  isAnonymous = false,
): MyCard {
  return {
    id: cardId(),
    category,
    text,
    isAnonymous,
    createdAt: '2026-11-01T10:00:00+00:00',
    updatedAt: '2026-11-01T10:00:00+00:00',
  }
}

function toSaved(card: MyCard): SavedCard {
  return { ...card, cycleId: CYCLE_ID }
}

/**
 * A stand-in for the four RPCs that keeps the member's cards between calls,
 * so every successful write is followed by a real re-read.
 */
function fakeServer(initial: MyCard[] = []) {
  let cards = [...initial]
  cardsMock.fetchMyCards.mockImplementation(() =>
    Promise.resolve(cards.map((card) => ({ ...card }))),
  )
  cardsMock.createCard.mockImplementation((input: CreateCardInput) => {
    const card = makeCard(input.category, input.text, input.isAnonymous)
    cards = [...cards, card]
    return Promise.resolve(toSaved(card))
  })
  cardsMock.updateCard.mockImplementation((input) => {
    const existing = cards.find((card) => card.id === input.cardId)
    if (!existing) {
      return Promise.reject(new CardsApiError('card_not_found', 'save'))
    }
    const updated = {
      ...existing,
      text: input.text,
      isAnonymous: input.isAnonymous,
    }
    cards = cards.map((card) => (card.id === input.cardId ? updated : card))
    return Promise.resolve(toSaved(updated))
  })
  cardsMock.deleteCard.mockImplementation((id) => {
    cards = cards.filter((card) => card.id !== id)
    return Promise.resolve()
  })
  return {
    get cards() {
      return cards
    },
    set cards(value: MyCard[]) {
      cards = value
    },
  }
}

function renderFeedback(
  options: {
    readonly cycle?: CycleDetail | null
    readonly cards?: MyCard[]
    readonly path?: string
  } = {},
) {
  mockRestoredSession()
  profileMock.fetchProfileDisplayName.mockResolvedValue('Dev User')
  cyclesMock.fetchCycle.mockResolvedValue(
    options.cycle === undefined ? collectingCycle : options.cycle,
  )
  const server = fakeServer(options.cards)
  const view = renderApp({ initialEntries: [options.path ?? PATH] })
  return { server, view }
}

async function waitForForm() {
  return screen.findByRole('region', { name: 'Start' })
}

function section(category: CardCategory): HTMLElement {
  return screen.getByRole('region', { name: LABELS[category] })
}

function composer(category: CardCategory): HTMLTextAreaElement {
  return within(section(category)).getByRole('textbox', {
    name: `Add a ${LABELS[category]} card`,
  })
}

function typeInto(element: HTMLElement, value: string) {
  fireEvent.change(element, { target: { value } })
}

function addButton(category: CardCategory): HTMLElement {
  return within(section(category)).getByRole('button', {
    name: /^(Add card|Add anonymously|Adding…)$/,
  })
}

function anonymousBox(scope: HTMLElement): HTMLInputElement {
  return within(scope).getByRole('checkbox', { name: 'Submit anonymously' })
}

afterEach(() => {
  act(() => {
    onlineManager.setOnline(true)
  })
  vi.useRealTimers()
})

describe('FeedbackPage loading and not found', () => {
  it('shows only a loading status until the cycle and the cards have loaded', async () => {
    const cards = deferred<MyCard[]>()
    renderFeedback()
    cardsMock.fetchMyCards.mockReturnValue(cards.promise)

    expect(await screen.findByText('Loading feedback…')).toHaveAttribute(
      'role',
      'status',
    )
    await waitFor(() => {
      expect(cardsMock.fetchMyCards).toHaveBeenCalledWith(CYCLE_ID)
    })
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument()
    expect(screen.queryByText(/cards yet/)).not.toBeInTheDocument()

    await act(async () => {
      cards.resolve([])
    })
    expect(await waitForForm()).toBeInTheDocument()
    expect(screen.queryByText('Loading feedback…')).not.toBeInTheDocument()
  })

  it('shows not found for a non-UUID id and sends no request', async () => {
    renderFeedback({ path: '/cycles/not-a-uuid/feedback' })

    expect(await screen.findByText(NOT_FOUND)).toBeInTheDocument()
    expect(
      screen.getByRole('link', { name: 'Back to projects' }),
    ).toHaveAttribute('href', '/projects')
    expect(cyclesMock.fetchCycle).not.toHaveBeenCalled()
    expect(cardsMock.fetchMyCards).not.toHaveBeenCalled()
  })

  it('shows not found for an unknown cycle or a non-member, with the cycle read and no get_my_cards', async () => {
    renderFeedback({ cycle: null })

    expect(await screen.findByText(NOT_FOUND)).toBeInTheDocument()
    expect(
      screen.getByRole('link', { name: 'Back to projects' }),
    ).toHaveAttribute('href', '/projects')
    expect(cyclesMock.fetchCycle).toHaveBeenCalledWith(CYCLE_ID)
    expect(cardsMock.fetchMyCards).not.toHaveBeenCalled()
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument()
  })

  it('shows not found when get_my_cards answers not_project_member', async () => {
    renderFeedback()
    cardsMock.fetchMyCards.mockRejectedValue(
      new CardsApiError('not_project_member', 'load'),
    )

    expect(await screen.findByText(NOT_FOUND)).toBeInTheDocument()
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument()
  })

  it('shows a load error for the cycle read and Retry sends it again', async () => {
    renderFeedback()
    cyclesMock.fetchCycle
      .mockReset()
      .mockRejectedValueOnce(new CyclesApiError('unknown'))
      .mockResolvedValue(collectingCycle)

    const alert = await screen.findByRole('alert')
    expect(alert).toHaveTextContent('Could not load your feedback.')
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument()
    expect(cardsMock.fetchMyCards).not.toHaveBeenCalled()

    fireEvent.click(within(alert).getByRole('button', { name: 'Retry' }))

    expect(await waitForForm()).toBeInTheDocument()
    expect(cyclesMock.fetchCycle).toHaveBeenCalledTimes(2)
  })

  it('shows a load error for get_my_cards and Retry sends it again', async () => {
    const { server } = renderFeedback()
    cardsMock.fetchMyCards
      .mockRejectedValueOnce(new CardsApiError('unknown', 'load'))
      .mockImplementation(() => Promise.resolve(server.cards))

    const alert = await screen.findByRole('alert')
    expect(alert).toHaveTextContent('Could not load your feedback.')
    expect(alert).not.toHaveTextContent('unknown')
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument()

    fireEvent.click(within(alert).getByRole('button', { name: 'Retry' }))

    expect(await waitForForm()).toBeInTheDocument()
    expect(cardsMock.fetchMyCards).toHaveBeenCalledTimes(2)
    expect(cyclesMock.fetchCycle).toHaveBeenCalledTimes(1)
  })
})

describe('FeedbackPage layout', () => {
  it('shows the title, status, week, and Back to project link', async () => {
    renderFeedback()

    expect(
      await screen.findByRole('heading', {
        level: 1,
        name: 'Week of Oct 26, 2026',
      }),
    ).toBeInTheDocument()
    expect(screen.getByText('Collecting feedback')).toBeVisible()
    expect(
      screen.getByText('Week of Oct 26, 2026', { selector: 'p' }),
    ).toBeVisible()
    expect(
      screen.getByRole('link', { name: 'Back to project' }),
    ).toHaveAttribute('href', `/projects/${PROJECT_ID}`)
    expect(
      screen.queryByText('This screen is not built yet.'),
    ).not.toBeInTheDocument()
  })

  it('shows three labelled sections in order with prompts and empty states', async () => {
    renderFeedback()
    await waitForForm()

    const regions = screen
      .getAllByRole('region')
      .filter((region) =>
        ['Start', 'Stop', 'Continue'].includes(
          region.getAttribute('aria-labelledby')
            ? (document.getElementById(
                region.getAttribute('aria-labelledby') ?? '',
              )?.textContent ?? '')
            : '',
        ),
      )
    expect(regions).toHaveLength(3)
    expect(
      regions.map(
        (region) =>
          within(region).getByRole('heading', { level: 2 }).textContent,
      ),
    ).toEqual(['Start', 'Stop', 'Continue'])

    expect(
      within(section('start')).getByText('What should the team begin doing?'),
    ).toBeVisible()
    expect(
      within(section('stop')).getByText('What should the team stop doing?'),
    ).toBeVisible()
    expect(
      within(section('continue')).getByText(
        'What is working and should continue?',
      ),
    ).toBeVisible()
    expect(
      within(section('start')).getByText('No Start cards yet.'),
    ).toBeVisible()
    expect(
      within(section('stop')).getByText('No Stop cards yet.'),
    ).toBeVisible()
    expect(
      within(section('continue')).getByText('No Continue cards yet.'),
    ).toBeVisible()
  })

  it('lists each section’s cards oldest first in labelled lists with their labels', async () => {
    const cards = [
      makeCard('start', 'First start'),
      makeCard('stop', 'Only stop', true),
      makeCard('start', 'Second start', true),
    ]
    renderFeedback({ cards })
    await waitForForm()

    const startList = within(section('start')).getByRole('list', {
      name: 'Your Start cards',
    })
    const items = within(startList).getAllByRole('listitem')
    expect(items.map((item) => item.querySelector('p')?.textContent)).toEqual([
      'First start',
      'Second start',
    ])
    expect(
      within(items[0] as HTMLElement).getByText('Shows your name'),
    ).toBeVisible()
    expect(within(items[1] as HTMLElement).getByText('Anonymous')).toBeVisible()

    const stopList = within(section('stop')).getByRole('list', {
      name: 'Your Stop cards',
    })
    expect(within(stopList).getByText('Only stop')).toBeVisible()
    expect(within(stopList).getByText('Anonymous')).toBeVisible()
    expect(
      within(section('continue')).getByText('No Continue cards yet.'),
    ).toBeVisible()
  })

  it('shows card text as plain text with its line breaks', async () => {
    renderFeedback({
      cards: [makeCard('start', '<b>hi</b>'), makeCard('stop', 'one\ntwo')],
    })
    await waitForForm()

    const html = within(section('start')).getByText('<b>hi</b>')
    expect(html.querySelector('b')).toBeNull()
    const multi = within(section('stop')).getByText(
      (_, element) =>
        element?.textContent === 'one\ntwo' && element.tagName === 'P',
    )
    expect(multi).toHaveClass('whitespace-pre-wrap')
  })

  it('stacks sections in one column and sits them side by side from md', async () => {
    renderFeedback()
    await waitForForm()

    const grid = section('start').parentElement
    expect(grid).toHaveClass('grid-cols-1', 'md:grid-cols-3')
  })

  it('shows no name, email, or user id next to any card', async () => {
    renderFeedback({
      cards: [makeCard('start', 'Mine'), makeCard('stop', 'Hidden', true)],
    })
    await waitForForm()

    const main = screen.getByRole('main')
    for (const category of ['start', 'stop', 'continue'] as const) {
      expect(section(category)).not.toHaveTextContent('Dev User')
      expect(section(category)).not.toHaveTextContent('dev@example.com')
      expect(section(category)).not.toHaveTextContent('user-1')
    }
    expect(main.innerHTML).not.toContain('user-1')
  })
})

describe('FeedbackPage for the facilitator', () => {
  it('shows the same screen with no role lookup, no extra controls, and only their own cards', async () => {
    renderFeedback({ cards: [makeCard('start', 'Facilitator card')] })
    await waitForForm()

    expect(membersMock.fetchProjectMembers).not.toHaveBeenCalled()
    expect(cardsMock.fetchMyCards).toHaveBeenCalledWith(CYCLE_ID)
    expect(within(section('start')).getAllByRole('listitem')).toHaveLength(1)
    const main = screen.getByRole('main')
    const buttons = within(main)
      .getAllByRole('button')
      .map((button) => button.textContent)
    expect(buttons).toEqual([
      'Edit',
      'Delete',
      'Add card',
      'Add card',
      'Add card',
    ])
  })
})

describe('FeedbackPage composer', () => {
  it('shows a labelled textarea, counter, unchecked checkbox, hint, and Add card in each section', async () => {
    renderFeedback()
    await waitForForm()

    for (const category of ['start', 'stop', 'continue'] as const) {
      const scope = section(category)
      expect(composer(category)).toHaveValue('')
      expect(within(scope).getByText('0 / 500')).toBeVisible()
      const box = anonymousBox(scope)
      expect(box).not.toBeChecked()
      expect(box).toHaveAccessibleDescription(HINT_ATTRIBUTED)
      expect(
        within(scope).getByRole('button', { name: 'Add card' }),
      ).toBeEnabled()
    }
  })

  it('switches the hint and the Add button with the checkbox', async () => {
    renderFeedback()
    await waitForForm()
    const scope = section('stop')
    const box = anonymousBox(scope)

    fireEvent.click(box)
    expect(box).toBeChecked()
    expect(box).toHaveAccessibleDescription(HINT_ANONYMOUS)
    expect(within(scope).getByText(HINT_ANONYMOUS)).toBeVisible()
    expect(
      within(scope).getByRole('button', { name: 'Add anonymously' }),
    ).toBeVisible()

    fireEvent.click(box)
    expect(box).toHaveAccessibleDescription(HINT_ATTRIBUTED)
    expect(
      within(scope).getByRole('button', { name: 'Add card' }),
    ).toBeVisible()
  })

  it('counts code points after trimming', async () => {
    renderFeedback()
    await waitForForm()
    const scope = section('start')

    typeInto(composer('start'), `  ${'é'.repeat(500)}\n`)
    expect(within(scope).getByText('500 / 500')).toBeVisible()
    typeInto(composer('start'), '😀'.repeat(500))
    expect(within(scope).getByText('500 / 500')).toBeVisible()
    typeInto(composer('start'), '😀'.repeat(501))
    expect(within(scope).getByText('501 / 500')).toBeVisible()
  })

  it.each<[string, string]>([
    ['500 é', 'é'.repeat(500)],
    ['500 😀', '😀'.repeat(500)],
  ])('adds %s', async (_label, text) => {
    renderFeedback()
    await waitForForm()

    typeInto(composer('start'), text)
    fireEvent.click(addButton('start'))

    await waitFor(() => {
      expect(cardsMock.createCard).toHaveBeenCalledTimes(1)
    })
    expect(cardsMock.createCard.mock.calls[0]?.[0].text).toBe(text)
  })

  it('does not submit on Enter in the textarea', async () => {
    renderFeedback()
    await waitForForm()

    typeInto(composer('start'), 'line one')
    fireEvent.keyDown(composer('start'), { key: 'Enter' })
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 10))
    })
    expect(cardsMock.createCard).not.toHaveBeenCalled()
  })

  it.each(['', '   ', ' \t\n\r '])(
    'rejects %j with an inline error and no request',
    async (text) => {
      renderFeedback()
      await waitForForm()
      typeInto(composer('start'), text)
      fireEvent.click(addButton('start'))

      const error = await within(section('start')).findByRole('alert')
      expect(error).toHaveTextContent('Write something before adding the card.')
      const textarea = composer('start')
      expect(textarea).toHaveAttribute('aria-invalid', 'true')
      expect(textarea).toHaveAttribute('aria-describedby', error.id)
      expect(textarea).toHaveAccessibleDescription(
        'Write something before adding the card.',
      )
      expect(cardsMock.createCard).not.toHaveBeenCalled()
    },
  )

  it('rejects more than 500 characters after trimming and keeps the text', async () => {
    renderFeedback()
    await waitForForm()
    const text = '😀'.repeat(501)
    typeInto(composer('stop'), text)
    fireEvent.click(addButton('stop'))

    expect(
      await within(section('stop')).findByText('Use 500 characters or fewer.'),
    ).toHaveAttribute('role', 'alert')
    expect(composer('stop')).toHaveValue(text)
    expect(composer('stop')).toHaveAttribute('aria-invalid', 'true')
    expect(cardsMock.createCard).not.toHaveBeenCalled()
  })

  it('does not put the counter in a live region', async () => {
    renderFeedback()
    await waitForForm()
    const counter = within(section('start')).getByText('0 / 500')
    expect(counter.closest('[aria-live]')).toBeNull()
    expect(counter.closest('[role="status"]')).toBeNull()
    expect(counter.closest('[role="alert"]')).toBeNull()
  })
})

describe('FeedbackPage adding a card', () => {
  it.each<[CardCategory, boolean]>([
    ['start', false],
    ['start', true],
    ['stop', false],
    ['stop', true],
    ['continue', false],
    ['continue', true],
  ])(
    'adds a %s card (anonymous %s) with the exact payload',
    async (category, anonymous) => {
      renderFeedback()
      await waitForForm()
      const scope = section(category)

      typeInto(composer(category), '  Ship on Fridays \n')
      if (anonymous) {
        fireEvent.click(anonymousBox(scope))
      }
      const fetchesBefore = cardsMock.fetchMyCards.mock.calls.length
      fireEvent.click(addButton(category))

      expect(await screen.findByText('Card added.')).toBeInTheDocument()
      expect(cardsMock.createCard).toHaveBeenCalledTimes(1)
      expect(cardsMock.createCard.mock.calls[0]?.[0]).toStrictEqual({
        cycleId: CYCLE_ID,
        category,
        text: 'Ship on Fridays',
        isAnonymous: anonymous,
      })
      expect(cardsMock.fetchMyCards.mock.calls.length).toBeGreaterThan(
        fetchesBefore,
      )

      const list = within(scope).getByRole('list', {
        name: `Your ${LABELS[category]} cards`,
      })
      expect(within(list).getByText('Ship on Fridays')).toBeVisible()
      expect(
        within(list).getByText(anonymous ? 'Anonymous' : 'Shows your name'),
      ).toBeVisible()
      expect(composer(category)).toHaveValue('')
      await waitFor(() => {
        expect(composer(category)).toHaveFocus()
      })
      expect(anonymousBox(scope)).not.toBeChecked()
      expect(
        within(scope).getByRole('button', { name: 'Add card' }),
      ).toBeVisible()
      // Other sections are untouched.
      for (const other of ['start', 'stop', 'continue'] as const) {
        if (other !== category) {
          expect(
            within(section(other)).getByText(`No ${LABELS[other]} cards yet.`),
          ).toBeVisible()
        }
      }
    },
  )

  it('keeps interior line breaks in the payload', async () => {
    renderFeedback()
    await waitForForm()
    typeInto(composer('start'), '\nline one\nline two\n')
    fireEvent.click(addButton('start'))

    await screen.findByText('Card added.')
    expect(cardsMock.createCard.mock.calls[0]?.[0].text).toBe(
      'line one\nline two',
    )
  })

  it('reads Adding… and sends one request on a double click', async () => {
    renderFeedback()
    await waitForForm()
    const pending = deferred<SavedCard>()
    cardsMock.createCard.mockReturnValue(pending.promise)

    typeInto(composer('start'), 'Once')
    const button = addButton('start')
    fireEvent.click(button)
    fireEvent.click(button)

    const adding = await within(section('start')).findByRole('button', {
      name: 'Adding…',
    })
    expect(adding).toBeDisabled()
    fireEvent.click(adding)
    expect(cardsMock.createCard).toHaveBeenCalledTimes(1)
    expect(
      screen.getByText('Adding…', { selector: '.sr-only' }),
    ).toHaveAttribute('role', 'status')

    await act(async () => {
      pending.resolve(toSaved(makeCard('start', 'Once')))
    })
    expect(await screen.findByText('Card added.')).toBeInTheDocument()
  })

  it('adds two cards with the same text', async () => {
    renderFeedback()
    await waitForForm()

    typeInto(composer('start'), 'Same')
    fireEvent.click(addButton('start'))
    await screen.findByText('Card added.')
    typeInto(composer('start'), 'Same')
    fireEvent.click(addButton('start'))

    await waitFor(() => {
      expect(within(section('start')).getAllByText('Same')).toHaveLength(2)
    })
    expect(cardsMock.createCard).toHaveBeenCalledTimes(2)
  })

  it('never writes card text or ids to the console or browser storage', async () => {
    const log = vi.spyOn(console, 'log')
    const error = vi.spyOn(console, 'error')
    const warn = vi.spyOn(console, 'warn')
    const info = vi.spyOn(console, 'info')
    const setItem = vi.spyOn(Storage.prototype, 'setItem')
    renderFeedback()
    await waitForForm()

    typeInto(composer('start'), 'Secret text')
    fireEvent.click(addButton('start'))
    await screen.findByText('Card added.')
    cardsMock.createCard.mockRejectedValueOnce(
      new CardsApiError('unknown', 'add'),
    )
    typeInto(composer('start'), 'Secret two')
    fireEvent.click(addButton('start'))
    await screen.findByText(GENERIC)

    const logged = [log, error, warn, info]
      .flatMap((spy) => spy.mock.calls)
      .map((call) => JSON.stringify(call))
      .join('\n')
    expect(logged).not.toContain('Secret')
    expect(logged).not.toContain('40000000-')
    expect(setItem).not.toHaveBeenCalled()
    expect(JSON.stringify({ ...localStorage })).not.toContain('Secret')
    expect(JSON.stringify({ ...sessionStorage })).not.toContain('Secret')
  })
})

async function openEditor(category: CardCategory, index: number) {
  const name = `${LABELS[category]} card ${index}`
  fireEvent.click(
    within(section(category)).getByRole('button', { name: `Edit ${name}` }),
  )
  return within(section(category)).findByRole('form', { name: `Edit ${name}` })
}

describe('FeedbackPage editing a card', () => {
  it('names Edit and Delete buttons after the card', async () => {
    renderFeedback({
      cards: [makeCard('start', 'One'), makeCard('start', 'Two')],
    })
    await waitForForm()

    expect(
      screen.getByRole('button', { name: 'Edit Start card 2' }),
    ).toBeVisible()
    expect(
      screen.getByRole('button', { name: 'Delete Start card 2' }),
    ).toBeVisible()
    expect(
      screen.getByRole('button', { name: 'Edit Start card 1' }),
    ).toBeVisible()
  })

  it('opens a prefilled editor with focus, hint, and no category control', async () => {
    renderFeedback({ cards: [makeCard('stop', 'Old text', true)] })
    await waitForForm()

    const editor = await openEditor('stop', 1)
    const textarea = within(editor).getByRole('textbox', {
      name: 'Edit Stop card 1',
    })
    expect(textarea).toHaveValue('Old text')
    expect(textarea).toHaveFocus()
    expect(anonymousBox(editor)).toBeChecked()
    expect(anonymousBox(editor)).toHaveAccessibleDescription(HINT_ANONYMOUS)
    expect(within(editor).getByText('8 / 500')).toBeVisible()
    expect(
      within(editor).getByText(
        'To move this card to another section, delete it and add it again.',
      ),
    ).toBeVisible()
    expect(within(editor).queryByRole('combobox')).not.toBeInTheDocument()
    expect(within(editor).queryByRole('radio')).not.toBeInTheDocument()
    expect(within(editor).getByRole('button', { name: 'Save' })).toBeVisible()
    expect(within(editor).getByRole('button', { name: 'Cancel' })).toBeVisible()
  })

  it('validates like adding and sends no request for invalid text', async () => {
    renderFeedback({ cards: [makeCard('start', 'Keep')] })
    await waitForForm()
    const editor = await openEditor('start', 1)
    const textarea = within(editor).getByRole('textbox')

    typeInto(textarea, ' \n ')
    fireEvent.click(within(editor).getByRole('button', { name: 'Save' }))
    expect(await within(editor).findByRole('alert')).toHaveTextContent(
      'Write something before adding the card.',
    )
    expect(textarea).toHaveAttribute('aria-invalid', 'true')

    typeInto(textarea, 'a'.repeat(501))
    fireEvent.click(within(editor).getByRole('button', { name: 'Save' }))
    expect(
      await within(editor).findByText('Use 500 characters or fewer.'),
    ).toBeVisible()
    expect(cardsMock.updateCard).not.toHaveBeenCalled()
  })

  it('switches attributed to anonymous and back, saving each time', async () => {
    const card = makeCard('continue', 'Pairing')
    renderFeedback({ cards: [card] })
    await waitForForm()
    const scope = section('continue')

    let editor = await openEditor('continue', 1)
    fireEvent.click(anonymousBox(editor))
    fireEvent.click(within(editor).getByRole('button', { name: 'Save' }))
    expect(await screen.findByText('Card updated.')).toBeInTheDocument()
    expect(cardsMock.updateCard).toHaveBeenLastCalledWith({
      cardId: card.id,
      text: 'Pairing',
      isAnonymous: true,
    })
    expect(await within(scope).findByText('Anonymous')).toBeVisible()
    await waitFor(() => {
      expect(
        within(scope).getByRole('button', { name: 'Edit Continue card 1' }),
      ).toHaveFocus()
    })

    editor = await openEditor('continue', 1)
    fireEvent.click(anonymousBox(editor))
    typeInto(within(editor).getByRole('textbox'), '  Pairing daily \n')
    fireEvent.click(within(editor).getByRole('button', { name: 'Save' }))
    expect(await within(scope).findByText('Shows your name')).toBeVisible()
    expect(cardsMock.updateCard).toHaveBeenCalledTimes(2)
    expect(cardsMock.updateCard.mock.calls[1]?.[0]).toStrictEqual({
      cardId: card.id,
      text: 'Pairing daily',
      isAnonymous: false,
    })
    expect(within(scope).getByText('Pairing daily')).toBeVisible()
  })

  it('reads Saving… and sends one request on a double click', async () => {
    renderFeedback({ cards: [makeCard('start', 'Before')] })
    await waitForForm()
    const pending = deferred<SavedCard>()
    cardsMock.updateCard.mockReturnValue(pending.promise)

    const editor = await openEditor('start', 1)
    typeInto(within(editor).getByRole('textbox'), 'After')
    const save = within(editor).getByRole('button', { name: 'Save' })
    fireEvent.click(save)
    fireEvent.click(save)

    expect(
      await within(editor).findByRole('button', { name: 'Saving…' }),
    ).toBeDisabled()
    expect(cardsMock.updateCard).toHaveBeenCalledTimes(1)
    expect(
      screen.getByText('Saving…', { selector: '.sr-only' }),
    ).toBeInTheDocument()

    await act(async () => {
      pending.resolve(toSaved(makeCard('start', 'After')))
    })
  })

  it('closes with no request when nothing changed', async () => {
    renderFeedback({ cards: [makeCard('start', 'Same')] })
    await waitForForm()

    const editor = await openEditor('start', 1)
    typeInto(within(editor).getByRole('textbox'), ' Same \n')
    fireEvent.click(within(editor).getByRole('button', { name: 'Save' }))

    await waitFor(() => {
      expect(
        screen.queryByRole('form', { name: 'Edit Start card 1' }),
      ).not.toBeInTheDocument()
    })
    expect(cardsMock.updateCard).not.toHaveBeenCalled()
    expect(
      screen.getByRole('button', { name: 'Edit Start card 1' }),
    ).toHaveFocus()
  })

  it.each(['Cancel', 'Escape'])(
    '%s with no changes closes the editor and focuses Edit',
    async (how) => {
      renderFeedback({ cards: [makeCard('start', 'Same')] })
      await waitForForm()
      const editor = await openEditor('start', 1)

      if (how === 'Cancel') {
        fireEvent.click(within(editor).getByRole('button', { name: 'Cancel' }))
      } else {
        fireEvent.keyDown(within(editor).getByRole('textbox'), {
          key: 'Escape',
        })
      }

      await waitFor(() => {
        expect(
          screen.getByRole('button', { name: 'Edit Start card 1' }),
        ).toHaveFocus()
      })
      expect(
        screen.queryByText('Discard your changes?'),
      ).not.toBeInTheDocument()
      expect(cardsMock.updateCard).not.toHaveBeenCalled()
    },
  )

  it.each(['Cancel', 'Escape'])(
    '%s with changes asks to discard; Keep editing keeps the text, Discard closes',
    async (how) => {
      renderFeedback({ cards: [makeCard('start', 'Same')] })
      await waitForForm()
      let editor = await openEditor('start', 1)
      const cancel = () => {
        if (how === 'Cancel') {
          fireEvent.click(
            within(editor).getByRole('button', { name: 'Cancel' }),
          )
        } else {
          fireEvent.keyDown(within(editor).getByRole('textbox'), {
            key: 'Escape',
          })
        }
      }

      typeInto(within(editor).getByRole('textbox'), 'Changed')
      cancel()
      expect(within(editor).getByText('Discard your changes?')).toBeVisible()
      fireEvent.click(
        within(editor).getByRole('button', { name: 'Keep editing' }),
      )
      expect(within(editor).getByRole('textbox')).toHaveValue('Changed')
      expect(within(editor).getByRole('textbox')).toHaveFocus()

      cancel()
      fireEvent.click(within(editor).getByRole('button', { name: 'Discard' }))
      await waitFor(() => {
        expect(
          screen.getByRole('button', { name: 'Edit Start card 1' }),
        ).toHaveFocus()
      })
      expect(within(section('start')).getByText('Same')).toBeVisible()
      expect(cardsMock.updateCard).not.toHaveBeenCalled()

      editor = await openEditor('start', 1)
      expect(within(editor).getByRole('textbox')).toHaveValue('Same')
    },
  )
})

describe('FeedbackPage deleting a card', () => {
  it('asks inline, focuses Cancel, and Cancel or Escape sends no request', async () => {
    renderFeedback({ cards: [makeCard('stop', 'Meetings')] })
    await waitForForm()

    fireEvent.click(screen.getByRole('button', { name: 'Delete Stop card 1' }))
    const confirm = screen.getByRole('group', {
      name: 'Confirm deleting Stop card 1',
    })
    expect(
      within(confirm).getByText('Delete this card? This cannot be undone.'),
    ).toBeVisible()
    await waitFor(() => {
      expect(
        within(confirm).getByRole('button', { name: 'Cancel' }),
      ).toHaveFocus()
    })
    fireEvent.click(within(confirm).getByRole('button', { name: 'Cancel' }))
    await waitFor(() => {
      expect(
        screen.getByRole('button', { name: 'Delete Stop card 1' }),
      ).toHaveFocus()
    })

    fireEvent.click(screen.getByRole('button', { name: 'Delete Stop card 1' }))
    fireEvent.keyDown(screen.getByRole('button', { name: 'Cancel' }), {
      key: 'Escape',
    })
    expect(
      screen.queryByText('Delete this card? This cannot be undone.'),
    ).not.toBeInTheDocument()
    expect(cardsMock.deleteCard).not.toHaveBeenCalled()
  })

  it('deletes with exactly the card id, reads Deleting…, and focuses the textarea', async () => {
    const card = makeCard('stop', 'Meetings')
    renderFeedback({ cards: [card] })
    await waitForForm()
    const pending = deferred<undefined>()
    cardsMock.deleteCard.mockImplementationOnce((id) => {
      expect(id).toBe(card.id)
      return pending.promise
    })

    fireEvent.click(screen.getByRole('button', { name: 'Delete Stop card 1' }))
    const confirmButton = screen.getByRole('button', { name: 'Delete card' })
    fireEvent.click(confirmButton)
    fireEvent.click(confirmButton)
    expect(
      await screen.findByRole('button', { name: 'Deleting…' }),
    ).toBeDisabled()
    expect(cardsMock.deleteCard).toHaveBeenCalledTimes(1)
    expect(cardsMock.deleteCard).toHaveBeenCalledWith(card.id)
    expect(
      screen.getByText('Deleting…', { selector: '.sr-only' }),
    ).toHaveAttribute('role', 'status')

    fakeServer([])
    await act(async () => {
      pending.resolve(undefined)
    })

    expect(await screen.findByText('Card deleted.')).toBeInTheDocument()
    expect(
      within(section('stop')).getByText('No Stop cards yet.'),
    ).toBeVisible()
    expect(composer('stop')).toHaveFocus()
  })
})

describe('FeedbackPage failed writes', () => {
  it.each<[CardsErrorCode]>([
    ['unknown'],
    ['invalid_card_text'],
    ['invalid_card_category'],
    ['invalid_card_anonymity'],
  ])(
    'add failing with %s keeps the text and choice and shows the generic message',
    async (code) => {
      renderFeedback({ cards: [makeCard('start', 'Existing')] })
      await waitForForm()
      cardsMock.createCard.mockRejectedValueOnce(new CardsApiError(code, 'add'))
      const scope = section('start')
      const fetches = cardsMock.fetchMyCards.mock.calls.length

      typeInto(composer('start'), 'Typed text')
      fireEvent.click(anonymousBox(scope))
      fireEvent.click(addButton('start'))

      expect(await screen.findByText(GENERIC)).toBeInTheDocument()
      expect(composer('start')).toHaveValue('Typed text')
      expect(anonymousBox(scope)).toBeChecked()
      expect(
        within(scope).getByRole('button', { name: 'Add anonymously' }),
      ).toBeEnabled()
      expect(cardsMock.fetchMyCards.mock.calls.length).toBe(fetches)
      expect(within(scope).getAllByRole('listitem')).toHaveLength(1)
      expect(document.body).not.toHaveTextContent(code)
    },
  )

  it('save failing with an unknown code keeps the editor text', async () => {
    renderFeedback({ cards: [makeCard('start', 'Before')] })
    await waitForForm()
    cardsMock.updateCard.mockRejectedValueOnce(
      new CardsApiError('unknown', 'save'),
    )

    const editor = await openEditor('start', 1)
    typeInto(within(editor).getByRole('textbox'), 'After')
    fireEvent.click(within(editor).getByRole('button', { name: 'Save' }))

    expect(await screen.findByText(GENERIC)).toBeInTheDocument()
    expect(within(editor).getByRole('textbox')).toHaveValue('After')
    expect(within(editor).getByRole('button', { name: 'Save' })).toBeEnabled()
  })

  it('delete failing with an unknown code keeps the card and confirmation', async () => {
    renderFeedback({ cards: [makeCard('start', 'Stay')] })
    await waitForForm()
    cardsMock.deleteCard.mockRejectedValueOnce(
      new CardsApiError('unknown', 'delete'),
    )

    fireEvent.click(screen.getByRole('button', { name: 'Delete Start card 1' }))
    fireEvent.click(screen.getByRole('button', { name: 'Delete card' }))

    expect(await screen.findByText(GENERIC)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Delete card' })).toBeEnabled()
    expect(within(section('start')).getByText('Stay')).toBeVisible()
  })

  it('card_not_found on Save keeps the text on screen and re-reads the list', async () => {
    const card = makeCard('start', 'Gone soon')
    const { server } = renderFeedback({ cards: [card] })
    await waitForForm()

    const editor = await openEditor('start', 1)
    typeInto(within(editor).getByRole('textbox'), 'My rewrite')
    server.cards = []
    fireEvent.click(within(editor).getByRole('button', { name: 'Save' }))

    expect(
      await within(section('start')).findByText('This card no longer exists.'),
    ).toHaveAttribute('role', 'alert')
    await waitFor(() => {
      expect(
        within(section('start')).getByText('No Start cards yet.'),
      ).toBeVisible()
    })
    expect(within(section('start')).getByText('My rewrite')).toBeVisible()
    expect(within(section('start')).getByText('Not saved')).toBeVisible()
  })

  it('card_not_found on Delete says it was already deleted and re-reads the list', async () => {
    const card = makeCard('start', 'Gone soon')
    const { server } = renderFeedback({ cards: [card] })
    await waitForForm()
    cardsMock.deleteCard.mockImplementationOnce(() => {
      server.cards = []
      return Promise.reject(new CardsApiError('card_not_found', 'delete'))
    })

    fireEvent.click(screen.getByRole('button', { name: 'Delete Start card 1' }))
    fireEvent.click(screen.getByRole('button', { name: 'Delete card' }))

    expect(
      await screen.findByText('This card was already deleted.'),
    ).toBeInTheDocument()
    await waitFor(() => {
      expect(
        within(section('start')).getByText('No Start cards yet.'),
      ).toBeVisible()
    })
  })

  it.each<['add' | 'save' | 'delete']>([['add'], ['save'], ['delete']])(
    'not_project_member on %s switches to not found and sends no further card request',
    async (operation) => {
      renderFeedback({ cards: [makeCard('start', 'Mine')] })
      await waitForForm()
      const error = new CardsApiError('not_project_member', operation)
      cardsMock.createCard.mockRejectedValue(error)
      cardsMock.updateCard.mockRejectedValue(error)
      cardsMock.deleteCard.mockRejectedValue(error)

      if (operation === 'add') {
        typeInto(composer('start'), 'New')
        fireEvent.click(addButton('start'))
      } else if (operation === 'save') {
        const editor = await openEditor('start', 1)
        typeInto(within(editor).getByRole('textbox'), 'Changed')
        fireEvent.click(within(editor).getByRole('button', { name: 'Save' }))
      } else {
        fireEvent.click(
          screen.getByRole('button', { name: 'Delete Start card 1' }),
        )
        fireEvent.click(screen.getByRole('button', { name: 'Delete card' }))
      }

      expect(await screen.findByText(NOT_FOUND)).toBeInTheDocument()
      expect(screen.queryByRole('textbox')).not.toBeInTheDocument()
      const counts = [
        cardsMock.fetchMyCards.mock.calls.length,
        cardsMock.createCard.mock.calls.length,
        cardsMock.updateCard.mock.calls.length,
        cardsMock.deleteCard.mock.calls.length,
      ]

      act(() => {
        window.dispatchEvent(new Event('focus'))
        document.dispatchEvent(new Event('visibilitychange'))
        onlineManager.setOnline(false)
        onlineManager.setOnline(true)
      })
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 20))
      })
      expect([
        cardsMock.fetchMyCards.mock.calls.length,
        cardsMock.createCard.mock.calls.length,
        cardsMock.updateCard.mock.calls.length,
        cardsMock.deleteCard.mock.calls.length,
      ]).toEqual(counts)
    },
  )
})

describe('FeedbackPage collection ended', () => {
  it.each<CycleStatus>(['reveal', 'cluster', 'vote', 'discuss', 'closed'])(
    'is read-only while the cycle is %s',
    async (status) => {
      renderFeedback({
        cycle: { ...collectingCycle, status },
        cards: [makeCard('start', 'Mine'), makeCard('stop', 'Quiet', true)],
      })
      await waitForForm()

      expect(screen.getByText(CLOSED_NOTICE)).toBeVisible()
      expect(within(section('start')).getByText('Mine')).toBeVisible()
      expect(
        within(section('start')).getByText('Shows your name'),
      ).toBeVisible()
      expect(within(section('stop')).getByText('Anonymous')).toBeVisible()
      expect(screen.queryByRole('textbox')).not.toBeInTheDocument()
      expect(screen.queryByRole('checkbox')).not.toBeInTheDocument()
      expect(
        screen.queryByRole('button', { name: /^(Edit|Delete|Add)/ }),
      ).not.toBeInTheDocument()
    },
  )

  it('cycle_not_collecting on Add re-reads, goes read-only, and keeps every unsaved text as Not saved', async () => {
    const card = makeCard('continue', 'Retro notes')
    renderFeedback({ cards: [card] })
    await waitForForm()
    cardsMock.createCard.mockImplementationOnce(() => {
      cyclesMock.fetchCycle.mockResolvedValue({
        ...collectingCycle,
        status: 'closed',
      })
      return Promise.reject(new CardsApiError('cycle_not_collecting', 'add'))
    })
    const cycleReads = cyclesMock.fetchCycle.mock.calls.length
    const cardReads = cardsMock.fetchMyCards.mock.calls.length

    typeInto(composer('stop'), 'Unsent stop')
    const editor = await openEditor('continue', 1)
    typeInto(within(editor).getByRole('textbox'), 'Unsent edit')
    typeInto(composer('start'), 'Unsent start')
    fireEvent.click(addButton('start'))

    expect(await screen.findByRole('alert')).toHaveTextContent(ENDED)
    expect(await screen.findByText(CLOSED_NOTICE)).toBeVisible()
    await waitFor(() => {
      expect(cyclesMock.fetchCycle.mock.calls.length).toBeGreaterThan(
        cycleReads,
      )
      expect(cardsMock.fetchMyCards.mock.calls.length).toBeGreaterThan(
        cardReads,
      )
    })
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument()
    expect(screen.queryByRole('checkbox')).not.toBeInTheDocument()
    expect(screen.getByText('Closed')).toBeVisible()

    expect(within(section('start')).getByText('Unsent start')).toBeVisible()
    expect(within(section('stop')).getByText('Unsent stop')).toBeVisible()
    expect(within(section('continue')).getByText('Unsent edit')).toBeVisible()
    expect(within(section('continue')).getByText('Retro notes')).toBeVisible()
    expect(screen.getAllByText('Not saved')).toHaveLength(3)
  })

  it('cycle_not_collecting on Delete also goes read-only', async () => {
    renderFeedback({ cards: [makeCard('start', 'Mine')] })
    await waitForForm()
    cardsMock.deleteCard.mockRejectedValueOnce(
      new CardsApiError('cycle_not_collecting', 'delete'),
    )

    fireEvent.click(screen.getByRole('button', { name: 'Delete Start card 1' }))
    fireEvent.click(screen.getByRole('button', { name: 'Delete card' }))

    expect(await screen.findByText(ENDED)).toHaveAttribute('role', 'alert')
    expect(
      screen.queryByRole('button', { name: /Delete/ }),
    ).not.toBeInTheDocument()
    expect(within(section('start')).getByText('Mine')).toBeVisible()
  })

  it('re-reads the cycle when the window regains focus and goes read-only without a reload', async () => {
    renderFeedback()
    await waitForForm()
    typeInto(composer('start'), 'Half written')
    cyclesMock.fetchCycle.mockResolvedValue({
      ...collectingCycle,
      status: 'reveal',
    })
    const reads = cyclesMock.fetchCycle.mock.calls.length

    act(() => {
      window.dispatchEvent(new Event('focus'))
    })

    expect(await screen.findByText(CLOSED_NOTICE)).toBeVisible()
    expect(cyclesMock.fetchCycle.mock.calls.length).toBe(reads + 1)
    expect(screen.getByText('Revealed')).toBeVisible()
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument()
    expect(within(section('start')).getByText('Half written')).toBeVisible()
    expect(within(section('start')).getByText('Not saved')).toBeVisible()
  })

  it('re-reads the cycle when the tab becomes visible again', async () => {
    renderFeedback()
    await waitForForm()
    cyclesMock.fetchCycle.mockResolvedValue({
      ...collectingCycle,
      status: 'cluster',
    })

    act(() => {
      document.dispatchEvent(new Event('visibilitychange'))
      window.dispatchEvent(new Event('visibilitychange'))
    })

    expect(await screen.findByText(CLOSED_NOTICE)).toBeVisible()
  })
})

describe('FeedbackPage offline', () => {
  it('shows the banner, disables writes, keeps text, and re-reads on reconnect', async () => {
    renderFeedback({ cards: [makeCard('start', 'Mine')] })
    await waitForForm()
    typeInto(composer('stop'), 'Draft')
    fireEvent.click(screen.getByRole('button', { name: 'Delete Start card 1' }))

    act(() => {
      window.dispatchEvent(new Event('offline'))
    })

    const banner = await screen.findByText(OFFLINE)
    expect(banner).toHaveAttribute('role', 'status')
    expect(
      within(section('stop')).getByRole('button', { name: 'Add card' }),
    ).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Delete card' })).toBeDisabled()
    expect(composer('stop')).toHaveValue('Draft')
    fireEvent.click(
      within(section('stop')).getByRole('button', { name: 'Add card' }),
    )
    fireEvent.submit(composer('stop').closest('form') as HTMLFormElement)
    expect(cardsMock.createCard).not.toHaveBeenCalled()

    const cycleReads = cyclesMock.fetchCycle.mock.calls.length
    const cardReads = cardsMock.fetchMyCards.mock.calls.length
    act(() => {
      window.dispatchEvent(new Event('online'))
    })

    await waitFor(() => {
      expect(screen.queryByText(OFFLINE)).not.toBeInTheDocument()
    })
    expect(
      within(section('stop')).getByRole('button', { name: 'Add card' }),
    ).toBeEnabled()
    expect(screen.getByRole('button', { name: 'Delete card' })).toBeEnabled()
    await waitFor(() => {
      expect(cyclesMock.fetchCycle.mock.calls.length).toBeGreaterThan(
        cycleReads,
      )
      expect(cardsMock.fetchMyCards.mock.calls.length).toBeGreaterThan(
        cardReads,
      )
    })
    expect(cardsMock.createCard).not.toHaveBeenCalled()
    expect(cardsMock.deleteCard).not.toHaveBeenCalled()
    expect(composer('stop')).toHaveValue('Draft')
  })

  it('disables Save in an open editor while offline', async () => {
    renderFeedback({ cards: [makeCard('start', 'Mine')] })
    await waitForForm()
    const editor = await openEditor('start', 1)
    typeInto(within(editor).getByRole('textbox'), 'Changed')

    act(() => {
      window.dispatchEvent(new Event('offline'))
    })

    expect(within(editor).getByRole('button', { name: 'Save' })).toBeDisabled()
    expect(within(editor).getByRole('textbox')).toHaveValue('Changed')
  })
})

describe('FeedbackPage leave warning', () => {
  function beforeUnloadPrevented(): boolean {
    const event = new Event('beforeunload', { cancelable: true })
    window.dispatchEvent(event)
    return event.defaultPrevented
  }

  it('warns only while a composer has text or an editor has changes', async () => {
    renderFeedback({ cards: [makeCard('start', 'Mine')] })
    await waitForForm()
    expect(beforeUnloadPrevented()).toBe(false)

    typeInto(composer('continue'), 'Draft')
    expect(beforeUnloadPrevented()).toBe(true)
    typeInto(composer('continue'), '  \n')
    expect(beforeUnloadPrevented()).toBe(false)

    const editor = await openEditor('start', 1)
    expect(beforeUnloadPrevented()).toBe(false)
    typeInto(within(editor).getByRole('textbox'), 'Changed')
    expect(beforeUnloadPrevented()).toBe(true)
    typeInto(within(editor).getByRole('textbox'), 'Mine')
    expect(beforeUnloadPrevented()).toBe(false)
  })
})
