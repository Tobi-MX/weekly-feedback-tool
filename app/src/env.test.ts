import { describe, expect, it } from 'vitest'
import { parseEnvConfig } from './env'

const URL = 'http://127.0.0.1:54321'
const ANON_KEY = 'local-anon-key'

describe('parseEnvConfig', () => {
  it('returns a configured result when both values are present', () => {
    expect(
      parseEnvConfig({
        VITE_SUPABASE_URL: URL,
        VITE_SUPABASE_ANON_KEY: ANON_KEY,
      }),
    ).toEqual({
      status: 'configured',
      url: URL,
      anonKey: ANON_KEY,
    })
  })

  it('is not configured when the URL is missing', () => {
    expect(parseEnvConfig({ VITE_SUPABASE_ANON_KEY: ANON_KEY })).toEqual({
      status: 'not-configured',
    })
  })

  it('is not configured when the anon key is missing', () => {
    expect(parseEnvConfig({ VITE_SUPABASE_URL: URL })).toEqual({
      status: 'not-configured',
    })
  })

  it('is not configured when both values are missing', () => {
    expect(parseEnvConfig({})).toEqual({ status: 'not-configured' })
  })

  it('is not configured when a value is empty', () => {
    expect(
      parseEnvConfig({
        VITE_SUPABASE_URL: '',
        VITE_SUPABASE_ANON_KEY: ANON_KEY,
      }),
    ).toEqual({ status: 'not-configured' })

    expect(
      parseEnvConfig({ VITE_SUPABASE_URL: URL, VITE_SUPABASE_ANON_KEY: '' }),
    ).toEqual({ status: 'not-configured' })
  })

  it('is not configured when a value is whitespace only', () => {
    expect(
      parseEnvConfig({
        VITE_SUPABASE_URL: '   ',
        VITE_SUPABASE_ANON_KEY: ANON_KEY,
      }),
    ).toEqual({ status: 'not-configured' })

    expect(
      parseEnvConfig({
        VITE_SUPABASE_URL: URL,
        VITE_SUPABASE_ANON_KEY: '\t\n ',
      }),
    ).toEqual({ status: 'not-configured' })
  })

  it('trims surrounding whitespace from both values', () => {
    expect(
      parseEnvConfig({
        VITE_SUPABASE_URL: `  ${URL}  `,
        VITE_SUPABASE_ANON_KEY: `  ${ANON_KEY}\n`,
      }),
    ).toEqual({
      status: 'configured',
      url: URL,
      anonKey: ANON_KEY,
    })
  })

  it('removes a trailing slash from the URL', () => {
    expect(
      parseEnvConfig({
        VITE_SUPABASE_URL: `${URL}/`,
        VITE_SUPABASE_ANON_KEY: ANON_KEY,
      }),
    ).toEqual({
      status: 'configured',
      url: URL,
      anonKey: ANON_KEY,
    })
  })

  it('removes multiple trailing slashes from the URL', () => {
    expect(
      parseEnvConfig({
        VITE_SUPABASE_URL: `${URL}///`,
        VITE_SUPABASE_ANON_KEY: ANON_KEY,
      }),
    ).toEqual({
      status: 'configured',
      url: URL,
      anonKey: ANON_KEY,
    })
  })

  it('keeps a URL path intact', () => {
    expect(
      parseEnvConfig({
        VITE_SUPABASE_URL: 'https://example.test/supabase/',
        VITE_SUPABASE_ANON_KEY: ANON_KEY,
      }),
    ).toEqual({
      status: 'configured',
      url: 'https://example.test/supabase',
      anonKey: ANON_KEY,
    })
  })
})
