import { useEffect, useId, useRef, useState, type FormEvent } from 'react'
import { zodResolver } from '@hookform/resolvers/zod'
import { useForm, useWatch, type UseFormReturn } from 'react-hook-form'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import type { MyCard } from './cardsApi'
import { cardCategoryLabel, type CardCategory } from './cardCategories'
import { cardsErrorCodeOf, type CardsErrorCode } from './cardsErrors'
import {
  CARD_TEXT_MAX,
  cardFormSchema,
  cardTextLength,
  trimCardText,
  type CardFormOutput,
  type CardFormValues,
} from './cardText'
import { useBeforeUnloadWarning } from './browserState'
import { useCreateCard, useUpdateCard } from './useCards'

export type WriteOperation = 'add' | 'save' | 'delete'
export type WriteErrorHandler = (
  code: CardsErrorCode,
  operation: WriteOperation,
) => void

export const HINT_ATTRIBUTED =
  'Your name will be shown with this card when the team reveals feedback.'
export const HINT_ANONYMOUS =
  'No one on the team, including the facilitator, will see that you wrote this card.'
const MOVE_HINT =
  'To move this card to another section, delete it and add it again.'

export const wrapText = 'min-w-0 break-words [overflow-wrap:anywhere]'
export const focusRing =
  'outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50'

type CardForm = UseFormReturn<CardFormValues, unknown, CardFormOutput>

function useCardForm(defaults: CardFormValues): CardForm {
  return useForm<CardFormValues, unknown, CardFormOutput>({
    resolver: zodResolver(cardFormSchema),
    defaultValues: defaults,
    // The inline error is announced by its alert role; moving focus to the
    // textarea as well would announce it twice.
    shouldFocusError: false,
  })
}

/** Unsaved text, shown read-only and selectable so it can be copied. */
export function NotSavedText({ text }: { text: string }) {
  return (
    <div className="space-y-1 rounded-md border border-dashed border-destructive/40 p-3">
      <p className="text-xs font-semibold">Not saved</p>
      <p className={cn('text-sm whitespace-pre-wrap select-text', wrapText)}>
        {text}
      </p>
    </div>
  )
}

interface CardFieldsProps {
  readonly idBase: string
  readonly label: string
  readonly form: CardForm
  readonly textareaRef: React.RefObject<HTMLTextAreaElement | null>
}

/** The textarea, counter, inline error, and anonymity choice. */
function CardFields({ idBase, label, form, textareaRef }: CardFieldsProps) {
  const text = useWatch({ control: form.control, name: 'text' })
  const isAnonymous = useWatch({ control: form.control, name: 'isAnonymous' })
  const error = form.formState.errors.text?.message
  const length = cardTextLength(text)
  const { ref: registerTextRef, ...textField } = form.register('text')
  const textId = `${idBase}-text`
  const errorId = `${idBase}-error`
  const anonId = `${idBase}-anonymous`
  const hintId = `${idBase}-anonymous-hint`

  return (
    <div className="min-w-0 space-y-2">
      <label htmlFor={textId} className="block text-sm font-medium">
        {label}
      </label>
      <textarea
        id={textId}
        rows={3}
        aria-invalid={error ? 'true' : undefined}
        aria-describedby={error ? errorId : undefined}
        className={cn(
          'block min-h-20 w-full min-w-0 resize-y rounded-md border border-input bg-background px-3 py-2 text-sm aria-invalid:border-destructive',
          focusRing,
        )}
        {...textField}
        ref={(element) => {
          registerTextRef(element)
          textareaRef.current = element
        }}
      />
      <p
        className={cn(
          'text-xs text-muted-foreground',
          length > CARD_TEXT_MAX && 'text-destructive',
        )}
      >
        {length} / {CARD_TEXT_MAX}
      </p>
      {error ? (
        <p id={errorId} role="alert" className="text-sm text-destructive">
          {error}
        </p>
      ) : null}
      <div className="flex items-start gap-2">
        <input
          id={anonId}
          type="checkbox"
          aria-describedby={hintId}
          className="mt-0.5 size-4 shrink-0 accent-primary focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
          {...form.register('isAnonymous')}
        />
        <label htmlFor={anonId} className="text-sm">
          Submit anonymously
        </label>
      </div>
      <p id={hintId} className="text-xs text-muted-foreground">
        {isAnonymous ? HINT_ANONYMOUS : HINT_ATTRIBUTED}
      </p>
    </div>
  )
}

interface CardComposerProps {
  readonly cycleId: string
  readonly category: CardCategory
  readonly collecting: boolean
  readonly online: boolean
  readonly textareaRef: React.RefObject<HTMLTextAreaElement | null>
  readonly onWriteError: WriteErrorHandler
}

/**
 * Adds one card. Out of `collecting` it shows any unsent text read-only as
 * "Not saved"; it stays mounted so that text is never dropped silently.
 */
export function CardComposer({
  cycleId,
  category,
  collecting,
  online,
  textareaRef,
  onWriteError,
}: CardComposerProps) {
  const idBase = useId()
  const label = cardCategoryLabel(category)
  const form = useCardForm({ text: '', isAnonymous: false })
  const createMutation = useCreateCard(cycleId)
  // React disables the button only after a re-render, so a synchronous second
  // click or Enter is guarded here to keep it to one request.
  const submittingRef = useRef(false)
  const text = useWatch({ control: form.control, name: 'text' })
  const isAnonymous = useWatch({ control: form.control, name: 'isAnonymous' })
  const hasText = trimCardText(text).length > 0

  useBeforeUnloadWarning(collecting && hasText)

  const add = async (values: CardFormOutput) => {
    try {
      await createMutation.mutateAsync({
        category,
        text: values.text,
        isAnonymous: values.isAnonymous,
      })
      // Every card's anonymity is chosen on its own: back to attributed.
      form.reset({ text: '', isAnonymous: false })
      textareaRef.current?.focus()
      toast.success('Card added.')
    } catch (error) {
      onWriteError(cardsErrorCodeOf(error), 'add')
    }
  }

  // The guard lives in the submit event handler so a second synchronous click
  // cannot start a second request before React disables the button.
  const onFormSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (submittingRef.current || !online || !collecting) {
      return
    }
    submittingRef.current = true
    void form
      .handleSubmit(add)(event)
      .finally(() => {
        submittingRef.current = false
      })
  }

  if (!collecting) {
    return hasText ? <NotSavedText text={text} /> : null
  }

  const pending = createMutation.isPending

  return (
    <form
      onSubmit={onFormSubmit}
      noValidate
      aria-label={`New ${label} card`}
      className="min-w-0 space-y-3 rounded-md border bg-background p-3"
    >
      <CardFields
        idBase={idBase}
        label={`Add a ${label} card`}
        form={form}
        textareaRef={textareaRef}
      />
      <Button type="submit" disabled={pending || !online}>
        {pending ? 'Adding…' : isAnonymous ? 'Add anonymously' : 'Add card'}
      </Button>
    </form>
  )
}

interface CardEditorProps {
  readonly cycleId: string
  readonly card: MyCard
  readonly name: string
  readonly collecting: boolean
  readonly online: boolean
  readonly onWriteError: WriteErrorHandler
  readonly onCardGone: (text: string) => void
  readonly onClose: () => void
}

/**
 * Edits one card's text and anonymity; the category is fixed. Out of
 * `collecting` it shows changed text read-only as "Not saved".
 */
export function CardEditor({
  cycleId,
  card,
  name,
  collecting,
  online,
  onWriteError,
  onCardGone,
  onClose,
}: CardEditorProps) {
  const idBase = useId()
  const form = useCardForm({ text: card.text, isAnonymous: card.isAnonymous })
  const updateMutation = useUpdateCard(cycleId)
  const submittingRef = useRef(false)
  const textareaRef = useRef<HTMLTextAreaElement | null>(null)
  const keepEditingRef = useRef<HTMLButtonElement | null>(null)
  const [confirmingDiscard, setConfirmingDiscard] = useState(false)
  const text = useWatch({ control: form.control, name: 'text' })
  const isAnonymous = useWatch({ control: form.control, name: 'isAnonymous' })
  const changed =
    trimCardText(text) !== card.text || isAnonymous !== card.isAnonymous

  useBeforeUnloadWarning(collecting && changed)

  useEffect(() => {
    textareaRef.current?.focus()
  }, [])

  useEffect(() => {
    if (confirmingDiscard) {
      keepEditingRef.current?.focus()
    }
  }, [confirmingDiscard])

  const onSubmit = form.handleSubmit(async (values) => {
    if (values.text === card.text && values.isAnonymous === card.isAnonymous) {
      onClose()
      return
    }
    try {
      await updateMutation.mutateAsync({
        cardId: card.id,
        text: values.text,
        isAnonymous: values.isAnonymous,
      })
      toast.success('Card updated.')
      onClose()
    } catch (error) {
      const code = cardsErrorCodeOf(error)
      if (code === 'card_not_found') {
        // The card leaves the list on the re-read; keep the text on screen.
        onCardGone(form.getValues('text'))
      }
      onWriteError(code, 'save')
    }
  })

  const onFormSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (submittingRef.current || !online || !collecting) {
      return
    }
    submittingRef.current = true
    void onSubmit(event).finally(() => {
      submittingRef.current = false
    })
  }

  const cancel = () => {
    if (changed) {
      setConfirmingDiscard(true)
    } else {
      onClose()
    }
  }

  const keepEditing = () => {
    setConfirmingDiscard(false)
    textareaRef.current?.focus()
  }

  if (!collecting) {
    return changed ? <NotSavedText text={text} /> : null
  }

  const pending = updateMutation.isPending

  return (
    <form
      onSubmit={onFormSubmit}
      noValidate
      aria-label={`Edit ${name}`}
      className="min-w-0 space-y-3"
      onKeyDown={(event) => {
        if (event.key !== 'Escape' || pending) {
          return
        }
        event.preventDefault()
        if (confirmingDiscard) {
          keepEditing()
        } else {
          cancel()
        }
      }}
    >
      <CardFields
        idBase={idBase}
        label={`Edit ${name}`}
        form={form}
        textareaRef={textareaRef}
      />
      <p className="text-xs text-muted-foreground">{MOVE_HINT}</p>
      {confirmingDiscard ? (
        <div
          role="group"
          aria-label="Discard your changes?"
          className="space-y-3 rounded-md border border-dashed p-3"
        >
          <p className="text-sm">Discard your changes?</p>
          <div className="flex flex-wrap gap-2">
            <Button
              ref={keepEditingRef}
              type="button"
              variant="outline"
              onClick={keepEditing}
            >
              Keep editing
            </Button>
            <Button type="button" variant="destructive" onClick={onClose}>
              Discard
            </Button>
          </div>
        </div>
      ) : (
        <div className="flex flex-wrap gap-2">
          <Button type="submit" disabled={pending || !online}>
            {pending ? 'Saving…' : 'Save'}
          </Button>
          <Button
            type="button"
            variant="outline"
            disabled={pending}
            onClick={cancel}
          >
            Cancel
          </Button>
        </div>
      )}
    </form>
  )
}
