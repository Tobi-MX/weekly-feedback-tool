import type { AuthVerifier } from '../../_shared/auth.ts'
import type { ClusterModel, ClusterModelRequest, ClusterModelResponse } from '../anthropicModel.ts'
import type { ClusterDb, ClusterRpc, HandlerDeps, RpcResult } from '../handler.ts'
import { createHandler } from '../handler.ts'

/**
 * Small synthetic fixtures and injected mocks for the cluster-feedback tests.
 * Nothing here touches the network: the model, Auth, and the RPCs are mocks.
 */

export const CYCLE_ID = '3a000000-0000-4000-8000-000000000001'
export const PROJECT_ID = '2a000000-0000-4000-8000-000000000001'
export const USER_ID = '1a000000-0000-4000-8000-000000000001'
export const RUN_ID = '6a000000-0000-4000-8000-000000000001'
export const API_KEY = 'sk-ant-test-key-value-never-logged'
export const NOW = Date.UTC(2026, 10, 2, 12, 0, 0)

function base64Url(text: string): string {
  return btoa(text).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

/** An unsigned JWT-shaped token; the auth mock decides whether it is valid. */
export function makeJwt(claims: Record<string, unknown>): string {
  return [
    base64Url(JSON.stringify({ alg: 'HS256', typ: 'JWT' })),
    base64Url(JSON.stringify(claims)),
    base64Url('signature'),
  ].join('.')
}

export const VALID_JWT = makeJwt({ sub: USER_ID, role: 'authenticated', exp: NOW / 1000 + 3600 })
export const EXPIRED_JWT = makeJwt({ sub: USER_ID, role: 'authenticated', exp: NOW / 1000 - 60 })

export interface FixtureCard {
  readonly card_id: string
  readonly category: 'start' | 'stop' | 'continue'
  readonly text: string
}

/** Five cards in begin order: by category, then card id. */
export const CARDS: readonly FixtureCard[] = [
  {
    card_id: '5a000000-0000-4000-8000-000000000001',
    category: 'start',
    text: 'Pair on tricky reviews',
  },
  {
    card_id: '5a000000-0000-4000-8000-000000000002',
    category: 'start',
    text: 'Review pull requests the same day',
  },
  {
    card_id: '5a000000-0000-4000-8000-000000000003',
    category: 'stop',
    text: 'Merging on Friday evenings',
  },
  {
    card_id: '5a000000-0000-4000-8000-000000000004',
    category: 'stop',
    text: 'Skipping the release checklist',
  },
  {
    card_id: '5a000000-0000-4000-8000-000000000005',
    category: 'continue',
    text: 'Short daily standups',
  },
]

export const MANUAL_NAMES: readonly string[] = ['Team rituals']

export function beginData(
  cards: readonly FixtureCard[] = CARDS,
  slots = 49,
): Record<string, unknown> {
  return { run_id: RUN_ID, cards, manual_cluster_names: MANUAL_NAMES, cluster_slots: slots }
}

/** A model answer whose text is the given JSON value. */
export function answer(
  output: unknown,
  overrides: Partial<ClusterModelResponse> = {},
): ClusterModelResponse {
  return {
    model: 'claude-opus-5-5',
    stop_reason: 'end_turn',
    content: [
      { type: 'thinking' },
      { type: 'text', text: typeof output === 'string' ? output : JSON.stringify(output) },
    ],
    usage: { input_tokens: 812, output_tokens: 245 },
    request_id: 'req_fixture_0001',
    ...overrides,
  }
}

/** A valid answer: two clusters, one ungrouped card. */
export const VALID_OUTPUT = {
  clusters: [
    { name: 'Code review speed', category: 'start', card_refs: ['c2', 'c1'] },
    { name: 'Release discipline', category: 'stop', card_refs: ['c3', 'c4'] },
  ],
  ungrouped_card_refs: ['c5'],
}

export class MockModel implements ClusterModel {
  readonly requests: ClusterModelRequest[] = []
  constructor(private readonly respond: () => Promise<ClusterModelResponse>) {}
  create(request: ClusterModelRequest): Promise<ClusterModelResponse> {
    this.requests.push(request)
    return this.respond()
  }
}

export interface RpcCall {
  readonly name: ClusterRpc
  readonly args: Record<string, unknown>
}

export class MockDb implements ClusterDb {
  readonly calls: RpcCall[] = []
  constructor(private readonly results: Partial<Record<ClusterRpc, RpcResult>> = {}) {}
  rpc(name: ClusterRpc, args: Record<string, unknown>): Promise<RpcResult> {
    this.calls.push({ name, args })
    const defaults: Record<ClusterRpc, RpcResult> = {
      begin_ai_clustering: { data: beginData(), error: null },
      replace_ai_clusters: { data: { cluster_count: 0, clustered_card_count: 0 }, error: null },
      finish_ai_run: { data: null, error: null },
    }
    return Promise.resolve(this.results[name] ?? defaults[name])
  }
  named(name: ClusterRpc): RpcCall[] {
    return this.calls.filter((call) => call.name === name)
  }
}

export class MockAuth implements AuthVerifier {
  readonly tokens: string[] = []
  constructor(private readonly userId: string | null = USER_ID) {}
  getUserId(jwt: string): Promise<string | null> {
    this.tokens.push(jwt)
    return Promise.resolve(this.userId)
  }
}

export interface Harness {
  readonly handle: (req: Request) => Promise<Response>
  readonly model: MockModel
  readonly modelKeys: string[]
  readonly db: MockDb
  readonly auth: MockAuth
  readonly logs: string[]
}

export interface HarnessOptions {
  readonly respond?: () => Promise<ClusterModelResponse>
  readonly db?: MockDb
  readonly auth?: MockAuth
  readonly env?: Record<string, string>
}

export function harness(options: HarnessOptions = {}): Harness {
  const model = new MockModel(options.respond ?? (() => Promise.resolve(answer(VALID_OUTPUT))))
  const db = options.db ?? new MockDb()
  const auth = options.auth ?? new MockAuth()
  const env: Record<string, string> = options.env ?? { ANTHROPIC_API_KEY: API_KEY }
  const logs: string[] = []
  const modelKeys: string[] = []
  let clock = NOW
  const deps: HandlerDeps = {
    env: (name) => env[name],
    auth,
    db,
    createModel: (apiKey) => {
      modelKeys.push(apiKey)
      return model
    },
    now: () => {
      clock += 5
      return clock
    },
    log: (line) => logs.push(line),
  }
  return { handle: createHandler(deps), model, modelKeys, db, auth, logs }
}

export function post(
  body: unknown,
  headers: Record<string, string> = { authorization: `Bearer ${VALID_JWT}` },
): Request {
  return new Request('http://localhost/functions/v1/cluster-feedback', {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  })
}

/** Every key the log line may have, in order. */
export const LOG_KEYS = [
  'function',
  'run_id',
  'cycle_id',
  'code',
  'http_status',
  'duration_ms',
  'provider_request_id',
  'input_tokens',
  'output_tokens',
  'response_model',
]
