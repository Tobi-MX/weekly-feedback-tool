import { useCallback, useEffect, useState } from 'react'
import { getEnvConfig } from './env'

const CHECK_TIMEOUT_MS = 5_000

type BackendStatusValue =
  'checking' | 'connected' | 'unreachable' | 'not-configured'

const STATUS_LABELS: Record<BackendStatusValue, string> = {
  checking: 'Checking…',
  connected: 'Connected',
  unreachable: 'Unreachable',
  'not-configured': 'Not configured',
}

export function BackendStatus() {
  const [config] = useState(getEnvConfig)
  const [status, setStatus] = useState<BackendStatusValue>(() =>
    config.status === 'configured' ? 'checking' : 'not-configured',
  )
  const [attempt, setAttempt] = useState(0)

  useEffect(() => {
    if (config.status !== 'configured') {
      return
    }

    const controller = new AbortController()
    let cancelled = false

    const timeoutId = window.setTimeout(() => {
      controller.abort()
    }, CHECK_TIMEOUT_MS)

    const check = async () => {
      try {
        const response = await fetch(`${config.url}/rest/v1/`, {
          headers: {
            apikey: config.anonKey,
            Authorization: `Bearer ${config.anonKey}`,
          },
          signal: controller.signal,
        })

        if (!response.ok) {
          throw new Error('Local Supabase responded with a non-2xx status')
        }

        if (!cancelled) {
          setStatus('connected')
        }
      } catch {
        if (!cancelled) {
          setStatus('unreachable')
        }
      } finally {
        window.clearTimeout(timeoutId)
      }
    }

    void check()

    return () => {
      cancelled = true
      window.clearTimeout(timeoutId)
      controller.abort()
    }
  }, [attempt, config])

  const retry = useCallback(() => {
    setStatus('checking')
    setAttempt((value) => value + 1)
  }, [])

  return (
    <section aria-labelledby="backend-status-heading">
      <h2 id="backend-status-heading">Local backend</h2>
      <p role="status" aria-live="polite">
        Backend status: {STATUS_LABELS[status]}
      </p>
      {status === 'not-configured' && (
        <p>
          Copy <code>app/.env.example</code> to <code>app/.env.local</code>,
          then restart the dev server.
        </p>
      )}
      {status === 'unreachable' && (
        <p>
          Could not reach the local Supabase API. Check that the stack is
          running (<code>supabase start</code>) and that the URL and anon key in{' '}
          <code>app/.env.local</code> are correct.
        </p>
      )}
      {config.status === 'configured' && (
        <button type="button" onClick={retry} disabled={status === 'checking'}>
          Retry
        </button>
      )}
    </section>
  )
}

export default BackendStatus
