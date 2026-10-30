import { supabase } from '@/auth/supabaseClient'

interface ProfileRow {
  readonly display_name: string | null
}

/**
 * Loads only the signed-in user's display name. The single Supabase client is
 * used directly here; route and screen components read it through a hook.
 * RLS limits the profiles row to `auth.uid()`, and the id filter keeps the
 * query explicit.
 */
export async function fetchProfileDisplayName(
  userId: string,
): Promise<string | null> {
  if (!supabase) {
    return null
  }

  const { data, error } = await supabase
    .from('profiles')
    .select('display_name')
    .eq('id', userId)
    .maybeSingle<ProfileRow>()

  if (error) {
    throw new Error('Could not load the profile.')
  }

  return data?.display_name ?? null
}
