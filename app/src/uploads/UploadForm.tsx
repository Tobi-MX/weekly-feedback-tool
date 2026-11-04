import { useId, type FormEvent, type RefObject } from 'react'
import { focusRing } from '@/cards/CardForms'
import { wrapAnywhere } from '@/board/BoardCards'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import {
  acceptFor,
  type FileProblem,
  type FileUploadKind,
  type TextProblem,
  type UploadKind,
} from './uploadRules'

export const UPLOAD_KIND_OPTIONS: ReadonlyArray<{
  readonly kind: UploadKind
  readonly label: string
  readonly hint: string
}> = [
  {
    kind: 'audio',
    label: 'Audio recording',
    hint: 'MP3, M4A, WAV, OGG or WEBM, up to 200 MB.',
  },
  {
    kind: 'video',
    label: 'Video recording',
    hint: 'MP4, MOV or WEBM, up to 200 MB. An audio recording uploads faster.',
  },
  {
    kind: 'transcript_file',
    label: 'Transcript file',
    hint: 'TXT, VTT or SRT, up to 10 MB.',
  },
  {
    kind: 'transcript_text',
    label: 'Paste transcript text',
    hint: 'Up to 200,000 characters.',
  },
]

export const FILE_INPUT_LABELS: Record<FileUploadKind, string> = {
  audio: 'Audio file',
  video: 'Video file',
  transcript_file: 'Transcript file',
}

export const FILE_KINDS: readonly FileUploadKind[] = [
  'audio',
  'video',
  'transcript_file',
]

export function hintFor(kind: UploadKind): string {
  return UPLOAD_KIND_OPTIONS.find((option) => option.kind === kind)?.hint ?? ''
}

/** The inline message for a failed client check. */
export function fileProblemMessage(
  kind: FileUploadKind,
  problem: FileProblem,
): string {
  switch (problem) {
    case 'missing':
      return 'Choose a file.'
    case 'empty':
      return 'The file is empty.'
    case 'type':
      return `This file type is not accepted. ${hintFor(kind)}`
    case 'too_large':
      return `The file is too large. ${hintFor(kind)}`
    case 'name_too_long':
      return 'The file name is too long (255 characters at most).'
    case 'name_characters':
      return 'The file name contains characters that are not allowed.'
  }
}

export function textProblemMessage(problem: TextProblem): string {
  return problem === 'missing'
    ? 'Paste the transcript text.'
    : 'The transcript text is too long (200,000 characters at most).'
}

const fieldClass = cn(
  'block w-full min-w-0 max-w-full rounded-md border border-input bg-background px-3 py-2 text-sm aria-invalid:border-destructive',
  focusRing,
)

interface UploadFormProps {
  readonly kind: UploadKind
  readonly text: string
  /** The inline message for the current kind's field, or null. */
  readonly fieldError: string | null
  /**
   * The sequence in flight (this tab runs one at a time), or null. `read` is
   * a Read again or Read transcript: the button keeps its label.
   */
  readonly pending: 'file' | 'text' | 'read' | null
  readonly fileInputRefs: Readonly<
    Record<FileUploadKind, RefObject<HTMLInputElement | null>>
  >
  readonly onKindChange: (kind: UploadKind) => void
  readonly onFileChange: (kind: FileUploadKind, file: File | null) => void
  readonly onTextChange: (text: string) => void
  readonly onSubmit: () => void
}

/**
 * The four kinds as native radios, one native file input per file kind
 * (the hidden ones keep their chosen file), and the textarea. Client checks
 * run on submit only, in the page.
 */
export function UploadForm({
  kind,
  text,
  fieldError,
  pending,
  fileInputRefs,
  onKindChange,
  onFileChange,
  onTextChange,
  onSubmit,
}: UploadFormProps) {
  const base = useId()
  const errorId = `${base}-error`
  const hintId = (option: UploadKind) => `${base}-hint-${option}`

  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    onSubmit()
  }

  return (
    <form
      noValidate
      onSubmit={submit}
      className="min-w-0 space-y-4 rounded-lg border bg-card p-4 text-card-foreground"
    >
      <fieldset className="min-w-0 space-y-3">
        <legend className="text-base font-semibold">
          What are you adding?
        </legend>
        {UPLOAD_KIND_OPTIONS.map((option) => (
          <div key={option.kind} className="flex min-w-0 items-start gap-2">
            <input
              id={`${base}-kind-${option.kind}`}
              type="radio"
              name={`${base}-kind`}
              value={option.kind}
              checked={kind === option.kind}
              aria-describedby={hintId(option.kind)}
              className={cn('mt-0.5 size-6 shrink-0', focusRing)}
              onChange={() => {
                onKindChange(option.kind)
              }}
            />
            <div className="min-w-0">
              <label
                htmlFor={`${base}-kind-${option.kind}`}
                className="block text-sm font-medium"
              >
                {option.label}
              </label>
              <p
                id={hintId(option.kind)}
                className={cn('text-sm text-muted-foreground', wrapAnywhere)}
              >
                {option.hint}
              </p>
            </div>
          </div>
        ))}
      </fieldset>

      {FILE_KINDS.map((fileKind) => (
        <div
          key={fileKind}
          hidden={kind !== fileKind}
          className="min-w-0 space-y-1"
        >
          <label
            htmlFor={`${base}-file-${fileKind}`}
            className="block text-sm font-medium"
          >
            {FILE_INPUT_LABELS[fileKind]}
          </label>
          <input
            ref={fileInputRefs[fileKind]}
            id={`${base}-file-${fileKind}`}
            type="file"
            accept={acceptFor(fileKind)}
            aria-invalid={kind === fileKind && fieldError ? 'true' : undefined}
            aria-describedby={
              kind === fileKind && fieldError
                ? `${hintId(fileKind)} ${errorId}`
                : hintId(fileKind)
            }
            className={cn(
              'min-h-9 file:mr-3 file:min-h-6 file:rounded-md file:border file:border-input file:bg-background file:px-2 file:text-sm',
              fieldClass,
              wrapAnywhere,
            )}
            onChange={(event) => {
              onFileChange(fileKind, event.target.files?.[0] ?? null)
            }}
          />
        </div>
      ))}

      <div hidden={kind !== 'transcript_text'} className="min-w-0 space-y-1">
        <label htmlFor={`${base}-text`} className="block text-sm font-medium">
          Transcript text
        </label>
        <textarea
          id={`${base}-text`}
          rows={8}
          value={text}
          aria-invalid={
            kind === 'transcript_text' && fieldError ? 'true' : undefined
          }
          aria-describedby={
            kind === 'transcript_text' && fieldError
              ? `${hintId('transcript_text')} ${errorId}`
              : hintId('transcript_text')
          }
          className={cn('resize-y', fieldClass)}
          onChange={(event) => {
            onTextChange(event.target.value)
          }}
        />
      </div>

      {fieldError !== null ? (
        <p
          id={errorId}
          role="alert"
          className={cn('text-sm text-destructive', wrapAnywhere)}
        >
          {fieldError}
        </p>
      ) : null}

      <Button
        type="submit"
        aria-disabled={pending !== null ? 'true' : undefined}
        className="aria-disabled:opacity-50"
      >
        {pending === 'text'
          ? 'Saving…'
          : pending === 'file'
            ? 'Uploading…'
            : kind === 'transcript_text'
              ? 'Save transcript text'
              : 'Upload'}
      </Button>
    </form>
  )
}
