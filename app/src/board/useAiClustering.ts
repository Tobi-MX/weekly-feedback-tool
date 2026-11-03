import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import { useAuth } from '@/auth/AuthProvider'
import {
  acceptAiClusters,
  requestAiClusters,
  type AiClusteringResult,
} from './aiClusteringApi'
import {
  AI_CLUSTERING_ERRORS,
  aiClusteringErrorCodeOf,
  type AiClusteringErrorCode,
} from './aiClusteringErrors'
import type { CycleBoard } from './boardApi'
import { cycleBoardQueryKey } from './boardKeys'

/** The selector of the AI suggestions panel. */
export const AI_PANEL_SELECTOR = '[data-ai-panel]'

/** The panel's error, keyed so the same error twice is announced twice. */
export interface AiAlert {
  readonly code: AiClusteringErrorCode
  readonly key: number
}

/**
 * What the cluster view gives a run while it is mounted: its status region,
 * whether the panel is shown, and a way to move focus into the panel.
 */
export interface AiSink {
  readonly announce: (text: string) => void
  /**
   * The AI cluster ids of the board this tab's own run re-read: they are its
   * result, never "new AI suggestions" from elsewhere, whenever they render.
   */
  readonly markAiIdsSeen: (ids: readonly string[]) => void
  readonly panelShown: () => boolean
  readonly requestPanelFocus: () => void
}

export interface AiClusteringRun {
  /** A request from this tab is in flight (until its board re-read is in). */
  readonly pending: boolean
  readonly alert: AiAlert | null
  /** This tab got `ai_run_limit_reached`: no trigger until a reload. */
  readonly limitReached: boolean
  /** Sends one request; false (and nothing sent) if one is in flight. */
  readonly start: () => boolean
  /** The synchronous pending flag, for event handlers. */
  readonly isPending: () => boolean
  /** Registers the mounted cluster view; returns the unregister function. */
  readonly attach: (sink: AiSink) => () => void
}

function plural(count: number, one: string, many: string): string {
  return count === 1 ? `1 ${one}` : `${count} ${many}`
}

/** The announcement for a successful run, from its counts only. */
export function aiSuccessAnnouncement(result: AiClusteringResult): string {
  if (result.clusterCount === 0) {
    return 'No clusters were suggested, so the cards stay in Ungrouped.'
  }
  const clusters = plural(
    result.clusterCount,
    'suggested cluster',
    'suggested clusters',
  )
  const ungrouped = result.ungroupedCardCount
  const cards = ungrouped === 1 ? '1 card is' : `${ungrouped} cards are`
  return `Added ${clusters}. ${cards} in Ungrouped.`
}

/** Whether focus is in the panel, or lost to <body> or a removed control. */
export function focusInAiPanel(): boolean {
  const active = document.activeElement
  if (active === null || active === document.body || !active.isConnected) {
    return true
  }
  return active.closest(AI_PANEL_SELECTOR) !== null
}

interface RunOptions {
  readonly cycleId: string
  readonly onLostAccess: () => void
  readonly onNotFacilitator: () => void
}

/**
 * One AI clustering request at a time for the board page (#21). It lives
 * above the cluster view, so a request and its result handling survive the
 * view unmounting (a stage change). Nothing reads or polls `ai_runs`, and
 * there is no client timeout. Every outcome re-reads the board; a success
 * waits for that re-read before it is announced, so the clusters are on
 * screen when it is read. Nothing from the response is written into the
 * cache or kept as board state.
 */
export function useAiClusteringRun({
  cycleId,
  onLostAccess,
  onNotFacilitator,
}: RunOptions): AiClusteringRun {
  const queryClient = useQueryClient()
  const { user } = useAuth()
  const userId = user?.id ?? null
  const [pending, setPending] = useState(false)
  const [alert, setAlert] = useState<AiAlert | null>(null)
  const [limitReached, setLimitReached] = useState(false)
  const pendingRef = useRef(false)
  const alertKeyRef = useRef(0)
  const sinkRef = useRef<AiSink | null>(null)
  const handlers = useRef({ onLostAccess, onNotFacilitator })
  useEffect(() => {
    handlers.current = { onLostAccess, onNotFacilitator }
  }, [onLostAccess, onNotFacilitator])

  const attach = useCallback((sink: AiSink) => {
    sinkRef.current = sink
    return () => {
      if (sinkRef.current === sink) {
        sinkRef.current = null
      }
    }
  }, [])

  const isPending = useCallback(() => pendingRef.current, [])

  const start = useCallback(() => {
    if (pendingRef.current) {
      return false
    }
    pendingRef.current = true
    setPending(true)
    setAlert(null)
    const queryKey = cycleBoardQueryKey(userId, cycleId)
    const reread = () => queryClient.invalidateQueries({ queryKey })
    requestAiClusters(cycleId)
      .then(async (result) => {
        await reread()
        const sink = sinkRef.current
        const board = queryClient.getQueryData<CycleBoard | null>(queryKey)
        sink?.markAiIdsSeen(
          (board?.clusters ?? [])
            .filter((cluster) => cluster.source === 'ai')
            .map((cluster) => cluster.clusterId),
        )
        const moveFocus = sink !== null && sink.panelShown() && focusInAiPanel()
        setAlert(null)
        sink?.announce(aiSuccessAnnouncement(result))
        if (moveFocus) {
          sink.requestPanelFocus()
        }
      })
      .catch((error: unknown) => {
        void reread()
        const code = aiClusteringErrorCodeOf(error)
        const { copy, shownAs } = AI_CLUSTERING_ERRORS[code]
        const sink = sinkRef.current
        const shown = sink !== null && sink.panelShown()
        const moveFocus = shown && focusInAiPanel()
        if (code === 'ai_run_limit_reached') {
          setLimitReached(true)
        }
        if (shownAs === 'not-found' || copy === null) {
          handlers.current.onLostAccess()
        } else if (shownAs === 'toast' || !shown) {
          toast.error(copy)
        } else {
          alertKeyRef.current += 1
          setAlert({ code, key: alertKeyRef.current })
        }
        if (code === 'not_project_facilitator') {
          handlers.current.onNotFacilitator()
        }
        if (moveFocus) {
          sink.requestPanelFocus()
        }
      })
      .finally(() => {
        pendingRef.current = false
        setPending(false)
      })
    return true
  }, [queryClient, userId, cycleId])

  return useMemo(
    () => ({ pending, alert, limitReached, start, isPending, attach }),
    [pending, alert, limitReached, start, isPending, attach],
  )
}

/**
 * Keep (#21): `accept_ai_clusters`, not optimistic. The mutation settles only
 * once the board's re-read is in, so the result is announced with the badges
 * already gone.
 */
export function useKeepAiClusters(cycleId: string) {
  const queryClient = useQueryClient()
  const { user } = useAuth()
  const userId = user?.id ?? null
  return useMutation({
    mutationFn: () => acceptAiClusters(cycleId),
    onSettled: () =>
      queryClient.invalidateQueries({
        queryKey: cycleBoardQueryKey(userId, cycleId),
      }),
  })
}
