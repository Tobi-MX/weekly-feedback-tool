import { type AuthVerifier, bearerToken } from '../_shared/auth.ts'
import { allowedOrigin } from '../_shared/cors.ts'
import { errorResponse, jsonResponse, preflightResponse } from '../_shared/http.ts'
import { type LogSink, writeRequestLog } from '../_shared/log.ts'
import {
  classifyProviderError,
  type ClusterModel,
  type ClusterModelRequest,
  type ClusterModelResponse,
} from './anthropicModel.ts'
import {
  CLUSTER_EFFORT,
  CLUSTER_FALLBACKS,
  CLUSTER_MAX_TOKENS,
  CLUSTER_MODEL,
  type ErrorCode,
  ERRORS,
  FALLBACK_BETA,
  FUNCTION_NAME,
  isErrorCode,
  MAX_BODY_BYTES,
  MIN_CARDS_FOR_MODEL,
} from './config.ts'
import { buildUserMessage, PROMPT_VERSION, type PromptCard, SYSTEM_PROMPT } from './prompt.ts'
import { type Category, CLUSTER_OUTPUT_JSON_SCHEMA, isCategory } from './schema.ts'
import { validateAnswer } from './validate.ts'

/**
 * The cluster-feedback request handler. Everything it talks to is injected:
 * the environment, Supabase Auth, the three service-role RPCs, the model, the
 * clock, and the log sink. It reads no table and never reads card_authors or
 * profiles.
 *
 * Flow: CORS and method, body, JWT, API key, then
 *   1. begin_ai_clustering (locks, checks, records a running run),
 *   2. the model call and validation, with no transaction open,
 *   3. replace_ai_clusters (locks again, stale check, one write), or
 *      finish_ai_run with the error code on any failure after step 1.
 */

/** A database error, narrowed to its message (the stable error code). */
export interface RpcError {
  readonly message: string
}

export interface RpcResult {
  readonly data: unknown
  readonly error: RpcError | null
}

export type ClusterRpc = 'begin_ai_clustering' | 'replace_ai_clusters' | 'finish_ai_run'

/** The service-role RPC client. Used only after the JWT is verified. */
export interface ClusterDb {
  rpc(name: ClusterRpc, args: Record<string, unknown>): Promise<RpcResult>
}

export interface HandlerDeps {
  readonly env: (name: string) => string | undefined
  readonly auth: AuthVerifier
  readonly db: ClusterDb
  readonly createModel: (apiKey: string) => ClusterModel
  readonly now: () => number
  readonly log: LogSink
}

/** One card as begin_ai_clustering returns it. */
interface BeginCard {
  readonly card_id: string
  readonly category: Category
  readonly text: string
}

interface BeginResult {
  readonly run_id: string
  readonly cards: readonly BeginCard[]
  readonly manual_cluster_names: readonly string[]
  readonly cluster_slots: number
}

interface SuccessBody {
  readonly run_id: string
  readonly cluster_count: number
  readonly clustered_card_count: number
  readonly ungrouped_card_count: number
}

/** Provider metrics recorded on the run and in the log line. */
interface ProviderMetrics {
  provider_called: boolean
  provider_request_id: string | null
  provider_status: number | null
  response_model: string | null
  input_tokens: number | null
  output_tokens: number | null
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** Codes the begin RPC may raise that map to themselves. */
const BEGIN_CODES: readonly ErrorCode[] = [
  'not_project_member',
  'not_project_facilitator',
  'cycle_not_clustering',
  'ai_run_in_progress',
  'ai_run_limit_reached',
  'cluster_limit_reached',
  'too_many_cards',
]

/** Codes the replace RPC may raise that map to themselves. */
const REPLACE_CODES: readonly ErrorCode[] = [
  'not_project_member',
  'not_project_facilitator',
  'cycle_not_clustering',
  'clusters_changed_during_run',
]

class RequestError extends Error {
  constructor(readonly code: ErrorCode) {
    super(code)
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** The cycle id from a body of exactly `{ "cycle_id": "<uuid>" }`, or null. */
async function readCycleId(req: Request): Promise<string | null> {
  const declared = req.headers.get('content-length')
  if (declared !== null && !(Number(declared) <= MAX_BODY_BYTES)) {
    return null
  }
  const bytes = new Uint8Array(await req.arrayBuffer())
  if (bytes.byteLength > MAX_BODY_BYTES) {
    return null
  }
  let body: unknown
  try {
    body = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes))
  } catch {
    return null
  }
  if (!isRecord(body)) {
    return null
  }
  const keys = Object.keys(body)
  const cycleId = body.cycle_id
  if (
    keys.length !== 1 || keys[0] !== 'cycle_id' || typeof cycleId !== 'string' ||
    !UUID.test(cycleId)
  ) {
    return null
  }
  return cycleId.toLowerCase()
}

function parseBeginResult(data: unknown): BeginResult | null {
  if (!isRecord(data)) {
    return null
  }
  const { run_id, cards, manual_cluster_names, cluster_slots } = data
  if (
    typeof run_id !== 'string' ||
    !Array.isArray(cards) ||
    !Array.isArray(manual_cluster_names) ||
    typeof cluster_slots !== 'number' ||
    !Number.isInteger(cluster_slots)
  ) {
    return null
  }
  const parsedCards: BeginCard[] = []
  for (const card of cards) {
    if (
      !isRecord(card) ||
      typeof card.card_id !== 'string' ||
      !isCategory(card.category) ||
      typeof card.text !== 'string'
    ) {
      return null
    }
    parsedCards.push({ card_id: card.card_id, category: card.category, text: card.text })
  }
  const names: string[] = []
  for (const name of manual_cluster_names) {
    if (typeof name !== 'string') {
      return null
    }
    names.push(name)
  }
  return { run_id, cards: parsedCards, manual_cluster_names: names, cluster_slots }
}

/** The error code an RPC raised, if it is one of `allowed`. */
function rpcCode(error: RpcError, allowed: readonly ErrorCode[]): ErrorCode {
  const message = error.message
  return isErrorCode(message) && allowed.includes(message) ? message : 'internal_error'
}

/** The code recorded on the run: the database's own code when it is one. */
function recordedCode(error: RpcError): string {
  return /^[a-z_]{1,64}$/.test(error.message) ? error.message : 'internal_error'
}

/** The model request. Only refs, categories, and card text are sent. */
export function buildModelRequest(
  cards: readonly PromptCard[],
  manualClusterNames: readonly string[],
  clusterSlots: number,
): ClusterModelRequest {
  return {
    model: CLUSTER_MODEL,
    max_tokens: CLUSTER_MAX_TOKENS,
    thinking: { type: 'adaptive' },
    output_config: {
      effort: CLUSTER_EFFORT,
      format: { type: 'json_schema', schema: CLUSTER_OUTPUT_JSON_SCHEMA },
    },
    fallbacks: CLUSTER_FALLBACKS,
    betas: [FALLBACK_BETA],
    system: SYSTEM_PROMPT,
    messages: [
      {
        role: 'user',
        content: buildUserMessage({ cards, manualClusterNames, clusterSlots }),
      },
    ],
  }
}

export function createHandler(deps: HandlerDeps): (req: Request) => Promise<Response> {
  return async (req: Request): Promise<Response> => {
    const startedAt = deps.now()
    const origin = allowedOrigin(deps.env('ALLOWED_ORIGIN'))
    let cycleId: string | null = null
    let runId: string | null = null
    const provider: ProviderMetrics = {
      provider_called: false,
      provider_request_id: null,
      provider_status: null,
      response_model: null,
      input_tokens: null,
      output_tokens: null,
    }
    const elapsed = (): number => Math.max(0, Math.round(deps.now() - startedAt))

    const finish = (status: number, code: string, response: Response): Response => {
      writeRequestLog(deps.log, {
        function: FUNCTION_NAME,
        run_id: runId,
        cycle_id: cycleId,
        code,
        http_status: status,
        duration_ms: elapsed(),
        provider_request_id: provider.provider_request_id,
        input_tokens: provider.input_tokens,
        output_tokens: provider.output_tokens,
        response_model: provider.response_model,
      })
      return response
    }

    const fail = (code: ErrorCode): Response => {
      const { status, message } = ERRORS[code]
      return finish(status, code, errorResponse(status, code, message, origin))
    }

    /** Records the failure on the running run; a failure to record is ignored. */
    const failRun = async (recorded: string): Promise<void> => {
      if (runId === null) {
        return
      }
      try {
        await deps.db.rpc('finish_ai_run', {
          p_run_id: runId,
          p_status: 'failed',
          p_error_code: recorded,
          p_metrics: { ...provider, duration_ms: elapsed() },
        })
      } catch {
        // The run is abandoned after 5 minutes if it cannot be recorded.
      }
    }

    try {
      if (req.method === 'OPTIONS') {
        return finish(204, 'ok', preflightResponse(origin))
      }
      if (req.method !== 'POST') {
        return fail('method_not_allowed')
      }

      cycleId = await readCycleId(req)
      if (cycleId === null) {
        return fail('invalid_request')
      }

      const jwt = bearerToken(req.headers.get('authorization'), deps.now())
      if (jwt === null) {
        return fail('not_authenticated')
      }
      const userId = await deps.auth.getUserId(jwt)
      if (userId === null) {
        return fail('not_authenticated')
      }

      const apiKey = deps.env('ANTHROPIC_API_KEY')?.trim() ?? ''
      if (apiKey === '') {
        return fail('ai_not_configured')
      }

      // 1. Begin: locks, checks, a running run, the available cards.
      const begun = await deps.db.rpc('begin_ai_clustering', {
        p_cycle_id: cycleId,
        p_user_id: userId,
        p_model: CLUSTER_MODEL,
        p_prompt_version: PROMPT_VERSION,
      })
      if (begun.error !== null) {
        return fail(rpcCode(begun.error, BEGIN_CODES))
      }
      const begin = parseBeginResult(begun.data)
      if (begin === null) {
        if (isRecord(begun.data) && typeof begun.data.run_id === 'string') {
          runId = begun.data.run_id
          await failRun('internal_error')
        }
        return fail('internal_error')
      }
      runId = begin.run_id

      // Too few cards: no model call; any AI clusters go as on an empty answer.
      if (begin.cards.length < MIN_CARDS_FOR_MODEL) {
        const skipped = await deps.db.rpc('replace_ai_clusters', {
          p_run_id: runId,
          p_user_id: userId,
          p_clusters: [],
          p_metrics: { status: 'skipped', provider_called: false, duration_ms: elapsed() },
        })
        if (skipped.error !== null) {
          await failRun(recordedCode(skipped.error))
          return fail(rpcCode(skipped.error, REPLACE_CODES))
        }
        const body: SuccessBody = {
          run_id: runId,
          cluster_count: 0,
          clustered_card_count: 0,
          ungrouped_card_count: begin.cards.length,
        }
        return finish(200, 'ok', jsonResponse(200, body, origin))
      }

      // 2. The model call, with no transaction open. The ref map stays in
      // memory for this request only.
      const refToCard = new Map<string, BeginCard>()
      const refCategories = new Map<string, Category>()
      const promptCards: PromptCard[] = begin.cards.map((card, index) => {
        const ref = `c${index + 1}`
        refToCard.set(ref, card)
        refCategories.set(ref, card.category)
        return { ref, category: card.category, text: card.text }
      })
      const request = buildModelRequest(
        promptCards,
        begin.manual_cluster_names,
        begin.cluster_slots,
      )

      let answer: ClusterModelResponse
      try {
        const model = deps.createModel(apiKey)
        provider.provider_called = true
        answer = await model.create(request)
      } catch (error) {
        const failure = classifyProviderError(error)
        provider.provider_status = failure.status
        provider.provider_request_id = failure.requestId
        await failRun(failure.code)
        return fail(failure.code)
      }
      provider.provider_status = 200
      provider.provider_request_id = answer.request_id
      provider.response_model = answer.model
      provider.input_tokens = answer.usage.input_tokens
      provider.output_tokens = answer.usage.output_tokens

      const checked = validateAnswer(answer, refCategories, begin.cluster_slots)
      if (!checked.ok) {
        await failRun(checked.code)
        return fail(checked.code)
      }

      // 3. The write, with card UUIDs mapped back from the refs.
      const clusters = checked.clusters.map((cluster) => ({
        name: cluster.name,
        category: cluster.category,
        card_ids: cluster.card_refs.map((ref) => {
          const card = refToCard.get(ref)
          if (card === undefined) {
            throw new RequestError('internal_error')
          }
          return card.card_id
        }),
      }))
      const clusteredCount = clusters.reduce((sum, cluster) => sum + cluster.card_ids.length, 0)
      const replaced = await deps.db.rpc('replace_ai_clusters', {
        p_run_id: runId,
        p_user_id: userId,
        p_clusters: clusters,
        p_metrics: { ...provider, duration_ms: elapsed(), cluster_count: clusters.length },
      })
      if (replaced.error !== null) {
        await failRun(recordedCode(replaced.error))
        return fail(rpcCode(replaced.error, REPLACE_CODES))
      }

      const body: SuccessBody = {
        run_id: runId,
        cluster_count: clusters.length,
        clustered_card_count: clusteredCount,
        ungrouped_card_count: begin.cards.length - clusteredCount,
      }
      return finish(200, 'ok', jsonResponse(200, body, origin))
    } catch (error) {
      const code: ErrorCode = error instanceof RequestError ? error.code : 'internal_error'
      await failRun(code)
      return fail(code)
    }
  }
}
