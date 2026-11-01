import type { RealtimeChannel, SupabaseClient } from '@supabase/supabase-js'
import { supabase } from '@/auth/supabaseClient'

/** The channel states a subscriber is told about. */
export type CycleEventsStatus =
  'SUBSCRIBED' | 'CHANNEL_ERROR' | 'TIMED_OUT' | 'CLOSED'

export interface CycleEventsHandlers {
  /**
   * Called once per new `cycle_events` row of the cycle. It is given nothing
   * from the message: callers re-read what they need through the RPCs.
   */
  readonly onEvent: () => void
  /** Called on every channel state change, `SUBSCRIBED` included. */
  readonly onStatus?: (status: CycleEventsStatus) => void
}

interface Listener {
  readonly handlers: CycleEventsHandlers
}

interface Entry {
  readonly listeners: Set<Listener>
  channel: RealtimeChannel | null
  status: CycleEventsStatus | null
  removalTimer: ReturnType<typeof setTimeout> | null
}

/** One shared channel per cycle, whoever subscribes to it. */
const entries = new Map<string, Entry>()
/** Channels still leaving, so a new subscriber waits for a fresh channel. */
const closing = new Map<string, Promise<unknown>>()

export function cycleEventsChannelName(cycleId: string): string {
  return `cycle-events:${cycleId}`
}

function open(client: SupabaseClient, cycleId: string, entry: Entry): void {
  entry.channel = client
    .channel(cycleEventsChannelName(cycleId))
    .on(
      'postgres_changes',
      {
        event: 'INSERT',
        schema: 'public',
        table: 'cycle_events',
        filter: `cycle_id=eq.${cycleId}`,
      },
      // The message is ignored: no card text, card id, or user id is read
      // from it, logged, or stored.
      () => {
        for (const listener of [...entry.listeners]) {
          listener.handlers.onEvent()
        }
      },
    )
    .subscribe((status) => {
      entry.status = status
      for (const listener of [...entry.listeners]) {
        listener.handlers.onStatus?.(status)
      }
    })
}

/**
 * Listens for new `cycle_events` rows of one cycle on the channel
 * `cycle-events:<cycleId>` (Postgres Changes, INSERT only, filtered by
 * `cycle_id`). Realtime applies the table's member-only select policy to each
 * subscriber. Returns an unsubscribe function.
 *
 * Every subscriber of a cycle shares one channel. It is removed one tick after
 * its last subscriber leaves, so React strict mode's mount, unmount, and
 * remount keeps exactly one live channel.
 */
export function subscribeToCycleEvents(
  cycleId: string,
  handlers: CycleEventsHandlers,
): () => void {
  const client = supabase
  if (!client) {
    return () => undefined
  }

  const listener: Listener = { handlers }
  let entry = entries.get(cycleId)

  if (entry) {
    const existing = entry
    if (existing.removalTimer !== null) {
      clearTimeout(existing.removalTimer)
      existing.removalTimer = null
    }
    existing.listeners.add(listener)
    // A late subscriber still gets its first SUBSCRIBED, so it catches up.
    if (existing.status === 'SUBSCRIBED') {
      queueMicrotask(() => {
        if (existing.listeners.has(listener)) {
          handlers.onStatus?.('SUBSCRIBED')
        }
      })
    }
  } else {
    const created: Entry = {
      listeners: new Set([listener]),
      channel: null,
      status: null,
      removalTimer: null,
    }
    entry = created
    entries.set(cycleId, created)
    const leaving = closing.get(cycleId)
    if (leaving) {
      void leaving.then(() => {
        if (
          entries.get(cycleId) === created &&
          created.channel === null &&
          created.listeners.size > 0
        ) {
          open(client, cycleId, created)
        }
      })
    } else {
      open(client, cycleId, created)
    }
  }

  const current = entry
  let active = true
  return () => {
    if (!active) {
      return
    }
    active = false
    current.listeners.delete(listener)
    if (current.listeners.size > 0 || current.removalTimer !== null) {
      return
    }
    current.removalTimer = setTimeout(() => {
      current.removalTimer = null
      if (current.listeners.size > 0 || entries.get(cycleId) !== current) {
        return
      }
      entries.delete(cycleId)
      const channel = current.channel
      if (channel === null) {
        return
      }
      const done: Promise<unknown> = client
        .removeChannel(channel)
        .catch(() => undefined)
        .finally(() => {
          if (closing.get(cycleId) === done) {
            closing.delete(cycleId)
          }
        })
      closing.set(cycleId, done)
    }, 0)
  }
}
