import { beforeEach, describe, expect, it, vi } from 'vitest'
import { MembersApiError, type MembersErrorCode } from './membersErrors'

const state = vi.hoisted(() => ({ client: null as unknown }))

vi.mock('../auth/supabaseClient', () => ({
  get supabase() {
    return state.client
  },
}))

const {
  fetchProjectMembers,
  fetchProjectInvite,
  createProjectInvite,
  revokeProjectInvite,
  joinProject,
  transferFacilitator,
} = await vi.importActual<typeof import('./membersApi')>('./membersApi')

interface RpcResult {
  readonly data: unknown
  readonly error: { readonly message: string; readonly code?: string } | null
}

const PROJECT_ID = '10000000-0000-4000-8000-000000000001'
const USER_ID = '20000000-0000-4000-8000-000000000002'
const TOKEN = 'a'.repeat(64)

function createRpcMock() {
  const rpc =
    vi.fn<(name: string, args: Record<string, unknown>) => Promise<RpcResult>>()
  const from = vi.fn()
  state.client = { rpc, from }
  return { rpc, from }
}

async function captureError(promise: Promise<unknown>): Promise<unknown> {
  return promise.then(
    () => {
      throw new Error('expected a rejection')
    },
    (reason: unknown) => reason,
  )
}

beforeEach(() => {
  state.client = null
  vi.spyOn(console, 'error')
  vi.spyOn(console, 'warn')
  vi.spyOn(console, 'log')
})

describe('RPC names and arguments', () => {
  it('fetchProjectMembers calls get_project_members and maps rows', async () => {
    const { rpc, from } = createRpcMock()
    rpc.mockResolvedValue({
      data: [
        {
          user_id: USER_ID,
          display_name: 'Bob',
          role: 'facilitator',
          is_owner: false,
          is_me: true,
          joined_at: '2026-10-30T12:00:00+00:00',
        },
      ],
      error: null,
    })

    await expect(fetchProjectMembers(PROJECT_ID)).resolves.toEqual([
      {
        userId: USER_ID,
        displayName: 'Bob',
        role: 'facilitator',
        isOwner: false,
        isMe: true,
        joinedAt: '2026-10-30T12:00:00+00:00',
      },
    ])
    expect(rpc).toHaveBeenCalledTimes(1)
    expect(rpc).toHaveBeenCalledWith('get_project_members', {
      p_project_id: PROJECT_ID,
    })
    expect(from).not.toHaveBeenCalled()
  })

  it('fetchProjectInvite calls get_project_invite and maps the row', async () => {
    const { rpc, from } = createRpcMock()
    rpc.mockResolvedValue({
      data: [
        {
          token: TOKEN,
          expires_at: '2026-11-06T12:00:00+00:00',
          status: 'active',
        },
      ],
      error: null,
    })

    await expect(fetchProjectInvite(PROJECT_ID)).resolves.toEqual({
      token: TOKEN,
      expiresAt: '2026-11-06T12:00:00+00:00',
      status: 'active',
    })
    expect(rpc).toHaveBeenCalledWith('get_project_invite', {
      p_project_id: PROJECT_ID,
    })
    expect(from).not.toHaveBeenCalled()
  })

  it('fetchProjectInvite returns null when no invite exists', async () => {
    const { rpc } = createRpcMock()
    rpc.mockResolvedValue({ data: [], error: null })

    await expect(fetchProjectInvite(PROJECT_ID)).resolves.toBeNull()
  })

  it('createProjectInvite calls create_project_invite', async () => {
    const { rpc } = createRpcMock()
    rpc.mockResolvedValue({
      data: [{ token: TOKEN, expires_at: '2026-11-06T12:00:00+00:00' }],
      error: null,
    })

    await expect(createProjectInvite(PROJECT_ID)).resolves.toEqual({
      token: TOKEN,
      expiresAt: '2026-11-06T12:00:00+00:00',
    })
    expect(rpc).toHaveBeenCalledWith('create_project_invite', {
      p_project_id: PROJECT_ID,
    })
  })

  it('revokeProjectInvite calls revoke_project_invite', async () => {
    const { rpc } = createRpcMock()
    rpc.mockResolvedValue({ data: null, error: null })

    await expect(revokeProjectInvite(PROJECT_ID)).resolves.toBeUndefined()
    expect(rpc).toHaveBeenCalledWith('revoke_project_invite', {
      p_project_id: PROJECT_ID,
    })
  })

  it('joinProject calls join_project with the token', async () => {
    const { rpc } = createRpcMock()
    rpc.mockResolvedValue({
      data: [
        {
          project_id: PROJECT_ID,
          project_name: 'Alpha',
          already_member: false,
        },
      ],
      error: null,
    })

    await expect(joinProject(TOKEN)).resolves.toEqual({
      projectId: PROJECT_ID,
      projectName: 'Alpha',
      alreadyMember: false,
    })
    expect(rpc).toHaveBeenCalledWith('join_project', { p_token: TOKEN })
  })

  it('transferFacilitator calls transfer_facilitator with both ids', async () => {
    const { rpc } = createRpcMock()
    rpc.mockResolvedValue({ data: null, error: null })

    await expect(
      transferFacilitator(PROJECT_ID, USER_ID),
    ).resolves.toBeUndefined()
    expect(rpc).toHaveBeenCalledWith('transfer_facilitator', {
      p_project_id: PROJECT_ID,
      p_user_id: USER_ID,
    })
  })
})

describe('guards that skip the network', () => {
  it.each(['not-a-uuid', '', ' project-1 '])(
    'fetchProjectMembers returns null for the non-UUID id %j without calling the RPC',
    async (projectId) => {
      const { rpc } = createRpcMock()

      await expect(fetchProjectMembers(projectId)).resolves.toBeNull()
      expect(rpc).not.toHaveBeenCalled()
    },
  )

  it.each(['short', 'A'.repeat(64), 'g'.repeat(64), 'a'.repeat(65), ''])(
    'joinProject rejects the malformed token %j as invite_invalid without calling the RPC',
    async (token) => {
      const { rpc } = createRpcMock()

      const error = await captureError(joinProject(token))

      expect(error).toBeInstanceOf(MembersApiError)
      expect((error as MembersApiError).code).toBe('invite_invalid')
      expect(rpc).not.toHaveBeenCalled()
    },
  )

  it('fetchProjectMembers returns null for not_project_member', async () => {
    const { rpc } = createRpcMock()
    rpc.mockResolvedValue({
      data: null,
      error: { message: 'not_project_member', code: '42501' },
    })

    await expect(fetchProjectMembers(PROJECT_ID)).resolves.toBeNull()
  })

  it('mutations reject with a generic error when Supabase is not configured', async () => {
    state.client = null

    const error = await captureError(createProjectInvite(PROJECT_ID))
    expect(error).toBeInstanceOf(MembersApiError)
    expect((error as MembersApiError).code).toBe('unknown')
  })
})

describe('error mapping', () => {
  const cases: ReadonlyArray<
    readonly [MembersErrorCode, string, string, () => Promise<unknown>]
  > = [
    [
      'not_project_owner',
      '42501',
      'Only the project owner can do that.',
      () => createProjectInvite(PROJECT_ID),
    ],
    [
      'not_project_member',
      '42501',
      'Project not found or you do not have access.',
      () => transferFacilitator(PROJECT_ID, USER_ID),
    ],
    [
      'invite_invalid',
      'P0001',
      'This invite link is not valid. Ask the project owner for a new link.',
      () => joinProject(TOKEN),
    ],
    [
      'invite_expired',
      'P0001',
      'This invite link has expired. Ask the project owner for a new link.',
      () => joinProject(TOKEN),
    ],
    [
      'target_not_member',
      'P0001',
      'That person is not a member of this project.',
      () => transferFacilitator(PROJECT_ID, USER_ID),
    ],
  ]

  it.each(cases)(
    'maps %s to its stable code and a generic message',
    async (code, sqlState, message, call) => {
      const { rpc } = createRpcMock()
      rpc.mockResolvedValue({
        data: null,
        error: { message: code, code: sqlState },
      })

      const error = await captureError(call())

      expect(error).toBeInstanceOf(MembersApiError)
      expect((error as MembersApiError).code).toBe(code)
      expect((error as MembersApiError).message).toBe(message)
    },
  )

  it.each([
    [
      'get_project_members',
      () => fetchProjectMembers(PROJECT_ID),
      'Could not load the members.',
    ],
    [
      'get_project_invite',
      () => fetchProjectInvite(PROJECT_ID),
      'Could not load the invite link.',
    ],
    [
      'create_project_invite',
      () => createProjectInvite(PROJECT_ID),
      'Could not update the invite link.',
    ],
    [
      'revoke_project_invite',
      () => revokeProjectInvite(PROJECT_ID),
      'Could not update the invite link.',
    ],
    ['join_project', () => joinProject(TOKEN), 'Could not join the project.'],
    [
      'transfer_facilitator',
      () => transferFacilitator(PROJECT_ID, USER_ID),
      'Could not change the facilitator.',
    ],
  ] as const)(
    '%s maps an unknown error to a generic message without raw text or the token',
    async (_name, call, message) => {
      const { rpc } = createRpcMock()
      rpc.mockResolvedValue({
        data: null,
        error: {
          message: `permission denied for table project_invites ${TOKEN}`,
          code: '42501',
        },
      })

      const error = await captureError(call())

      expect(error).toBeInstanceOf(MembersApiError)
      expect((error as MembersApiError).code).toBe('unknown')
      expect((error as MembersApiError).message).toBe(message)
      expect((error as MembersApiError).message).not.toContain('permission')
      expect((error as MembersApiError).message).not.toContain(TOKEN)
      expect(console.error).not.toHaveBeenCalled()
      expect(console.warn).not.toHaveBeenCalled()
      expect(console.log).not.toHaveBeenCalled()
    },
  )

  it('treats a malformed RPC row as an unknown failure', async () => {
    const { rpc } = createRpcMock()
    rpc.mockResolvedValue({
      data: [{ user_id: USER_ID, display_name: 'Bob', role: 'owner' }],
      error: null,
    })

    const error = await captureError(fetchProjectMembers(PROJECT_ID))

    expect(error).toBeInstanceOf(MembersApiError)
    expect((error as MembersApiError).message).toBe(
      'Could not load the members.',
    )
  })
})
