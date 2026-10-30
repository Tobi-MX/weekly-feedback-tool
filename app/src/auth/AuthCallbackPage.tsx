import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { useLocation, useNavigate } from 'react-router-dom'
import { useAuth } from './AuthProvider'
import AuthConfigurationNotice from './AuthConfigurationNotice'
import AuthLoading from './AuthLoading'
import { buildLoginPath, safeRedirectPath } from './redirectPath'

const AUTH_PARAM_KEYS = [
  'access_token',
  'refresh_token',
  'code',
  'error',
  'error_code',
  'error_description',
] as const

const ERROR_PARAM_KEYS = ['error', 'error_code', 'error_description'] as const

export interface CallbackParams {
  readonly accessToken: string | null
  readonly refreshToken: string | null
  readonly hasError: boolean
  readonly hasAuthParams: boolean
  readonly redirectTo: string
}

function readParam(
  query: URLSearchParams,
  fragment: URLSearchParams,
  key: string,
): string | null {
  return query.get(key) ?? fragment.get(key)
}

/**
 * Reads magic-link credentials from both the query string and the hash. The
 * implicit flow puts `access_token` and `refresh_token` in the hash; the
 * removal list also covers the PKCE `code` and OAuth-style error fields.
 */
export function parseCallbackParams(
  search: string,
  hash: string,
): CallbackParams {
  const query = new URLSearchParams(search)
  const fragment = new URLSearchParams(
    hash.startsWith('#') ? hash.slice(1) : hash,
  )

  const hasAuthParams = AUTH_PARAM_KEYS.some(
    (key) => query.has(key) || fragment.has(key),
  )
  const hasError = ERROR_PARAM_KEYS.some(
    (key) => readParam(query, fragment, key) !== null,
  )

  return {
    accessToken: readParam(query, fragment, 'access_token'),
    refreshToken: readParam(query, fragment, 'refresh_token'),
    hasError,
    hasAuthParams,
    redirectTo: safeRedirectPath(
      query.get('redirectTo') ?? fragment.get('redirectTo'),
    ),
  }
}

export function AuthCallbackPage() {
  const { status, completeMagicLink } = useAuth()
  const location = useLocation()
  const navigate = useNavigate()
  const [params] = useState(() =>
    parseCallbackParams(location.search, location.hash),
  )
  const cleanedRef = useRef(false)
  const startedRef = useRef(false)

  // Remove token material from the address bar and the current history entry
  // before anything other than the loading view can render. The parsed values
  // are already held in component state, so a reload or Back cannot reuse
  // them.
  useLayoutEffect(() => {
    if (cleanedRef.current) {
      return
    }
    cleanedRef.current = true

    if (params.hasAuthParams) {
      navigate('/auth/callback', { replace: true })
    }
  }, [navigate, params.hasAuthParams])

  useEffect(() => {
    if (status === 'loading' || status === 'unconfigured') {
      return
    }

    if (status === 'authenticated') {
      if (startedRef.current) {
        return
      }
      startedRef.current = true
      navigate(params.redirectTo, { replace: true })
      return
    }

    if (startedRef.current) {
      return
    }
    startedRef.current = true

    const accessToken = params.accessToken
    const refreshToken = params.refreshToken

    if (params.hasError || !accessToken || !refreshToken) {
      navigate(buildLoginPath(params.redirectTo), {
        replace: true,
        state: { authError: 'invalid-link' },
      })
      return
    }

    void (async () => {
      const result = await completeMagicLink(accessToken, refreshToken)

      if (result.ok) {
        navigate(params.redirectTo, { replace: true })
      } else {
        navigate(buildLoginPath(params.redirectTo), {
          replace: true,
          state: { authError: 'invalid-link' },
        })
      }
    })()
  }, [status, navigate, completeMagicLink, params])

  if (status === 'unconfigured') {
    return <AuthConfigurationNotice />
  }

  return <AuthLoading />
}

export default AuthCallbackPage
