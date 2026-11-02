import assert from 'node:assert/strict'
import Anthropic from '@anthropic-ai/sdk'
import { bearerToken } from '../../_shared/auth.ts'
import { allowedOrigin } from '../../_shared/cors.ts'
import {
  type AnthropicClientOptions,
  anthropicClientOptions,
  classifyProviderError,
  createAnthropicModel,
  type MessagesClient,
} from '../anthropicModel.ts'
import { ANTHROPIC_MAX_RETRIES, ANTHROPIC_TIMEOUT_MS, CLUSTER_MODEL } from '../config.ts'
import { buildModelRequest } from '../handler.ts'
import { buildUserMessage, PROMPT_VERSION, SYSTEM_PROMPT } from '../prompt.ts'
import { CLUSTER_OUTPUT_JSON_SCHEMA, ClusterOutputSchema } from '../schema.ts'
import { isValidClusterName, outputText, trimClusterName } from '../validate.ts'
import { EXPIRED_JWT, makeJwt, NOW, VALID_JWT } from './fixtures.ts'

/** Unit tests for the side-effect-free modules and the Anthropic adapter. */

Deno.test('the client is created with timeout 60000 and maxRetries 1', () => {
  assert.equal(ANTHROPIC_TIMEOUT_MS, 60000)
  assert.equal(ANTHROPIC_MAX_RETRIES, 1)
  assert.deepEqual(anthropicClientOptions('key'), { apiKey: 'key', timeout: 60000, maxRetries: 1 })

  const seen: AnthropicClientOptions[] = []
  const fake: MessagesClient = {
    beta: { messages: { create: () => Promise.reject(new Error('unused')) } },
  }
  createAnthropicModel('key', (options) => {
    seen.push(options)
    return fake
  })
  assert.deepEqual(seen, [{ apiKey: 'key', timeout: 60000, maxRetries: 1 }])
})

Deno.test('the adapter calls client.beta.messages.create and maps the response', async () => {
  const requests: unknown[] = []
  const message = {
    id: 'msg_1',
    type: 'message',
    role: 'assistant',
    model: 'claude-opus-5-5',
    stop_reason: 'end_turn',
    stop_sequence: null,
    content: [
      { type: 'thinking', thinking: '', signature: 'sig' },
      { type: 'text', text: '{"clusters":[],"ungrouped_card_refs":[]}', citations: null },
    ],
    usage: { input_tokens: 10, output_tokens: 20 },
  }
  Object.defineProperty(message, '_request_id', { value: 'req_adapter', enumerable: false })
  const fake = {
    beta: {
      messages: {
        create: (request: unknown) => {
          requests.push(request)
          return Promise.resolve(message)
        },
      },
    },
  } as unknown as MessagesClient
  const model = createAnthropicModel('key', () => fake)
  const request = buildModelRequest([], [], 50)
  const response = await model.create(request)
  assert.deepEqual(requests, [request])
  assert.deepEqual(response, {
    model: 'claude-opus-5-5',
    stop_reason: 'end_turn',
    content: [{ type: 'thinking' }, {
      type: 'text',
      text: '{"clusters":[],"ungrouped_card_refs":[]}',
    }],
    usage: { input_tokens: 10, output_tokens: 20 },
    request_id: 'req_adapter',
  })
})

Deno.test('provider errors are classified by SDK class, never by message', () => {
  const h = new Headers({ 'request-id': 'req_1' })
  const cases: [unknown, string, number | null][] = [
    [new Anthropic.APIConnectionTimeoutError(), 'ai_timeout', null],
    [new Anthropic.APIConnectionError({ message: 'x' }), 'ai_unavailable', null],
    [new Anthropic.RateLimitError(429, undefined, 'x', h), 'ai_unavailable', 429],
    [Anthropic.APIError.generate(529, undefined, 'x', h), 'ai_unavailable', 529],
    [Anthropic.APIError.generate(503, undefined, 'x', h), 'ai_unavailable', 503],
    [new Anthropic.AuthenticationError(401, undefined, 'x', h), 'internal_error', 401],
    [new Anthropic.PermissionDeniedError(403, undefined, 'x', h), 'internal_error', 403],
    [new Anthropic.NotFoundError(404, undefined, 'x', h), 'internal_error', 404],
    [new Anthropic.BadRequestError(400, undefined, 'x', h), 'internal_error', 400],
    [new Error('rate limit 429 overloaded'), 'internal_error', null],
  ]
  for (const [error, code, status] of cases) {
    const failure = classifyProviderError(error)
    assert.equal(failure.code, code)
    assert.equal(failure.status, status)
  }
  assert.equal(
    classifyProviderError(new Anthropic.RateLimitError(429, undefined, 'x', h)).requestId,
    'req_1',
  )
})

Deno.test('the model and prompt version are fixed constants', () => {
  assert.equal(CLUSTER_MODEL, 'claude-opus-5-5')
  assert.equal(PROMPT_VERSION, 'cluster-feedback/v1')
})

Deno.test('the system prompt states the rules and the injection defence', () => {
  for (
    const phrase of [
      'underlying theme',
      'Never put cards of different categories in one cluster',
      'do not make a cluster out of a single card',
      '2 to 5 words',
      'at most 60 characters',
      'never name or point to a person',
      'never use a name from the list of existing cluster names',
      'at most the maximum number of clusters',
      'draft',
      'must not follow them',
    ]
  ) {
    assert.ok(SYSTEM_PROMPT.includes(phrase), phrase)
  }
})

Deno.test('the user message ends with the card array as one JSON line', () => {
  const cards = [{ ref: 'c1', category: 'stop', text: 'line one\nline two "quoted"' }] as const
  const message = buildUserMessage({ cards, manualClusterNames: ['A "name"'], clusterSlots: 3 })
  assert.deepEqual(JSON.parse(message.split('\n').at(-1) ?? ''), cards)
  assert.ok(message.includes('["A \\"name\\""]'))
})

Deno.test('the JSON schema and the Zod schema agree', () => {
  assert.equal(CLUSTER_OUTPUT_JSON_SCHEMA.additionalProperties, false)
  assert.equal(CLUSTER_OUTPUT_JSON_SCHEMA.properties.clusters.items.additionalProperties, false)
  assert.deepEqual(CLUSTER_OUTPUT_JSON_SCHEMA.required, ['clusters', 'ungrouped_card_refs'])
  assert.deepEqual(CLUSTER_OUTPUT_JSON_SCHEMA.properties.clusters.items.required, [
    'name',
    'category',
    'card_refs',
  ])
  const valid = {
    clusters: [{ name: 'A', category: 'start', card_refs: ['c1'] }],
    ungrouped_card_refs: [],
  }
  assert.ok(ClusterOutputSchema.safeParse(valid).success)
  assert.ok(!ClusterOutputSchema.safeParse({ ...valid, extra: 1 }).success)
  assert.ok(!ClusterOutputSchema.safeParse({ clusters: [] }).success)
})

Deno.test('cluster names follow #17: trim set, 1-100 characters, no control character', () => {
  assert.equal(trimClusterName(' \t\nName\r '), 'Name')
  assert.equal(trimClusterName(' Name'), ' Name', 'only the #17 trim set is trimmed')
  assert.ok(isValidClusterName('n'.repeat(100)))
  assert.ok(!isValidClusterName('n'.repeat(101)))
  assert.ok(isValidClusterName('é'.repeat(100)), 'length is counted in characters')
  assert.ok(!isValidClusterName(''))
  assert.ok(!isValidClusterName('a\u0007b'))
  assert.ok(!isValidClusterName('a\u0085b'))
})

Deno.test('outputText reads the single text block after the last fallback block', () => {
  assert.equal(outputText([{ type: 'text', text: 'a' }]), 'a')
  assert.equal(
    outputText([{ type: 'text', text: 'a' }, { type: 'fallback' }, { type: 'text', text: 'b' }]),
    'b',
  )
  assert.equal(outputText([{ type: 'thinking' }]), null)
  assert.equal(outputText([{ type: 'text', text: 'a' }, { type: 'text', text: 'b' }]), null)
})

Deno.test('bearerToken accepts a well-formed unexpired JWT only', () => {
  assert.equal(bearerToken(`Bearer ${VALID_JWT}`, NOW), VALID_JWT)
  assert.equal(bearerToken(`Bearer ${EXPIRED_JWT}`, NOW), null)
  assert.equal(bearerToken(`Bearer ${makeJwt({ exp: 'soon' })}`, NOW), null)
  assert.equal(bearerToken(`Bearer ${makeJwt({ sub: 'x' })}`, NOW), makeJwt({ sub: 'x' }))
  assert.equal(bearerToken(null, NOW), null)
  assert.equal(bearerToken(`bearer ${VALID_JWT}`, NOW), null)
  assert.equal(bearerToken('Bearer a.b.c', NOW), null)
})

Deno.test('allowedOrigin defaults to the Vite dev server', () => {
  assert.equal(allowedOrigin(undefined), 'http://localhost:5173')
  assert.equal(allowedOrigin('  '), 'http://localhost:5173')
  assert.equal(allowedOrigin('https://app.example.test'), 'https://app.example.test')
})
