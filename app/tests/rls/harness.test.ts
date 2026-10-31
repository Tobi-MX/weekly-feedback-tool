import { beforeAll, describe, expect, it } from 'vitest'
import { expectNoRows, expectPgError, expectRows } from './assertions'
import {
  CLI_MISSING_MESSAGE,
  NON_LOCAL_MESSAGE,
  NOT_REACHABLE_MESSAGE,
  assertLocalUrl,
  parseStatusEnv,
  resolveEnv,
} from './env'
import {
  anonClient,
  createProject,
  createUser,
  emailFor,
  signInFailureMessage,
  type ProfileRow,
  type ProjectMemberRow,
  type TestUser,
} from './fixtures'

describe('harness self-tests', () => {
  let users: TestUser[]

  beforeAll(async () => {
    users = await Promise.all([
      createUser('harness-1'),
      createUser('harness-2'),
      createUser('harness-3'),
    ])
  })

  it('each signed-in user client returns its own user id', async () => {
    for (const user of users) {
      const { data, error } = await user.client.auth.getUser()
      expect(error).toBeNull()
      expect(data.user?.id).toBe(user.id)
      expect(data.user?.email).toBe(emailFor(user.label))
    }
  })

  it('each user selecting profiles sees only their own row', async () => {
    for (const user of users) {
      const rows = expectRows<ProfileRow>(
        await user.client.from('profiles').select(),
        1,
      )
      expect(rows[0].id).toBe(user.id)
      expect(rows[0].display_name).toBe(user.label)
    }
  })

  it('anonClient has no session', async () => {
    const { data, error } = await anonClient().auth.getSession()
    expect(error).toBeNull()
    expect(data.session).toBeNull()
  })

  it('expectNoRows rejects a 42501 error result', async () => {
    const result = await anonClient().from('profiles').select()
    expectPgError(result, '42501')
    expect(() => expectNoRows(result)).toThrow()
  })

  it('expectPgError rejects an empty successful result', async () => {
    const [owner, outsider] = users
    const project = await createProject(owner)
    const result = await outsider.client
      .from('projects')
      .select()
      .eq('id', project.id)
    expectNoRows(result)
    expect(() => expectPgError(result, '42501')).toThrow()
  })

  it('expectRows(result, 1) rejects two rows', async () => {
    const [owner] = users
    const project = await createProject(owner)
    const second = await createProject(owner)
    const result = await owner.client
      .from('project_members')
      .select()
      .in('project_id', [project.id, second.id])
    expectRows<ProjectMemberRow>(result, 2)
    expect(() => expectRows(result, 1)).toThrow()
  })

  it('expectPgError rejects the wrong message', async () => {
    const result = await anonClient().from('profiles').select()
    expect(() => expectPgError(result, '42501', 'not_project_member')).toThrow()
  })
})

describe('harness guards', () => {
  it('refuses a non-local SUPABASE_URL before sending anything', async () => {
    expect(() => assertLocalUrl('https://example.supabase.co')).toThrow(
      NON_LOCAL_MESSAGE,
    )
    await expect(
      resolveEnv({
        SUPABASE_URL: 'https://example.supabase.co',
        SUPABASE_ANON_KEY: 'anon',
        SUPABASE_SERVICE_ROLE_KEY: 'service',
      }),
    ).rejects.toThrow(NON_LOCAL_MESSAGE)
  })

  it('accepts the local hostnames', () => {
    for (const url of [
      'http://127.0.0.1:54321',
      'http://localhost:54321',
      'http://[::1]:54321',
    ]) {
      expect(() => assertLocalUrl(url)).not.toThrow()
    }
  })

  it('prefers values already in the environment', async () => {
    const env = await resolveEnv({
      SUPABASE_URL: 'http://localhost:9999/',
      SUPABASE_ANON_KEY: 'anon-from-env',
      SUPABASE_SERVICE_ROLE_KEY: 'service-from-env',
    })
    expect(env).toEqual({
      url: 'http://localhost:9999',
      anonKey: 'anon-from-env',
      serviceRoleKey: 'service-from-env',
    })
  })

  it('parses supabase status env output', () => {
    const parsed = parseStatusEnv(
      'API_URL="http://127.0.0.1:54321"\nANON_KEY="a.b.c"\nOTHER=plain\nnoise\n',
    )
    expect(parsed.get('API_URL')).toBe('http://127.0.0.1:54321')
    expect(parsed.get('ANON_KEY')).toBe('a.b.c')
    expect(parsed.get('OTHER')).toBe('plain')
    expect(parsed.size).toBe(3)
  })

  it('names the local rate limit and its config setting on HTTP 429', () => {
    const message = signInFailureMessage('someone', 429, 'Too many requests')
    expect(message).toContain('local auth rate limit')
    expect(message).toContain('sign_in_sign_ups')
    expect(message).toContain('supabase/config.toml')
  })

  it('setup messages say what to do', () => {
    expect(NOT_REACHABLE_MESSAGE).toContain('supabase start')
    expect(NOT_REACHABLE_MESSAGE).toContain('supabase db reset')
    expect(CLI_MISSING_MESSAGE).toContain('Install the Supabase CLI')
  })
})
