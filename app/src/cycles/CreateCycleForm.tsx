import { useMemo, useRef, useState, type FormEvent } from 'react'
import { zodResolver } from '@hookform/resolvers/zod'
import { useForm } from 'react-hook-form'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import {
  cycleFormSchema,
  type CycleFormOutput,
  type CycleFormValues,
} from './cycleFormSchema'
import {
  addWeeks,
  defaultCycleTitle,
  formatWeekStart,
  weekStartOf,
} from './cycleWeek'
import { createCycleErrorMessage, cyclesErrorCodeOf } from './cyclesErrors'
import { useCreateCycle } from './useCycles'

interface WeekOption {
  readonly value: string
  readonly label: string
}

function weekOptions(thisWeek: string): readonly WeekOption[] {
  const lastWeek = addWeeks(thisWeek, -1)
  const nextWeek = addWeeks(thisWeek, 1)
  return [
    { value: lastWeek, label: `Last week (${formatWeekStart(lastWeek)})` },
    { value: thisWeek, label: `This week (${formatWeekStart(thisWeek)})` },
    { value: nextWeek, label: `Next week (${formatWeekStart(nextWeek)})` },
  ]
}

const fieldClass =
  'h-9 w-full min-w-0 rounded-md border border-input bg-background px-3 text-sm outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50'

export interface CreateCycleFormProps {
  readonly projectId: string
  readonly onClose: () => void
  /** Called after `cycle_already_open`, so the list shows the open cycle. */
  readonly onCycleConflict: () => void
  /** Called after `not_project_facilitator`, so the role is re-read. */
  readonly onRoleChanged: () => void
}

export function CreateCycleForm({
  projectId,
  onClose,
  onCycleConflict,
  onRoleChanged,
}: CreateCycleFormProps) {
  const createMutation = useCreateCycle(projectId)
  // The default week comes from the browser's local date when the form opens.
  const thisWeek = useMemo(() => weekStartOf(new Date()), [])
  const options = useMemo(() => weekOptions(thisWeek), [thisWeek])
  // The title follows the week only until the user edits it.
  const [titleEdited, setTitleEdited] = useState(false)
  // React disables the button only after a re-render, so a synchronous second
  // click is guarded here to keep it to one request.
  const submittingRef = useRef(false)

  const {
    register,
    handleSubmit,
    setValue,
    formState: { errors, isSubmitting },
  } = useForm<CycleFormValues, unknown, CycleFormOutput>({
    resolver: zodResolver(cycleFormSchema),
    defaultValues: { title: defaultCycleTitle(thisWeek), weekStart: thisWeek },
  })

  const isPending = createMutation.isPending || isSubmitting

  const onSubmit = handleSubmit(async (values) => {
    try {
      await createMutation.mutateAsync({
        title: values.title,
        weekStart: values.weekStart,
      })
      toast.success('Cycle started.')
      onClose()
    } catch (error) {
      // The input is kept; only a fixed sentence is shown.
      const code = cyclesErrorCodeOf(error)
      toast.error(createCycleErrorMessage(code))
      if (code === 'cycle_already_open') {
        onCycleConflict()
      } else if (code === 'not_project_facilitator') {
        onRoleChanged()
      }
    }
  })

  const onFormSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (submittingRef.current) {
      return
    }
    submittingRef.current = true
    void onSubmit(event).finally(() => {
      submittingRef.current = false
    })
  }

  return (
    <form
      onSubmit={onFormSubmit}
      noValidate
      aria-label="New cycle"
      className="min-w-0 space-y-3 rounded-lg border bg-card p-4 text-card-foreground"
    >
      <div className="min-w-0 space-y-1">
        <label htmlFor="cycle-title" className="block text-sm font-medium">
          Title
        </label>
        <input
          id="cycle-title"
          type="text"
          autoComplete="off"
          aria-invalid={errors.title ? 'true' : undefined}
          aria-describedby={errors.title ? 'cycle-title-error' : undefined}
          className={fieldClass}
          {...register('title', {
            onChange: () => {
              setTitleEdited(true)
            },
          })}
        />
        {errors.title?.message ? (
          <p id="cycle-title-error" className="text-sm text-destructive">
            {errors.title.message}
          </p>
        ) : null}
      </div>

      <div className="min-w-0 space-y-1">
        <label htmlFor="cycle-week" className="block text-sm font-medium">
          Week
        </label>
        <select
          id="cycle-week"
          className={fieldClass}
          {...register('weekStart', {
            onChange: (event: { target: { value: string } }) => {
              if (!titleEdited) {
                setValue('title', defaultCycleTitle(event.target.value))
              }
            },
          })}
        >
          {options.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>
      </div>

      <div className="flex flex-wrap gap-2">
        <Button type="submit" disabled={isPending}>
          {isPending ? 'Starting…' : 'Start cycle'}
        </Button>
        <Button
          type="button"
          variant="outline"
          disabled={isPending}
          onClick={onClose}
        >
          Cancel
        </Button>
      </div>
    </form>
  )
}
