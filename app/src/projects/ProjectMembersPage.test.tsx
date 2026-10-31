import { act, fireEvent, screen, waitFor, within } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { deferred, mockRestoredSession } from '../test/authMock'
import { membersMock } from '../test/membersMock'
import { profileMock } from '../test/profileMock'
import { projectsMock } from '../test/projectsMock'
import { renderApp } from '../test/renderApp'
import type { ProjectInvite, ProjectMember } from './membersApi'
import { MembersApiError } from './membersErrors'
import type { ProjectSummary } from './projectsApi'

const OWNER_ID = 'user-owner'
const MEMBER_ID = 'user-member'
const OTHER_ID = 'user-other'
const TOKEN = '0123456789abcdef'.repeat(4)

const project: ProjectSummary = {
  id: '10000000-0000-4000-8000-000000000001',
  name: 'Alpha Project',
  created_at: '2026-10-30T12:00:00.000Z',
}

function member(
  overrides: Partial<ProjectMember> & Pick<ProjectMember, 'userId'>,
): ProjectMember {
  return {
    displayName: 'Someone',
    role: 'member',
    isOwner: false,
    isMe: false,
    joinedAt: '2026-10-30T12:00:00.000Z',
    ...overrides,
  }
}

function membersFor(meId: string): ProjectMember[] {
  return [
    member({
      userId: OWNER_ID,
      displayName: 'Alice',
      role: 'facilitator',
      isOwner: true,
      isMe: meId === OWNER_ID,
    }),
    member({ userId: MEMBER_ID, displayName: 'Bob', isMe: meId === MEMBER_ID }),
    member({ userId: OTHER_ID, displayName: 'Cara', isMe: meId === OTHER_ID }),
  ]
}

const activeInvite: ProjectInvite = {
  token: TOKEN,
  expiresAt: '2026-11-06T12:00:00.000Z',
  status: 'active',
}

const inviteUrl = `${window.location.origin}/join/${TOKEN}`

function renderMembers(meId: string, path = `/projects/${project.id}/members`) {
  mockRestoredSession('dev@example.com', meId)
  profileMock.fetchProfileDisplayName.mockResolvedValue('Dev User')
  return renderApp({ initialEntries: [path] })
}

function renderAsOwner(invite: ProjectInvite | null = activeInvite) {
  projectsMock.fetchProject.mockResolvedValue(project)
  membersMock.fetchProjectMembers.mockResolvedValue(membersFor(OWNER_ID))
  membersMock.fetchProjectInvite.mockResolvedValue(invite)
  return renderMembers(OWNER_ID)
}

async function findMemberRow(name: string): Promise<HTMLElement> {
  const list = await screen.findByRole('list', { name: 'Members' })
  const label = within(list).getByText(name)
  const row = label.closest('li')
  if (!row) {
    throw new Error(`No row for ${name}`)
  }
  return row
}

describe('ProjectMembersPage as the owner', () => {
  it('lists members with role labels, the Owner badge, and (you)', async () => {
    renderAsOwner()

    expect(
      await screen.findByRole('heading', { name: 'Alpha Project', level: 1 }),
    ).toBeInTheDocument()
    const alice = await findMemberRow('Alice')
    expect(alice).toHaveTextContent('Facilitator')
    expect(alice).toHaveTextContent('Owner')
    expect(alice).toHaveTextContent('(you)')
    const bob = await findMemberRow('Bob')
    expect(bob).toHaveTextContent('Member')
    expect(bob).not.toHaveTextContent('Owner')
    expect(bob).not.toHaveTextContent('(you)')
    expect(membersMock.fetchProjectMembers).toHaveBeenCalledWith(project.id)
  })

  it('shows "No invite link yet." and creates a link', async () => {
    renderAsOwner(null)

    expect(await screen.findByText('No invite link yet.')).toBeInTheDocument()
    membersMock.createProjectInvite.mockResolvedValue({
      token: TOKEN,
      expiresAt: activeInvite.expiresAt,
    })
    membersMock.fetchProjectInvite.mockResolvedValue(activeInvite)

    fireEvent.click(screen.getByRole('button', { name: 'Create invite link' }))

    expect(await screen.findByDisplayValue(inviteUrl)).toBeInTheDocument()
    expect(membersMock.createProjectInvite).toHaveBeenCalledTimes(1)
    expect(membersMock.createProjectInvite).toHaveBeenCalledWith(project.id)
    expect(membersMock.fetchProjectInvite).toHaveBeenCalledTimes(2)
  })

  it('shows the active link, expiry, and the three actions', async () => {
    renderAsOwner()

    const input = await screen.findByLabelText('Share this link')
    expect(input).toHaveValue(inviteUrl)
    expect(input).toHaveAttribute('readonly')
    expect(input.className).toContain('min-w-0')
    expect(screen.getByText('Expires Nov 6, 2026')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Copy link' })).toBeVisible()
    expect(
      screen.getByRole('button', { name: 'Create new link' }),
    ).toBeVisible()
    expect(screen.getByRole('button', { name: 'Disable link' })).toBeVisible()
  })

  it('shows the expired state without a Copy button', async () => {
    renderAsOwner({ ...activeInvite, status: 'expired' })

    expect(
      await screen.findByText('This invite link has expired.'),
    ).toBeInTheDocument()
    expect(
      screen.getByRole('button', { name: 'Create new link' }),
    ).toBeVisible()
    expect(
      screen.queryByRole('button', { name: 'Copy link' }),
    ).not.toBeInTheDocument()
    expect(screen.queryByDisplayValue(inviteUrl)).not.toBeInTheDocument()
  })

  it('shows the revoked state', async () => {
    renderAsOwner({ ...activeInvite, status: 'revoked' })

    expect(
      await screen.findByText('This invite link is disabled.'),
    ).toBeInTheDocument()
    expect(
      screen.getByRole('button', { name: 'Create new link' }),
    ).toBeVisible()
    expect(
      screen.queryByRole('button', { name: 'Copy link' }),
    ).not.toBeInTheDocument()
  })

  it('copies the link and shows a toast', async () => {
    const writeText = vi.fn<(text: string) => Promise<void>>()
    writeText.mockResolvedValue(undefined)
    vi.stubGlobal('navigator', { ...navigator, clipboard: { writeText } })
    renderAsOwner()

    fireEvent.click(await screen.findByRole('button', { name: 'Copy link' }))

    expect(await screen.findByText('Invite link copied.')).toBeInTheDocument()
    expect(writeText).toHaveBeenCalledWith(inviteUrl)
  })

  it('shows a manual-copy message when the clipboard rejects', async () => {
    const writeText = vi.fn<(text: string) => Promise<void>>()
    writeText.mockRejectedValue(new Error('denied'))
    vi.stubGlobal('navigator', { ...navigator, clipboard: { writeText } })
    renderAsOwner()

    fireEvent.click(await screen.findByRole('button', { name: 'Copy link' }))

    expect(
      await screen.findByText(
        'Could not copy. Select the link and copy it manually.',
      ),
    ).toBeInTheDocument()
    expect(screen.getByLabelText('Share this link')).toHaveValue(inviteUrl)
  })

  it('shows a manual-copy message when the clipboard API is missing', async () => {
    vi.stubGlobal('navigator', { ...navigator, clipboard: undefined })
    renderAsOwner()

    fireEvent.click(await screen.findByRole('button', { name: 'Copy link' }))

    expect(
      await screen.findByText(
        'Could not copy. Select the link and copy it manually.',
      ),
    ).toBeInTheDocument()
    expect(screen.getByLabelText('Share this link')).toHaveValue(inviteUrl)
  })

  it('cancelling the rotate confirmation makes no request', async () => {
    renderAsOwner()

    fireEvent.click(
      await screen.findByRole('button', { name: 'Create new link' }),
    )
    const confirm = screen.getByRole('group', {
      name: 'Confirm new invite link',
    })
    expect(confirm).toHaveTextContent(
      'Anyone with the current link will no longer be able to join.',
    )
    fireEvent.click(within(confirm).getByRole('button', { name: 'Cancel' }))

    expect(
      screen.queryByRole('group', { name: 'Confirm new invite link' }),
    ).not.toBeInTheDocument()
    expect(membersMock.createProjectInvite).not.toHaveBeenCalled()
  })

  it('confirming rotate creates a new link and renders it', async () => {
    renderAsOwner()
    const newToken = 'f'.repeat(64)
    membersMock.createProjectInvite.mockResolvedValue({
      token: newToken,
      expiresAt: activeInvite.expiresAt,
    })

    fireEvent.click(
      await screen.findByRole('button', { name: 'Create new link' }),
    )
    membersMock.fetchProjectInvite.mockResolvedValue({
      ...activeInvite,
      token: newToken,
    })
    fireEvent.click(
      screen.getByRole('button', { name: 'Yes, create new link' }),
    )

    expect(
      await screen.findByDisplayValue(
        `${window.location.origin}/join/${newToken}`,
      ),
    ).toBeInTheDocument()
    expect(membersMock.createProjectInvite).toHaveBeenCalledTimes(1)
  })

  it('a failed rotate shows a toast and keeps the previous link', async () => {
    renderAsOwner()
    membersMock.createProjectInvite.mockRejectedValue(
      new MembersApiError('unknown'),
    )

    fireEvent.click(
      await screen.findByRole('button', { name: 'Create new link' }),
    )
    fireEvent.click(
      screen.getByRole('button', { name: 'Yes, create new link' }),
    )

    expect(
      await screen.findByText('Could not update the invite link. Try again.'),
    ).toBeInTheDocument()
    expect(screen.getByLabelText('Share this link')).toHaveValue(inviteUrl)
  })

  it('cancelling the disable confirmation makes no request', async () => {
    renderAsOwner()

    fireEvent.click(await screen.findByRole('button', { name: 'Disable link' }))
    const confirm = screen.getByRole('group', {
      name: 'Confirm disabling the invite link',
    })
    expect(confirm).toHaveTextContent(
      'Anyone with the current link will no longer be able to join.',
    )
    fireEvent.click(within(confirm).getByRole('button', { name: 'Cancel' }))

    expect(membersMock.revokeProjectInvite).not.toHaveBeenCalled()
    expect(screen.getByRole('button', { name: 'Disable link' })).toBeVisible()
  })

  it('confirming disable revokes the link and renders the disabled state', async () => {
    renderAsOwner()
    membersMock.revokeProjectInvite.mockResolvedValue(undefined)

    fireEvent.click(await screen.findByRole('button', { name: 'Disable link' }))
    membersMock.fetchProjectInvite.mockResolvedValue({
      ...activeInvite,
      status: 'revoked',
    })
    fireEvent.click(screen.getByRole('button', { name: 'Yes, disable link' }))

    expect(
      await screen.findByText('This invite link is disabled.'),
    ).toBeInTheDocument()
    expect(membersMock.revokeProjectInvite).toHaveBeenCalledWith(project.id)
  })

  it('a failed disable shows a toast and keeps the active link', async () => {
    renderAsOwner()

    fireEvent.click(await screen.findByRole('button', { name: 'Disable link' }))
    fireEvent.click(screen.getByRole('button', { name: 'Yes, disable link' }))

    expect(
      await screen.findByText('Could not update the invite link. Try again.'),
    ).toBeInTheDocument()
    expect(screen.getByLabelText('Share this link')).toHaveValue(inviteUrl)
  })

  it('transfers the facilitator role after confirmation', async () => {
    renderAsOwner()
    membersMock.transferFacilitator.mockResolvedValue(undefined)

    const bob = await findMemberRow('Bob')
    expect(
      within(await findMemberRow('Alice')).queryByRole('button', {
        name: 'Make facilitator',
      }),
    ).not.toBeInTheDocument()
    fireEvent.click(
      within(bob).getByRole('button', { name: 'Make facilitator' }),
    )
    const confirm = within(bob).getByRole('group', {
      name: 'Confirm facilitator change',
    })
    expect(confirm).toHaveTextContent('Make Bob the facilitator?')

    membersMock.fetchProjectMembers.mockResolvedValue([
      member({
        userId: OWNER_ID,
        displayName: 'Alice',
        role: 'member',
        isOwner: true,
        isMe: true,
      }),
      member({ userId: MEMBER_ID, displayName: 'Bob', role: 'facilitator' }),
      member({ userId: OTHER_ID, displayName: 'Cara' }),
    ])
    fireEvent.click(within(confirm).getByRole('button', { name: 'Confirm' }))

    await waitFor(async () => {
      expect(await findMemberRow('Bob')).toHaveTextContent('Facilitator')
    })
    expect(await findMemberRow('Alice')).toHaveTextContent('Member')
    expect(
      within(await findMemberRow('Alice')).getByRole('button', {
        name: 'Make facilitator',
      }),
    ).toBeVisible()
    expect(membersMock.transferFacilitator).toHaveBeenCalledWith(
      project.id,
      MEMBER_ID,
    )
  })

  it('cancelling the transfer makes no request', async () => {
    renderAsOwner()

    const bob = await findMemberRow('Bob')
    fireEvent.click(
      within(bob).getByRole('button', { name: 'Make facilitator' }),
    )
    fireEvent.click(within(bob).getByRole('button', { name: 'Cancel' }))

    expect(membersMock.transferFacilitator).not.toHaveBeenCalled()
    expect(
      within(bob).getByRole('button', { name: 'Make facilitator' }),
    ).toBeVisible()
  })

  it('a failed transfer shows a toast and keeps the roles', async () => {
    renderAsOwner()

    const bob = await findMemberRow('Bob')
    fireEvent.click(
      within(bob).getByRole('button', { name: 'Make facilitator' }),
    )
    fireEvent.click(within(bob).getByRole('button', { name: 'Confirm' }))

    expect(
      await screen.findByText('Could not change the facilitator. Try again.'),
    ).toBeInTheDocument()
    expect(await findMemberRow('Alice')).toHaveTextContent('Facilitator')
    expect(await findMemberRow('Bob')).toHaveTextContent('Member')
  })

  it('a double click on Confirm sends one request and disables the button while pending', async () => {
    renderAsOwner()
    const pending = deferred<void>()
    membersMock.transferFacilitator.mockReturnValue(pending.promise)

    const bob = await findMemberRow('Bob')
    fireEvent.click(
      within(bob).getByRole('button', { name: 'Make facilitator' }),
    )
    const confirmButton = within(bob).getByRole('button', { name: 'Confirm' })
    fireEvent.click(confirmButton)
    fireEvent.click(confirmButton)

    await waitFor(() => {
      expect(confirmButton).toBeDisabled()
    })
    expect(membersMock.transferFacilitator).toHaveBeenCalledTimes(1)

    await act(async () => {
      pending.resolve()
    })
  })

  it('wraps a 100-character display name inside its row', async () => {
    const longName = 'N'.repeat(100)
    projectsMock.fetchProject.mockResolvedValue(project)
    membersMock.fetchProjectMembers.mockResolvedValue([
      ...membersFor(OWNER_ID),
      member({ userId: 'user-long', displayName: longName }),
    ])
    membersMock.fetchProjectInvite.mockResolvedValue(activeInvite)
    renderMembers(OWNER_ID)

    const name = await screen.findByText(longName)
    expect(name.className).toContain('[overflow-wrap:anywhere]')
    expect(name.className).toContain('min-w-0')
  })
})

describe('ProjectMembersPage as a non-owner', () => {
  it.each([
    ['a plain member', false],
    ['a non-owner facilitator', true],
  ])(
    'shows the list to %s without invite or transfer controls',
    async (_label, isFacilitator) => {
      projectsMock.fetchProject.mockResolvedValue(project)
      membersMock.fetchProjectMembers.mockResolvedValue([
        member({
          userId: OWNER_ID,
          displayName: 'Alice',
          role: isFacilitator ? 'member' : 'facilitator',
          isOwner: true,
        }),
        member({
          userId: MEMBER_ID,
          displayName: 'Bob',
          role: isFacilitator ? 'facilitator' : 'member',
          isMe: true,
        }),
      ])
      renderMembers(MEMBER_ID)

      const bob = await findMemberRow('Bob')
      expect(bob).toHaveTextContent('(you)')
      expect(await findMemberRow('Alice')).toHaveTextContent('Owner')
      expect(
        screen.queryByRole('heading', { name: 'Invite link' }),
      ).not.toBeInTheDocument()
      expect(
        screen.queryByRole('button', { name: 'Make facilitator' }),
      ).not.toBeInTheDocument()
      expect(membersMock.fetchProjectInvite).not.toHaveBeenCalled()
    },
  )
})

describe('ProjectMembersPage states', () => {
  it('shows a loading status while members are pending', async () => {
    projectsMock.fetchProject.mockResolvedValue(project)
    const pending = deferred<ProjectMember[] | null>()
    membersMock.fetchProjectMembers.mockReturnValue(pending.promise)
    renderMembers(OWNER_ID)

    expect(await screen.findByText('Loading members…')).toHaveAttribute(
      'role',
      'status',
    )

    await act(async () => {
      pending.resolve(null)
    })
  })

  it('shows an alert and retries after a failure', async () => {
    projectsMock.fetchProject.mockResolvedValue(project)
    membersMock.fetchProjectMembers
      .mockRejectedValueOnce(new MembersApiError('unknown'))
      .mockResolvedValueOnce(membersFor(MEMBER_ID))
    renderMembers(MEMBER_ID)

    const alert = await screen.findByRole('alert')
    expect(alert).toHaveTextContent('Could not load the members.')
    fireEvent.click(within(alert).getByRole('button', { name: 'Retry' }))

    expect(await findMemberRow('Bob')).toBeInTheDocument()
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
    expect(membersMock.fetchProjectMembers).toHaveBeenCalledTimes(2)
  })

  it.each([
    ['a non-member', '10000000-0000-4000-8000-000000000098'],
    ['an unknown id', '10000000-0000-4000-8000-000000000099'],
    ['a non-UUID id', 'project-1'],
  ])('shows the not-found state for %s', async (_label, id) => {
    projectsMock.fetchProject.mockResolvedValue(null)
    membersMock.fetchProjectMembers.mockResolvedValue(null)
    renderMembers(MEMBER_ID, `/projects/${id}/members`)

    expect(
      await screen.findByText('Project not found or you do not have access.'),
    ).toBeInTheDocument()
    expect(
      screen.getByRole('link', { name: 'Back to projects' }),
    ).toHaveAttribute('href', '/projects')
    expect(screen.queryByRole('list', { name: 'Members' })).toBeNull()
    expect(screen.queryByText('Alice')).toBeNull()
    expect(membersMock.fetchProjectInvite).not.toHaveBeenCalled()
  })
})
