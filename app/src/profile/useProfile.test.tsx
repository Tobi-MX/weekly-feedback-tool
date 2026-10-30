import { act, fireEvent, screen, waitFor, within } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { queryClient } from '../lib/queryClient'
import {
  authMock,
  deferred,
  makeSession,
  makeUser,
  mockEmptySession,
  mockRestoredSession,
} from '../test/authMock'
import { profileMock } from '../test/profileMock'
import { renderApp } from '../test/renderApp'
import { profileQueryKey } from './useProfile'

function openUserMenu(): HTMLElement {
  const trigger = screen.getByRole('button', { name: /Account menu for/ })
  fireEvent.pointerDown(trigger, { button: 0, ctrlKey: false })
  return trigger
}

function profileCache(userId: string | null) {
  return queryClient.getQueryCache().find({
    queryKey: profileQueryKey(userId),
  })
}

interface UnhandledRejectionProcess {
  on(event: 'unhandledRejection', listener: (reason: unknown) => void): void
  off(event: 'unhandledRejection', listener: (reason: unknown) => void): void
}

/** Vitest runs in Node, but the app tsconfig only includes browser types. */
function nodeProcess(): UnhandledRejectionProcess | undefined {
  return (
    globalThis as typeof globalThis & {
      process?: UnhandledRejectionProcess
    }
  ).process
}

describe('useProfileDisplay', () => {
  it('shows the profile display name and email in the user menu', async () => {
    mockRestoredSession()
    profileMock.fetchProfileDisplayName.mockResolvedValue('Dev User')

    renderApp({ initialEntries: ['/projects'] })

    const trigger = await screen.findByRole('button', {
      name: 'Account menu for Dev User',
    })
    expect(profileMock.fetchProfileDisplayName).toHaveBeenCalledWith('user-1')

    fireEvent.pointerDown(trigger, { button: 0, ctrlKey: false })
    const menu = await screen.findByRole('menu')

    expect(within(menu).getByText('Dev User')).toBeInTheDocument()
    expect(within(menu).getByText('dev@example.com')).toBeInTheDocument()
    expect(within(menu).queryByText('undefined')).not.toBeInTheDocument()
  })

  it('falls back to the email while the profile query is pending', async () => {
    mockRestoredSession()
    const pending = deferred<string | null>()
    profileMock.fetchProfileDisplayName.mockReturnValue(pending.promise)

    renderApp({ initialEntries: ['/projects'] })

    await screen.findByRole('heading', { name: 'Projects' })
    const trigger = await screen.findByRole('button', {
      name: 'Account menu for dev@example.com',
    })

    fireEvent.pointerDown(trigger, { button: 0, ctrlKey: false })
    const menu = await screen.findByRole('menu')
    expect(within(menu).getAllByText('dev@example.com')).toHaveLength(1)
    expect(within(menu).queryByText('undefined')).not.toBeInTheDocument()

    await act(async () => {
      pending.resolve(null)
    })
  })

  it.each([
    ['a null row', null],
    ['an empty name', ''],
    ['a whitespace-only name', '   '],
  ])('falls back to the email for %s', async (_label, displayName) => {
    mockRestoredSession()
    profileMock.fetchProfileDisplayName.mockResolvedValue(displayName)

    renderApp({ initialEntries: ['/projects'] })

    await screen.findByRole('heading', { name: 'Projects' })
    expect(
      await screen.findByRole('button', {
        name: 'Account menu for dev@example.com',
      }),
    ).toBeInTheDocument()

    openUserMenu()
    const menu = await screen.findByRole('menu')
    expect(within(menu).queryByText('undefined')).not.toBeInTheDocument()
    expect(within(menu).getByText('dev@example.com')).toBeInTheDocument()
  })

  it('falls back to the email when the profile query fails without breaking the shell', async () => {
    mockRestoredSession()
    profileMock.fetchProfileDisplayName.mockRejectedValue(
      new Error('profile unavailable'),
    )
    authMock.signOut.mockResolvedValue({ error: null })
    const unhandledRejections: unknown[] = []
    const onUnhandledRejection = (reason: unknown) => {
      unhandledRejections.push(reason)
    }
    nodeProcess()?.on('unhandledRejection', onUnhandledRejection)

    try {
      renderApp({ initialEntries: ['/projects'] })

      await screen.findByRole('heading', { name: 'Projects' })
      const trigger = await screen.findByRole('button', {
        name: 'Account menu for dev@example.com',
      })
      expect(screen.getByRole('link', { name: 'Projects' })).toBeInTheDocument()
      expect(
        screen.getByRole('link', { name: 'Weekly Feedback Tool' }),
      ).toBeInTheDocument()

      fireEvent.pointerDown(trigger, { button: 0, ctrlKey: false })
      fireEvent.click(await screen.findByRole('menuitem', { name: 'Sign out' }))

      await screen.findByRole('heading', { name: 'Sign in' })
      expect(authMock.signOut).toHaveBeenCalledTimes(1)

      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 20))
      })
      expect(unhandledRejections).toEqual([])
    } finally {
      nodeProcess()?.off('unhandledRejection', onUnhandledRejection)
    }
  })

  it('uses a non-blank label when the account has no email', async () => {
    authMock.getSession.mockResolvedValue({
      session: makeSession('', {
        user: { ...makeUser('', 'user-1'), email: undefined },
      }),
      error: null,
    })
    profileMock.fetchProfileDisplayName.mockResolvedValue(null)

    renderApp({ initialEntries: ['/projects'] })

    const trigger = await screen.findByRole('button', {
      name: 'Account menu for Account',
    })
    fireEvent.pointerDown(trigger, { button: 0, ctrlKey: false })
    const menu = await screen.findByRole('menu')
    expect(within(menu).getByText('Account')).toBeInTheDocument()
  })

  it('does not request a profile before a session resolves or when signed out', async () => {
    mockEmptySession()

    renderApp({ initialEntries: ['/projects'] })

    expect(screen.getByText('Loading…')).toBeInTheDocument()
    await waitFor(() => {
      expect(screen.getByTestId('location')).toHaveTextContent(
        '/login?redirectTo=%2Fprojects',
      )
    })
    expect(screen.getByLabelText('Email')).toBeInTheDocument()
    expect(profileMock.fetchProfileDisplayName).not.toHaveBeenCalled()
  })

  it('clears cached profile data when the signed-in user id changes', async () => {
    mockRestoredSession('alice@example.com', 'user-a')
    profileMock.fetchProfileDisplayName.mockImplementation((userId) =>
      Promise.resolve(userId === 'user-a' ? 'Alice' : 'Bob'),
    )

    renderApp({ initialEntries: ['/projects'] })

    await screen.findByRole('button', { name: 'Account menu for Alice' })
    await waitFor(() => {
      expect(profileCache('user-a')).toBeDefined()
    })

    act(() => {
      authMock.emitAuthEvent(
        'SIGNED_IN',
        makeSession('bob@example.com', {
          user: makeUser('bob@example.com', 'user-b'),
        }),
      )
    })

    expect(
      await screen.findByRole('button', { name: 'Account menu for Bob' }),
    ).toBeInTheDocument()
    await waitFor(() => {
      expect(profileMock.fetchProfileDisplayName).toHaveBeenCalledWith('user-b')
      expect(profileCache('user-b')).toBeDefined()
    })
    expect(profileCache('user-a')).toBeUndefined()
  })
})
