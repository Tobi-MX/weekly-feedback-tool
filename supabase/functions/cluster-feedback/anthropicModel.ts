import Anthropic from '@anthropic-ai/sdk'
import { ANTHROPIC_MAX_RETRIES, ANTHROPIC_TIMEOUT_MS } from './config.ts'
import type { ContentBlockLike } from './validate.ts'

/**
 * The model seam. The handler only sees `ClusterModel`; `index.ts` wires the
 * real Anthropic adapter below, tests inject a mock, and #38's local-only mock
 * mode plugs in here without changing the handler.
 */

/** The request the handler builds: a non-streaming beta Messages request. */
export type ClusterModelRequest = Anthropic.Beta.Messages.MessageCreateParamsNonStreaming

/** The response, narrowed to what the handler reads. */
export interface ClusterModelResponse {
  /** The model that actually answered (a fallback model after a refusal). */
  readonly model: string
  readonly stop_reason: string | null
  readonly content: readonly ContentBlockLike[]
  readonly usage: { readonly input_tokens: number; readonly output_tokens: number }
  /** The `request-id` response header. */
  readonly request_id: string | null
}

export interface ClusterModel {
  create(request: ClusterModelRequest): Promise<ClusterModelResponse>
}

export interface AnthropicClientOptions {
  readonly apiKey: string
  readonly timeout: number
  readonly maxRetries: number
}

export function anthropicClientOptions(apiKey: string): AnthropicClientOptions {
  return { apiKey, timeout: ANTHROPIC_TIMEOUT_MS, maxRetries: ANTHROPIC_MAX_RETRIES }
}

/** The SDK client as the adapter uses it, so a test can construct a fake. */
export interface MessagesClient {
  readonly beta: {
    readonly messages: {
      create(
        request: ClusterModelRequest,
      ): PromiseLike<Anthropic.Beta.Messages.BetaMessage & { _request_id?: string | null }>
    }
  }
}

export type MessagesClientFactory = (options: AnthropicClientOptions) => MessagesClient

const sdkClient: MessagesClientFactory = (options) => new Anthropic({ ...options })

/** The real adapter: one `client.beta.messages.create` call per run. */
export function createAnthropicModel(
  apiKey: string,
  factory: MessagesClientFactory = sdkClient,
): ClusterModel {
  const client = factory(anthropicClientOptions(apiKey))
  return {
    async create(request) {
      const message = await client.beta.messages.create(request)
      return {
        model: message.model,
        stop_reason: message.stop_reason,
        content: message.content.map((block) =>
          block.type === 'text' ? { type: 'text', text: block.text } : { type: block.type }
        ),
        usage: {
          input_tokens: message.usage.input_tokens,
          output_tokens: message.usage.output_tokens,
        },
        request_id: message._request_id ?? null,
      }
    },
  }
}

export interface ProviderFailure {
  readonly code: 'ai_timeout' | 'ai_unavailable' | 'internal_error'
  /** The provider's HTTP status, when it answered. */
  readonly status: number | null
  readonly requestId: string | null
}

/**
 * Maps an error thrown by the SDK (after its own retry) to an error code.
 * Timeouts are `ai_timeout`; 429, 5xx (529 included), and connection errors
 * are `ai_unavailable`; anything else (400, 401, 403, 404, or a non-SDK
 * error) is `internal_error`. The error's message is never read.
 */
export function classifyProviderError(error: unknown): ProviderFailure {
  if (error instanceof Anthropic.APIConnectionTimeoutError) {
    return { code: 'ai_timeout', status: null, requestId: null }
  }
  if (error instanceof Anthropic.APIConnectionError) {
    return { code: 'ai_unavailable', status: null, requestId: null }
  }
  if (error instanceof Anthropic.APIError) {
    const status = typeof error.status === 'number' ? error.status : null
    const requestId = typeof error.requestID === 'string' ? error.requestID : null
    if (
      error instanceof Anthropic.RateLimitError ||
      error instanceof Anthropic.InternalServerError ||
      (status !== null && status >= 500)
    ) {
      return { code: 'ai_unavailable', status, requestId }
    }
    return { code: 'internal_error', status, requestId }
  }
  return { code: 'internal_error', status: null, requestId: null }
}
