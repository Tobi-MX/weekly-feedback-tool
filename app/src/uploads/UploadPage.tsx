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
import { UploadList, uploadName } from './UploadList'
import {
  UPLOAD_STAGE_MESSAGE,
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
  useAddMeetingUpload,
  useCycleUploadsQuery,
  uploadsQueryKey,
  type AddUploadInput,
  type AddUploadResult,
  type RegisteredFile,
} from './useUploads'

export const UPLOAD_PAGE_LOADING_MESSAGE = 'Loading the meeting record…'
export const ROLE_LOAD_ERROR_MESSAGE = 'Could not check your role.'
export const CYCLE_LOAD_ERROR_MESSAGE = 'Could not load the meeting record.'
export const UPLOAD_DENIED_MESSAGE =
  'Only the facilitator can upload the meeting record. Confirmed outcomes appear in the retrospective summary once it is published.'
export const TEXT_SAVED_MESSAGE = 'Transcript text saved.'
export const CHECK_AGAIN_MISSING_MESSAGE =
  'The file has not arrived. Add it again as a new upload.'

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
  readonly type: 'file' | 'text'
  readonly name: string
  /** The row being retried, when known. */
  readonly uploadId: string | null
}

/** A failure shown under the form; `retry` is set once the row exists. */
interface FormFailure {
  readonly code: UploadErrorCode
  readonly retry: {
    readonly registered: RegisteredFile
    readonly file: File
  } | null
}

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

  const mountedRef = useRef(false)
  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
    }
  }, [])
  // A double click or a held Enter must not send a second request before
  // React re-renders.
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
    } else if (code === 'upload_not_found') {
      refetchUploads()
    }
  }

  const send = (
    input: AddUploadInput,
    next: PendingSend,
    onDone: (result: AddUploadResult) => void,
    onFailed: (error: unknown) => void,
  ) => {
    sendingRef.current = true
    setPending(next)
    mutation
      .mutateAsync(input)
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

  const fileFinished = (
    fileKind: FileUploadKind,
    name: string,
    result: AddUploadResult,
  ) => {
    setFailure(null)
    if (result.status === 'rejected') {
      // The file stays selected.
      announce(`${name} was rejected.`)
      return
    }
    clearFile(fileKind)
    announce(`${name} uploaded.`)
  }

  const fileFailed = (file: File, error: unknown) => {
    const code = uploadErrorCodeOf(error)
    setFailure({
      code,
      retry:
        error instanceof RegisteredUploadError
          ? { registered: error.registered, file }
          : null,
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
      setFieldError(null)
      setFailure(null)
      send(
        { type: 'text', text },
        { type: 'text', name: '', uploadId: null },
        () => {
          setText('')
          announce(TEXT_SAVED_MESSAGE)
        },
        (error) => {
          const code = uploadErrorCodeOf(error)
          setFailure({ code, retry: null })
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
      { type: 'file', kind: fileKind, file },
      { type: 'file', name: file.name, uploadId: null },
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
      { type: 'retry', registered: retry.registered, file: retry.file },
      {
        type: 'file',
        name: retry.file.name,
        uploadId: retry.registered.uploadId,
      },
      (result) => {
        if (fileKind !== undefined) {
          fileFinished(fileKind, retry.file.name, result)
        } else {
          setFailure(null)
          announce(
            result.status === 'rejected'
              ? `${retry.file.name} was rejected.`
              : `${retry.file.name} uploaded.`,
          )
        }
      },
      (error) => {
        fileFailed(retry.file, error)
      },
    )
  }

  const checkAgain = (upload: MeetingUpload) => {
    if (sendingRef.current) {
      return
    }
    const name = uploadName(upload)
    send(
      { type: 'check', uploadId: upload.uploadId },
      { type: 'file', name, uploadId: upload.uploadId },
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
    failure !== null ? uploadErrorMessage(failure.code) : null

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
        onRetryLoad={() => {
          void uploadsQuery.refetch()
        }}
        onCheckAgain={checkAgain}
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
