import { describe, expect, it } from 'vitest'
import {
  buildLoginPath,
  DEFAULT_REDIRECT_PATH,
  safeRedirectPath,
} from './redirectPath'

const ORIGIN = 'http://localhost:5173'

describe('safeRedirectPath', () => {
  it.each([
    ['/projects', '/projects'],
    ['/projects/1?tab=members', '/projects/1?tab=members'],
    ['/projects/1?tab=members#votes', '/projects/1?tab=members'],
    ['%2Fprojects%3Ftab%3Dmembers', '/projects?tab=members'],
    ['  /projects  ', '/projects'],
  ])('accepts the internal path %s', (value, expected) => {
    expect(safeRedirectPath(value, ORIGIN)).toBe(expected)
  })

  it.each([
    ['an absolute external URL', 'https://evil.example'],
    ['a protocol-relative URL', '//evil.example'],
    ['a backslash-smuggled URL', '/\\evil.example'],
    ['a javascript URL', 'javascript:alert(1)'],
    ['a data URL', 'data:text/html,<h1>owned</h1>'],
    ['a relative path without a leading slash', 'projects'],
    ['an empty value', ''],
    ['a whitespace-only value', '   '],
    ['the login route', '/login'],
    ['the login route with a query', '/login?redirectTo=%2Fprojects'],
    ['the callback route', '/auth/callback'],
    [
      'the callback route with a query',
      '/auth/callback?redirectTo=%2Fprojects',
    ],
    ['a missing value', null],
    ['an undefined value', undefined],
  ])('falls back to /projects for %s', (_label, value) => {
    expect(safeRedirectPath(value, ORIGIN)).toBe(DEFAULT_REDIRECT_PATH)
  })

  it.each([
    ['a percent-encoded protocol-relative URL', '%2F%2Fevil.example'],
    ['a percent-encoded absolute external URL', 'https%3A%2F%2Fevil.example'],
    ['a doubly encoded protocol-relative URL', '%252F%252Fevil.example'],
    ['a percent-encoded backslash URL', '%2F%5Cevil.example'],
  ])('decodes before validating %s', (_label, value) => {
    expect(safeRedirectPath(value, ORIGIN)).toBe(DEFAULT_REDIRECT_PATH)
  })

  it('preserves the query and drops the fragment', () => {
    expect(safeRedirectPath('/projects/1?tab=members#section', ORIGIN)).toBe(
      '/projects/1?tab=members',
    )
  })

  it('rejects a path that resolves against another origin', () => {
    expect(safeRedirectPath('/projects', ORIGIN)).toBe('/projects')
    expect(safeRedirectPath('http://evil.example/projects', ORIGIN)).toBe(
      DEFAULT_REDIRECT_PATH,
    )
  })
})

describe('buildLoginPath', () => {
  it('encodes a valid target exactly once', () => {
    expect(buildLoginPath('/projects?tab=members')).toBe(
      '/login?redirectTo=%2Fprojects%3Ftab%3Dmembers',
    )

    const params = new URLSearchParams(
      buildLoginPath('/projects?tab=members').split('?')[1],
    )
    expect(params.get('redirectTo')).toBe('/projects?tab=members')
  })

  it('falls back to /projects for an unsafe target', () => {
    expect(buildLoginPath('https://evil.example')).toBe(
      '/login?redirectTo=%2Fprojects',
    )
  })

  it('never uses the /login or /auth/callback routes as a target', () => {
    expect(buildLoginPath('/login')).toBe('/login?redirectTo=%2Fprojects')
    expect(buildLoginPath('/auth/callback')).toBe(
      '/login?redirectTo=%2Fprojects',
    )
  })
})
