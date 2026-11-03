import {
  FunctionsFetchError,
  FunctionsHttpError,
  FunctionsRelayError,
} from '@supabase/supabase-js'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  AI_FUNCTION_ERRORS,
  aiClusteringErrorCodeOf,
  AiClusteringError,
  keepErrorCodeOf,
  KeepAiClustersError,
  type AiFunctionErrorCode,
} from './aiClusteringErrors'

const state = vi.hoisted(() => ({ client: null as unknown }))

vi.mock('../auth/supabaseClient', () => ({
  get supabase() {
    return state.client
  },
}))

const { requestAiClusters, acceptAiClusters } =
  await vi.importActual<typeof import('./aiClusteringApi')>('./aiClusteringApi')

const CYCLE_ID = '30000000-0000-4000-8000-000000000001'
const RUN_ID = '60000000-0000-4000-8000-000000000001'
const SERVER_MESSAGE = 'Secret server sentence that must never surface.'

interface InvokeResult {
  readonly data: unknown
  readonly error: unknown
}

type InvokeFn = (
  name: string,
  options: { readonly body: unknown; readonly headers?: unknown },
) => Promise<InvokeResult>

interface RpcResult {
  readonly data: unknown
  readonly error: { readonly message: string } | null
}

function createClientMock(
  invokeResult: InvokeResult | (() => Promise<InvokeResult>),
  rpcResult: RpcResult = { data: null, error: null },
) {
  const invoke = vi.fn<InvokeFn>(
    typeof invokeResult === 'function'
      ? invokeResult
      : () => Promise.resolve(invokeResult),
  )
  const rpc = vi.fn<
    (name: string, args: Record<string, unknown>) => Promise<RpcResult>
  >(() => Promise.resolve(rpcResult))
  const from = vi.fn()
  state.client = { functions: { invoke }, rpc, from }
  return { invoke, rpc, from }
}

function httpError(status: number, body: string): InvokeResult {
  return {
    data: null,
    error: new FunctionsHttpError(
      new Response(body, {
        status,
        headers: { 'Content-Type': 'application/json' },
      }),
    ),
  }
}

function errorBody(code: string): string {
  return JSON.stringify({ error: { code, message: SERVER_MESSAGE } })
}

async function captureError(promise: Promise<unknown>): Promise<unknown> {
  return promise.then(
    () => {
      throw new Error('expected a rejection')
    },
    (reason: unknown) => reason,
  )
}

async function codeOf(promise: Promise<unknown>) {
  const error = await captureError(promise)
  expect(error).toBeInstanceOf(AiClusteringError)
  expect(String(error)).not.toContain(SERVER_MESSAGE)
  expect(JSON.stringify(error)).not.toContain(SERVER_MESSAGE)
  return aiClusteringErrorCodeOf(error)
}

const success = {
  run_id: RUN_ID,
  cluster_count: 3,
  clustered_card_count: 5,
  ungrouped_card_count: 2,
}

beforeEach(() => {
  state.client = null
  vi.spyOn(console, 'error')
  vi.spyOn(console, 'warn')
  vi.spyOn(console, 'log')
})

describe('requestAiClusters', () => {
  it('invokes cluster-feedback once with exactly { cycle_id } and no headers', async () => {
    const fake = createClientMock({ data: success, error: null })

    await requestAiClusters(CYCLE_ID)

    expect(fake.invoke).toHaveBeenCalledTimes(1)
    const [name, options] = fake.invoke.mock.calls[0]
    expect(name).toBe('cluster-feedback')
    expect(options).toEqual({ body: { cycle_id: CYCLE_ID } })
    expect(Object.keys(options)).toEqual(['body'])
    expect(options.headers).toBeUndefined()
    expect(fake.rpc).not.toHaveBeenCalled()
    expect(fake.from).not.toHaveBeenCalled()
  })

  it('resolves a 200 with the four counts', async () => {
    createClientMock({ data: success, error: null })

    await expect(requestAiClusters(CYCLE_ID)).resolves.toEqual({
      runId: RUN_ID,
      clusterCount: 3,
      clusteredCardCount: 5,
      ungroupedCardCount: 2,
    })
  })

  it.each([
    ['an extra key', { ...success, model: 'x' }],
    [
      'a missing key',
      { run_id: RUN_ID, cluster_count: 3, clustered_card_count: 5 },
    ],
    ['a negative count', { ...success, ungrouped_card_count: -1 }],
    ['a fractional count', { ...success, cluster_count: 1.5 }],
    ['a run id that is not a uuid', { ...success, run_id: 'run-1' }],
    ['a null body', null],
    ['a string body', 'ok'],
  ])('maps a 200 with %s to unknown', async (_label, data) => {
    createClientMock({ data, error: null })

    expect(await codeOf(requestAiClusters(CYCLE_ID))).toBe('unknown')
  })

  it.each(
    Object.entries(AI_FUNCTION_ERRORS) as [AiFunctionErrorCode, number][],
  )(
    'maps %s (HTTP %i) to its code without keeping the message',
    async (code, status) => {
      createClientMock(httpError(status, errorBody(code)))

      expect(await codeOf(requestAiClusters(CYCLE_ID))).toBe(code)
    },
  )

  it('covers all 17 of #20 codes', () => {
    expect(Object.keys(AI_FUNCTION_ERRORS)).toHaveLength(17)
  })

  it.each([
    ['an unknown code', 409, errorBody('something_else')],
    ['a non-JSON body', 500, 'Internal Server Error'],
    [
      'an extra key',
      502,
      JSON.stringify({
        error: { code: 'ai_refused', message: SERVER_MESSAGE },
        detail: 'x',
      }),
    ],
    [
      'an extra key in error',
      502,
      JSON.stringify({
        error: { code: 'ai_refused', message: SERVER_MESSAGE, hint: 'x' },
      }),
    ],
    ['a missing message', 503, JSON.stringify({ error: { code: 'x' } })],
    ['the runtime shape on a non-401', 403, '{"code":"FORBIDDEN","msg":"x"}'],
  ])('maps %s to unknown', async (_label, status, body) => {
    createClientMock(httpError(status, body))

    expect(await codeOf(requestAiClusters(CYCLE_ID))).toBe('unknown')
  })

  it.each([
    ['a non-JSON body', 'Unauthorized'],
    [
      "the runtime's UNAUTHORIZED_JWT body",
      JSON.stringify({ code: 'UNAUTHORIZED_JWT', message: 'Invalid JWT' }),
    ],
    ['an unknown code', errorBody('something_else')],
    ['an empty body', ''],
  ])('maps any 401 (%s) to not_authenticated', async (_label, body) => {
    createClientMock(httpError(401, body))

    expect(await codeOf(requestAiClusters(CYCLE_ID))).toBe('not_authenticated')
  })

  it('maps a FunctionsFetchError to network_error', async () => {
    createClientMock({
      data: null,
      error: new FunctionsFetchError(new TypeError('Failed to fetch')),
    })

    expect(await codeOf(requestAiClusters(CYCLE_ID))).toBe('network_error')
  })

  it('maps a thrown fetch to network_error', async () => {
    createClientMock(() => Promise.reject(new TypeError('Failed to fetch')))

    expect(await codeOf(requestAiClusters(CYCLE_ID))).toBe('network_error')
  })

  it('maps a FunctionsRelayError to unknown', async () => {
    createClientMock({
      data: null,
      error: new FunctionsRelayError({ status: 502 }),
    })

    expect(await codeOf(requestAiClusters(CYCLE_ID))).toBe('unknown')
  })

  it('maps any other error to unknown', async () => {
    createClientMock({ data: null, error: new Error(SERVER_MESSAGE) })

    expect(await codeOf(requestAiClusters(CYCLE_ID))).toBe('unknown')
  })

  it('is unknown without a configured client', async () => {
    expect(await codeOf(requestAiClusters(CYCLE_ID))).toBe('unknown')
  })

  it('logs nothing', async () => {
    createClientMock(httpError(502, errorBody('ai_refused')))

    await captureError(requestAiClusters(CYCLE_ID))

    expect(console.error).not.toHaveBeenCalled()
    expect(console.warn).not.toHaveBeenCalled()
    expect(console.log).not.toHaveBeenCalled()
  })
})

describe('acceptAiClusters', () => {
  it('calls accept_ai_clusters once with { p_cycle_id } and returns the count', async () => {
    const fake = createClientMock(
      { data: null, error: null },
      { data: 2, error: null },
    )

    await expect(acceptAiClusters(CYCLE_ID)).resolves.toBe(2)

    expect(fake.rpc).toHaveBeenCalledTimes(1)
    expect(fake.rpc).toHaveBeenCalledWith('accept_ai_clusters', {
      p_cycle_id: CYCLE_ID,
    })
    expect(fake.invoke).not.toHaveBeenCalled()
  })

  it('returns 0', async () => {
    createClientMock({ data: null, error: null }, { data: 0, error: null })

    await expect(acceptAiClusters(CYCLE_ID)).resolves.toBe(0)
  })

  it.each([
    'not_project_member',
    'not_project_facilitator',
    'cycle_not_clustering',
  ] as const)('maps %s', async (code) => {
    createClientMock(
      { data: null, error: null },
      { data: null, error: { message: code } },
    )

    const error = await captureError(acceptAiClusters(CYCLE_ID))
    expect(error).toBeInstanceOf(KeepAiClustersError)
    expect(keepErrorCodeOf(error)).toBe(code)
  })

  it.each([
    ['another error', { data: null, error: { message: 'cluster_not_found' } }],
    ['a non-integer', { data: 1.5, error: null }],
    ['a negative count', { data: -1, error: null }],
    ['a string', { data: '2', error: null }],
    ['null', { data: null, error: null }],
  ] as const)('maps %s to unknown', async (_label, result) => {
    createClientMock({ data: null, error: null }, result)

    expect(
      keepErrorCodeOf(await captureError(acceptAiClusters(CYCLE_ID))),
    ).toBe('unknown')
  })

  it('maps a thrown call to unknown', async () => {
    const fake = createClientMock({ data: null, error: null })
    fake.rpc.mockRejectedValue(new TypeError('Failed to fetch'))

    expect(
      keepErrorCodeOf(await captureError(acceptAiClusters(CYCLE_ID))),
    ).toBe('unknown')
  })
})
