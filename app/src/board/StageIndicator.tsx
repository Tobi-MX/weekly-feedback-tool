import { cn } from '@/lib/utils'
import { BOARD_STAGES, stageName, type BoardStage } from './boardModel'

/**
 * The ordered list of retrospective stages. The current stage has
 * `aria-current="step"` and the visible text "Current"; earlier stages read
 * "Done". Nothing is shown by color alone.
 */
export function StageIndicator({ current }: { current: BoardStage }) {
  const currentIndex = BOARD_STAGES.indexOf(current)

  return (
    <ol
      aria-label="Retrospective stages"
      className="flex min-w-0 flex-wrap gap-2"
    >
      {BOARD_STAGES.map((stage, index) => {
        const isCurrent = index === currentIndex
        const isDone = index < currentIndex
        return (
          <li
            key={stage}
            aria-current={isCurrent ? 'step' : undefined}
            className={cn(
              'flex items-center gap-2 rounded-md border px-3 py-1 text-sm',
              isCurrent && 'border-foreground font-semibold',
              !isCurrent && !isDone && 'text-muted-foreground',
            )}
          >
            <span>{stageName(stage)}</span>
            {isCurrent ? <span className="text-xs">Current</span> : null}
            {isDone ? <span className="text-xs">Done</span> : null}
          </li>
        )
      })}
    </ol>
  )
}
