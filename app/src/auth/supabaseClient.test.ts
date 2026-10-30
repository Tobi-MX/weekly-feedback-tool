import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const createClientMock = vi.fn()

describe('supabase client module', () => {
  beforeEach(() => {
    vi.resetModules()
    createClientMock.mockReset()
    vi.doMock('@supabase/supabase-js', () => ({
      createClient: createClientMock,
    }))
  })

  afterEach(() => {
    vi.doUnmock('@supabase/supabase-js')
    vi.doUnmock('../env')
  })

  it('creates no client when the environment is missing', async () => {
    vi.doMock('../env', () => ({
      getEnvConfig: () => ({ status: 'not-configured' }),
    }))

    const { supabase } = await import('./supabaseClient')

    expect(supabase).toBeNull()
    expect(createClientMock).not.toHaveBeenCalled()
  })

  it('creates no client when the configured URL is invalid', async () => {
    vi.doMock('../env', () => ({
      getEnvConfig: () => ({ status: 'not-configured', reason: 'invalid-url' }),
    }))

    const { supabase } = await import('./supabaseClient')

    expect(supabase).toBeNull()
    expect(createClientMock).not.toHaveBeenCalled()
  })

  it('creates one client with persistence, refresh, and no URL detection', async () => {
    const fakeClient = { marker: 'client' }
    createClientMock.mockReturnValue(fakeClient)
    vi.doMock('../env', () => ({
      getEnvConfig: () => ({
        status: 'configured',
        url: 'http://127.0.0.1:54321',
        anonKey: 'test-anon-key',
      }),
    }))

    const { supabase } = await import('./supabaseClient')

    expect(supabase).toBe(fakeClient)
    expect(createClientMock).toHaveBeenCalledTimes(1)
    expect(createClientMock).toHaveBeenCalledWith(
      'http://127.0.0.1:54321',
      'test-anon-key',
      {
        auth: {
          persistSession: true,
          autoRefreshToken: true,
          detectSessionInUrl: false,
        },
      },
    )
  })
})
