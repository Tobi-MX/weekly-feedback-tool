import { createClient } from '@supabase/supabase-js'
import type { SupabaseClient } from '@supabase/supabase-js'
import { getEnvConfig } from '../env'

const config = getEnvConfig()

/**
 * The single Supabase client used by the application.
 *
 * It is `null` when the public environment values are missing or invalid, so
 * the UI can render a configuration notice instead of calling a backend that
 * does not exist.
 */
export const supabase: SupabaseClient | null =
  config.status === 'configured'
    ? createClient(config.url, config.anonKey, {
        auth: {
          persistSession: true,
          autoRefreshToken: true,
          // Only /auth/callback may read credentials from the URL. Keeping URL
          // session detection off everywhere else avoids consuming a magic
          // link on the wrong route.
          detectSessionInUrl: false,
        },
      })
    : null
