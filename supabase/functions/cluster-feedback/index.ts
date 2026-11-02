import { createClient } from '@supabase/supabase-js'
import type { AuthVerifier } from '../_shared/auth.ts'
import { createAnthropicModel } from './anthropicModel.ts'
import { type ClusterDb, createHandler } from './handler.ts'

/**
 * Entry point: wires the real Supabase clients and the Anthropic adapter into
 * the handler. SUPABASE_URL, SUPABASE_ANON_KEY, and SUPABASE_SERVICE_ROLE_KEY
 * are injected by the Edge runtime; ANTHROPIC_API_KEY and ALLOWED_ORIGIN are
 * Edge secrets. None of them is ever logged or returned.
 */

const CLIENT_OPTIONS = {
  auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
}

const url = Deno.env.get('SUPABASE_URL') ?? ''
const anonKey = Deno.env.get('SUPABASE_ANON_KEY') ?? ''
const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? ''

/** Verifies the caller's access token against Supabase Auth (anon key). */
const authClient = url !== '' && anonKey !== '' ? createClient(url, anonKey, CLIENT_OPTIONS) : null

/** Calls only the three AI clustering RPCs, after the JWT is verified. */
const serviceClient = url !== '' && serviceRoleKey !== ''
  ? createClient(url, serviceRoleKey, CLIENT_OPTIONS)
  : null

const auth: AuthVerifier = {
  async getUserId(jwt) {
    if (authClient === null) {
      throw new Error('auth_not_configured')
    }
    const { data, error } = await authClient.auth.getUser(jwt)
    if (error !== null || data.user === null) {
      return null
    }
    return data.user.id
  },
}

const db: ClusterDb = {
  async rpc(name, args) {
    if (serviceClient === null) {
      throw new Error('database_not_configured')
    }
    const { data, error } = await serviceClient.rpc(name, args)
    return { data: data as unknown, error: error === null ? null : { message: error.message } }
  },
}

Deno.serve(
  createHandler({
    env: (name) => Deno.env.get(name),
    auth,
    db,
    createModel: (apiKey) => createAnthropicModel(apiKey),
    now: () => Date.now(),
    log: (line) => console.log(line),
  }),
)
