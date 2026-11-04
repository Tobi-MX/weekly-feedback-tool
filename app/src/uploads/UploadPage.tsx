import { useCallback, useEffect, useRef, useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { Link, useParams } from 'react-router-dom'
import { toast } from 'sonner'
import { useAuth } from '@/auth/AuthProvider'
import { focusRing } from '@/cards/CardForms'
import { NOT_FOUND_MESSAGE } from '@/cards/cardsErrors'
import { wrapAnywhere } from '@/board/BoardCards'
import { Button } from '@/components/ui/button'
import type { CycleDetail } from '@/cycles/cyclesApi'
import { formatWeekStart } from '@/cycles/cycleWeek'
import { useCycleQuery } from '@/cycles/useCycles'
import { cn } from '@/lib/utils'
import { isProjectId } from '@/projects/projectId'
import {
  projectMembersQueryKey,
  useProjectMembersQuery,
} from '@/projects/useMembers'
import {
  FILE_KINDS,
  UploadForm,
  fileProblemMessage,
  textProblemMessage,
} from './UploadForm'
import { PASTED_TEXT_NAME, UploadList, uploadName } from './UploadList'
import {
  isTranscriptParseError,
  parseTranscript,
  resolveTranscriptFormat,
} from './transcriptParser'
import {
  UPLOAD_STAGE_MESSAGE,
  transcriptParseMessage,
  uploadErrorCodeOf,
  uploadErrorMessage,
  type UploadErrorCode,
} from './uploadErrors'
import type { MeetingUpload } from './uploadsApi'
import {
  validateTranscriptText,
  validateUploadFile,
  type FileUploadKind,
  type UploadKind,
} from './uploadRules'
import {
  RegisteredUploadError,
  TranscriptReadError,
  useAddMeetingUpload,
  useCycleUploadsQuery,
  useReadTranscript,
  uploadsQueryKey,
  type AddUploadResult,
  type RegisteredFile,
  type TranscriptReadOutcome,
  type TranscriptSource,
} from './useUploads'

export const UPLOAD_PAGE_LOADING_MESSAGE = 'Loading the meeting record…'
export const ROLE_LOAD_ERROR_MESSAGE = 'Could not check your role.'
export const CYCLE_LOAD_ERROR_MESSAGE = 'Could not load the meeting record.'
export const UPLOAD_DENIED_MESSAGE =
  'Only the facilitator can upload the meeting record. Confirmed outcomes appear in the retrospective summary once it is published.'
export const TEXT_SAVED_MESSAGE = 'Transcript text saved.'
export const CHECK_AGAIN_MISSING_MESSAGE =
  'The file has not arrived. Add it again as a new upload.'
export const PASTED_PARSE_ERROR_PREFIX = 'The pasted text could not be read.'
export const PASTED_TEXT_READ_MESSAGE = 'Pasted transcript text read.'

const linkClass = cn(
  'inline-block rounded-sm text-sm font-medium underline underline-offset-4',
  focusRing,
)

/** The board's not-found state (#16), with the same copy and link. */
function NotFound() {
  return (
    <div className="space-y-3 rounded-lg border border-dashed bg-card p-6 text-card-foreground">
      <p className="text-sm">{NOT_FOUND_MESSAGE}</p>
      <Link to="/projects" className={linkClass}>
        Back to projects
      </Link>
    </div>
  )
}

function LoadError({ text, onRetry }: { text: string; onRetry: () => void }) {
  return (
    <div
      role="alert"
      className="space-y-3 rounded-lg border border-destructive/30 bg-card p-4 text-card-foreground"
    >
      <p className="text-sm">{text}</p>
      <Button type="button" variant="outline" onClick={onRetry}>
        Retry
      </Button>
    </div>
  )
}

function Header({ cycle }: { cycle: CycleDetail }) {
  return (
    <div className="min-w-0 space-y-2">
      <h1 className="text-2xl font-semibold tracking-tight">Meeting record</h1>
      <p className={cn('text-base font-medium', wrapAnywhere)}>{cycle.title}</p>
      <p className="text-sm text-muted-foreground">
        Week of {formatWeekStart(cycle.weekStart)}
      </p>
      <div className="flex flex-wrap gap-x-4 gap-y-2">
        <Link to={`/cycles/${cycle.id}/board`} className={linkClass}>
          Back to board
        </Link>
        <Link to={`/projects/${cycle.projectId}`} className={linkClass}>
          Back to project
        </Link>
      </div>
    </div>
  )
}

/** What the facilitator is sending right now. */
interface PendingSend {
  /** `read` is a Read again or Read transcript. */
  readonly type: 'file' | 'text' | 'read'
  readonly name: string
  /** The row being retried or read, when known. */
  readonly uploadId: string | null
  /** A transcript file moves from uploading to reading. */
  readonly reading: boolean
}

/** A failed read of a row that is still `uploaded` (#29). */
interface ReadRetry {
  readonly source: TranscriptSource
  readonly name: string
  /** The selected file this row came from, cleared once it is read. */
  readonly file: File | null
  /** Pasted text from this tab's form: success says it was saved. */
  readonly fromForm: boolean
}

/**
 * A failure shown under the form: `retry` once the row exists and its upload
 * failed, `read` once it was uploaded and its read failed, or the message of
 * a file the parser refused.
 */
interface FormFailure {
  readonly code: UploadErrorCode
  readonly retry: {
    readonly registered: RegisteredFile
    readonly file: File
  } | null
  readonly read: ReadRetry | null
  readonly message: string | null
}

/** Read failures whose row cannot be read again: their copy says what to do. */
const FINAL_READ_CODES: readonly UploadErrorCode[] = [
  'upload_not_transcript',
  'upload_not_ready',
  'transcript_already_stored',
  'invalid_transcript',
  'upload_not_found',
  'not_project_member',
  'not_project_facilitator',
]

interface MeetingRecordProps {
  readonly cycle: CycleDetail
  readonly onLostAccess: () => void
  readonly onNotFacilitator: () => void
}

/** The facilitator's view: the form in discuss and closed, and the list. */
function MeetingRecord({
  cycle,
  onLostAccess,
  onNotFacilitator,
}: MeetingRecordProps) {
  const { user } = useAuth()
  const userId = user?.id ?? null
  const queryClient = useQueryClient()
  const canUpload = cycle.status === 'discuss' || cycle.status === 'closed'
  const uploadsQuery = useCycleUploadsQuery(cycle.id, true)
  const mutation = useAddMeetingUpload(cycle.id)
  const readMutation = useReadTranscript(cycle.id)

  const mountedRef = useRef(false)
  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
    }
  }, [])
  // A double click or a held Enter must not send a second request before
  // React re-renders. One sequence per tab covers every button.
  const sendingRef = useRef(false)
  const [pending, setPending] = useState<PendingSend | null>(null)

  const [kind, setKind] = useState<UploadKind>('audio')
  const [files, setFiles] = useState<Record<FileUploadKind, File | null>>({
    audio: null,
    video: null,
    transcript_file: null,
  })
  const [text, setText] = useState('')
  const [fieldError, setFieldError] = useState<string | null>(null)
  const [failure, setFailure] = useState<FormFailure | null>(null)
  const audioInputRef = useRef<HTMLInputElement>(null)
  const videoInputRef = useRef<HTMLInputElement>(null)
  const transcriptInputRef = useRef<HTMLInputElement>(null)
  const headingRef = useRef<HTMLHeadingElement | null>(null)

  // #25's keyed status region: each announcement remounts its text.
  const [announcement, setAnnouncement] = useState({ text: '', id: 0 })
  const announce = (next: string) => {
    setAnnouncement((current) => ({ text: next, id: current.id + 1 }))
  }

  const refetchUploads = useCallback(() => {
    void queryClient.invalidateQueries({
      queryKey: uploadsQueryKey(userId, cycle.id),
    })
  }, [queryClient, userId, cycle.id])

  /** The page-level reaction every failed request shares. */
  const reactTo = (code: UploadErrorCode) => {
    if (code === 'not_project_member') {
      onLostAccess()
    } else if (code === 'not_project_facilitator') {
      onNotFacilitator()
    } else if (
      code === 'upload_not_found' ||
      code === 'transcript_already_stored' ||
      code === 'upload_not_ready'
    ) {
      refetchUploads()
    }
  }

  const send = <T,>(
    run: () => Promise<T>,
    next: PendingSend,
    onDone: (result: T) => void,
    onFailed: (error: unknown) => void,
  ) => {
    sendingRef.current = true
    setPending(next)
    run()
      .then(
        (result) => {
          if (mountedRef.current) {
            onDone(result)
          }
        },
        (error: unknown) => {
          if (mountedRef.current) {
            onFailed(error)
          }
        },
      )
      .finally(() => {
        sendingRef.current = false
        if (mountedRef.current) {
          setPending(null)
        }
      })
  }

  /** A transcript file's line moves from `Uploading` to `Reading`. */
  const startReading = () => {
    if (mountedRef.current) {
      setPending((current) =>
        current === null ? current : { ...current, reading: true },
      )
    }
  }

  const clearFile = (fileKind: FileUploadKind) => {
    setFiles((current) => ({ ...current, [fileKind]: null }))
    const input =
      fileKind === 'audio'
        ? audioInputRef.current
        : fileKind === 'video'
          ? videoInputRef.current
          : transcriptInputRef.current
    if (input) {
      input.value = ''
    }
  }

  const clearSelected = (file: File | null) => {
    const fileKind = FILE_KINDS.find((k) => file !== null && files[k] === file)
    if (fileKind !== undefined) {
      clearFile(fileKind)
    }
  }

  /** A refused parse: the row is rejected and the alert says why. */
  const parseFailed = (
    name: string,
    read: Extract<TranscriptReadOutcome, { type: 'rejected' }>,
  ) => {
    setFailure({
      code: 'unknown',
      retry: null,
      read: null,
      message: `${name} was uploaded but could not be read. ${transcriptParseMessage(read.error, read.format)}`,
    })
  }

  const readFailed = (
    error: unknown,
    name: string,
    file: File | null,
    fromForm: boolean,
  ) => {
    const code = uploadErrorCodeOf(error)
    setFailure({
      code,
      retry: null,
      read:
        error instanceof TranscriptReadError
          ? { source: error.source, name, file, fromForm }
          : null,
      message: null,
    })
    reactTo(code)
  }

  const fileFinished = (
    fileKind: FileUploadKind,
    name: string,
    result: AddUploadResult,
  ) => {
    setFailure(null)
    if (result.read?.type === 'rejected') {
      // The file stays selected; the item shows the reason.
      parseFailed(name, result.read)
      return
    }
    if (result.status === 'rejected') {
      // The file stays selected.
      announce(`${name} was rejected.`)
      return
    }
    clearFile(fileKind)
    announce(
      result.read?.type === 'stored'
        ? `${name} uploaded and read.`
        : `${name} uploaded.`,
    )
  }

  const fileFailed = (file: File, error: unknown) => {
    if (error instanceof TranscriptReadError) {
      readFailed(error, file.name, file, false)
      return
    }
    const code = uploadErrorCodeOf(error)
    setFailure({
      code,
      retry:
        error instanceof RegisteredUploadError
          ? { registered: error.registered, file }
          : null,
      read: null,
      message: null,
    })
    reactTo(code)
  }

  const submit = () => {
    if (sendingRef.current) {
      return
    }
    if (kind === 'transcript_text') {
      const problem = validateTranscriptText(text)
      if (problem !== null) {
        setFieldError(textProblemMessage(problem))
        return
      }
      // #29, decision 10: parse first; bad text is never registered.
      const parsed = parseTranscript(text, 'auto')
      if (isTranscriptParseError(parsed)) {
        setFieldError(
          `${PASTED_PARSE_ERROR_PREFIX} ${transcriptParseMessage(parsed, resolveTranscriptFormat(text, 'auto'))}`,
        )
        return
      }
      setFieldError(null)
      setFailure(null)
      send(
        () => mutation.mutateAsync({ type: 'text', text, parsed }),
        { type: 'text', name: '', uploadId: null, reading: false },
        () => {
          setText('')
          announce(TEXT_SAVED_MESSAGE)
        },
        (error) => {
          if (error instanceof TranscriptReadError) {
            // Registered: Read again re-sends the parsed text, so the form
            // must not register it a second time.
            setText('')
            readFailed(error, PASTED_TEXT_NAME, null, true)
            return
          }
          const code = uploadErrorCodeOf(error)
          setFailure({ code, retry: null, read: null, message: null })
          reactTo(code)
        },
      )
      return
    }
    const fileKind = kind
    const file = files[fileKind]
    const problem = validateUploadFile(fileKind, file)
    if (problem !== null || file === null) {
      setFieldError(fileProblemMessage(fileKind, problem ?? 'missing'))
      return
    }
    setFieldError(null)
    setFailure(null)
    send(
      () =>
        mutation.mutateAsync({
          type: 'file',
          kind: fileKind,
          file,
          onReading: startReading,
        }),
      { type: 'file', name: file.name, uploadId: null, reading: false },
      (result) => {
        fileFinished(fileKind, file.name, result)
      },
      (error) => {
        fileFailed(file, error)
      },
    )
  }

  const retryUpload = () => {
    const retry = failure?.retry
    if (sendingRef.current || !retry) {
      return
    }
    const fileKind = FILE_KINDS.find((k) => files[k] === retry.file)
    send(
      () =>
        mutation.mutateAsync({
          type: 'retry',
          registered: retry.registered,
          file: retry.file,
          onReading: startReading,
        }),
      {
        type: 'file',
        name: retry.file.name,
        uploadId: retry.registered.uploadId,
        reading: false,
      },
      (result) => {
        if (fileKind !== undefined) {
          fileFinished(fileKind, retry.file.name, result)
        } else if (result.read?.type === 'rejected') {
          parseFailed(retry.file.name, result.read)
        } else {
          setFailure(null)
          announce(
            result.status === 'rejected'
              ? `${retry.file.name} was rejected.`
              : result.read?.type === 'stored'
                ? `${retry.file.name} uploaded and read.`
                : `${retry.file.name} uploaded.`,
          )
        }
      },
      (error) => {
        fileFailed(retry.file, error)
      },
    )
  }

  /** One read of an `uploaded` transcript row: Read again or Read transcript. */
  const read = (retry: ReadRetry) => {
    if (sendingRef.current) {
      return
    }
    send(
      () => readMutation.mutateAsync(retry.source),
      {
        type: 'read',
        name: retry.name,
        uploadId: retry.source.uploadId,
        reading: true,
      },
      (outcome) => {
        if (outcome.type === 'rejected') {
          parseFailed(retry.name, outcome)
          return
        }
        setFailure(null)
        clearSelected(retry.file)
        announce(
          retry.fromForm
            ? TEXT_SAVED_MESSAGE
            : retry.source.type === 'text'
              ? PASTED_TEXT_READ_MESSAGE
              : `${retry.name} read.`,
        )
      },
      (error) => {
        readFailed(error, retry.name, retry.file, retry.fromForm)
      },
    )
  }

  const readAgain = () => {
    const retry = failure?.read
    if (retry) {
      read(retry)
    }
  }

  const readTranscriptOf = (upload: MeetingUpload) => {
    const name = uploadName(upload)
    if (upload.kind === 'transcript_text') {
      read({
        source: { type: 'text', uploadId: upload.uploadId, parsed: null },
        name,
        file: null,
        fromForm: false,
      })
    } else if (upload.storagePath !== null) {
      read({
        source: {
          type: 'file',
          uploadId: upload.uploadId,
          storagePath: upload.storagePath,
          mimeType: upload.mimeType,
        },
        name,
        file: null,
        fromForm: false,
      })
    }
  }

  const checkAgain = (upload: MeetingUpload) => {
    if (sendingRef.current) {
      return
    }
    const name = uploadName(upload)
    send(
      () => mutation.mutateAsync({ type: 'check', uploadId: upload.uploadId }),
      { type: 'file', name, uploadId: upload.uploadId, reading: false },
      (result) => {
        announce(
          result.status === 'rejected'
            ? `${name} was rejected.`
            : `${name} uploaded.`,
        )
      },
      (error) => {
        const code = uploadErrorCodeOf(error)
        reactTo(code)
        if (code === 'upload_file_missing') {
          toast.error(CHECK_AGAIN_MISSING_MESSAGE)
          return
        }
        const message = uploadErrorMessage(code)
        if (message !== null) {
          toast.error(message)
        }
      },
    )
  }

  const failureMessage =
    failure === null
      ? null
      : (failure.message ?? uploadErrorMessage(failure.code))
  const canReadAgain =
    failure?.read != null && !FINAL_READ_CODES.includes(failure.code)

  return (
    <>
      <p
        role="status"
        aria-live="polite"
        aria-atomic="true"
        className="sr-only"
      >
        <span key={announcement.id}>{announcement.text}</span>
      </p>
      {canUpload ? (
        <section
          aria-label="Add to the meeting record"
          className="min-w-0 space-y-3"
        >
          <UploadForm
            kind={kind}
            text={text}
            fieldError={fieldError}
            pending={pending?.type ?? null}
            fileInputRefs={{
              audio: audioInputRef,
              video: videoInputRef,
              transcript_file: transcriptInputRef,
            }}
            onKindChange={(next) => {
              setKind(next)
              setFieldError(null)
            }}
            onFileChange={(fileKind, file) => {
              setFiles((current) => ({ ...current, [fileKind]: file }))
            }}
            onTextChange={setText}
            onSubmit={submit}
          />
          {pending !== null ? (
            <p role="status" className={cn('text-sm', wrapAnywhere)}>
              {pending.type === 'text'
                ? 'Saving transcript text…'
                : pending.reading
                  ? `Reading ${pending.name}…`
                  : `Uploading ${pending.name}…`}
            </p>
          ) : null}
          {failureMessage !== null ? (
            <div
              role="alert"
              className="min-w-0 space-y-3 rounded-lg border border-destructive/30 bg-card p-4 text-card-foreground"
            >
              <p className={cn('text-sm', wrapAnywhere)}>{failureMessage}</p>
              {failure?.retry ? (
                <Button
                  type="button"
                  variant="outline"
                  aria-disabled={pending !== null ? 'true' : undefined}
                  className="aria-disabled:opacity-50"
                  onClick={retryUpload}
                >
                  Retry upload
                </Button>
              ) : null}
              {canReadAgain ? (
                <Button
                  type="button"
                  variant="outline"
                  aria-disabled={pending !== null ? 'true' : undefined}
                  className="aria-disabled:opacity-50"
                  onClick={readAgain}
                >
                  Read again
                </Button>
              ) : null}
            </div>
          ) : null}
        </section>
      ) : (
        <p className="rounded-lg border bg-card p-4 text-sm text-card-foreground">
          {UPLOAD_STAGE_MESSAGE}
        </p>
      )}
      <UploadList
        uploads={uploadsQuery.data?.uploads}
        isError={uploadsQuery.isError}
        headingRef={headingRef}
        activeUploadId={pending?.uploadId ?? null}
        busy={pending !== null}
        canRead={canUpload}
        onRetryLoad={() => {
          void uploadsQuery.refetch()
        }}
        onCheckAgain={checkAgain}
        onReadTranscript={readTranscriptOf}
      />
    </>
  )
}

function UploadScreen({ cycleId }: { cycleId: string }) {
  const { user } = useAuth()
  const userId = user?.id ?? null
  const queryClient = useQueryClient()
  const validId = isProjectId(cycleId)
  const [lostAccess, setLostAccess] = useState(false)

  const cycleQuery = useCycleQuery(cycleId, validId && !lostAccess)
  const cycle = cycleQuery.data
  const notFound = !validId || lostAccess || cycle === null
  const projectId = !notFound && cycle ? cycle.projectId : undefined
  const membersQuery = useProjectMembersQuery(projectId)
  // The role comes from the caller's own member row, never owner_id.
  const isFacilitator =
    membersQuery.data?.some(
      (member) => member.isMe && member.role === 'facilitator',
    ) === true

  const onLostAccess = useCallback(() => {
    setLostAccess(true)
  }, [])

  const onNotFacilitator = useCallback(() => {
    if (projectId !== undefined) {
      void queryClient.invalidateQueries({
        queryKey: projectMembersQueryKey(userId, projectId),
      })
    }
  }, [queryClient, userId, projectId])

  let body: React.ReactNode
  if (notFound) {
    body = <NotFound />
  } else if (cycle === undefined && cycleQuery.isError) {
    body = (
      <LoadError
        text={CYCLE_LOAD_ERROR_MESSAGE}
        onRetry={() => {
          void cycleQuery.refetch()
        }}
      />
    )
  } else if (
    cycle === undefined ||
    (membersQuery.data === undefined && !membersQuery.isError)
  ) {
    body = (
      <p role="status" className="text-sm text-muted-foreground">
        {UPLOAD_PAGE_LOADING_MESSAGE}
      </p>
    )
  } else if (membersQuery.isError && membersQuery.data === undefined) {
    body = (
      <>
        <Header cycle={cycle} />
        <LoadError
          text={ROLE_LOAD_ERROR_MESSAGE}
          onRetry={() => {
            void membersQuery.refetch()
          }}
        />
      </>
    )
  } else if (!isFacilitator) {
    body = (
      <>
        <Header cycle={cycle} />
        <p className="rounded-lg border bg-card p-4 text-sm text-card-foreground">
          {UPLOAD_DENIED_MESSAGE}
        </p>
      </>
    )
  } else {
    body = (
      <>
        <Header cycle={cycle} />
        <MeetingRecord
          cycle={cycle}
          onLostAccess={onLostAccess}
          onNotFacilitator={onNotFacilitator}
        />
      </>
    )
  }

  return <div className="min-w-0 space-y-4">{body}</div>
}

/** `/cycles/:id/upload`: the facilitator adds the meeting record (#28). */
export function UploadPage() {
  const { id = '' } = useParams<{ id: string }>()
  return <UploadScreen key={id} cycleId={id} />
}

export default UploadPage
