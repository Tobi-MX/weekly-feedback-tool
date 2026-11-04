import { act, fireEvent, screen, waitFor, within } from '@testing-library/react'
import { toast } from 'sonner'
import { describe, expect, it, vi } from 'vitest'
import type { CycleDetail } from '../cycles/cyclesApi'
import type { CycleStatus } from '../cycles/cycleStatus'
import type { ProjectMember } from '../projects/membersApi'
import { MembersApiError } from '../projects/membersErrors'
import { deferred, mockRestoredSession } from '../test/authMock'
import { cyclesMock } from '../test/cyclesMock'
import { membersMock } from '../test/membersMock'
import { profileMock } from '../test/profileMock'
import { renderApp } from '../test/renderApp'
import { uploadsMock } from '../test/uploadsMock'
import { UploadApiError, type UploadErrorCode } from './uploadErrors'
import type {
  CompletedUpload,
  CreatedUpload,
  CycleUploads,
  MeetingUpload,
} from './uploadsApi'
import type { UploadStatus } from './uploadRules'

const CYCLE_ID = '30000000-0000-4000-8000-000000000001'
const PROJECT_ID = '10000000-0000-4000-8000-000000000001'
const UPLOAD_ID = 'b1000000-0000-4000-8000-000000000001'
const PATH = `/cycles/${CYCLE_ID}/upload`
const STORAGE_PATH = `${PROJECT_ID}/${CYCLE_ID}/${UPLOAD_ID}.mp3`
const NOT_FOUND = 'Cycle not found or you do not have access.'
const DENIED =
  'Only the facilitator can upload the meeting record. Confirmed outcomes appear in the retrospective summary once it is published.'
const STAGE_SENTENCE =
  'The meeting record can be uploaded once the retrospective reaches the Discuss stage.'
const T = '2026-11-04T12:00:00.000Z'

const AUDIO_HINT = 'MP3, M4A, WAV, OGG or WEBM, up to 200 MB.'
const VIDEO_HINT =
  'MP4, MOV or WEBM, up to 200 MB. An audio recording uploads faster.'
const TRANSCRIPT_HINT = 'TXT, VTT or SRT, up to 10 MB.'
const TEXT_HINT = 'Up to 200,000 characters.'

const cycle: CycleDetail = {
  id: CYCLE_ID,
  projectId: PROJECT_ID,
  title: 'Sprint twelve retro',
  weekStart: '2026-10-26',
  status: 'discuss',
}

function memberRow(overrides: Partial<ProjectMember>): ProjectMember {
  return {
    userId: 'user-1',
    displayName: 'Dev User',
    role: 'facilitator',
    isOwner: true,
    isMe: true,
    joinedAt: '2026-10-30T12:00:00.000Z',
    ...overrides,
  }
}

const asFacilitator = [memberRow({})]
const asMember = [
  memberRow({ role: 'member', isOwner: false }),
  memberRow({ userId: 'user-2', displayName: 'Fac', isMe: false }),
]
const asFormerFacilitator = [
  memberRow({ role: 'member', isOwner: true }),
  memberRow({ userId: 'user-2', isMe: false, isOwner: false }),
]

function item(overrides: Partial<MeetingUpload> = {}): MeetingUpload {
  return {
    uploadId: UPLOAD_ID,
    kind: 'audio',
    status: 'uploaded',
    originalFilename: 'standup.MP3',
    mimeType: 'audio/mpeg',
    sizeBytes: 16,
    textLength: null,
    storagePath: STORAGE_PATH,
    errorCode: null,
    errorMessage: null,
    createdAt: T,
    uploadedAt: T,
    updatedAt: T,
    ...overrides,
  }
}

function textItem(overrides: Partial<MeetingUpload> = {}): MeetingUpload {
  return item({
    uploadId: 'b1000000-0000-4000-8000-000000000009',
    kind: 'transcript_text',
    originalFilename: null,
    mimeType: null,
    sizeBytes: null,
    textLength: 12,
    storagePath: null,
    ...overrides,
  })
}

function list(...uploads: MeetingUpload[]): CycleUploads {
  return { cycleId: CYCLE_ID, uploads }
}

const created: CreatedUpload = {
  uploadId: UPLOAD_ID,
  kind: 'audio',
  status: 'pending_upload',
  storagePath: STORAGE_PATH,
  mimeType: 'audio/mpeg',
}

function completed(status: UploadStatus = 'uploaded'): CompletedUpload {
  return {
    uploadId: UPLOAD_ID,
    status,
    errorCode: status === 'rejected' ? 'upload_file_mismatch' : null,
  }
}

interface SetupOptions {
  readonly status?: CycleStatus
  readonly members?: ProjectMember[]
  readonly uploads?: CycleUploads
  readonly path?: string
}

function setup(options: SetupOptions = {}) {
  mockRestoredSession('dev@example.com', 'user-1')
  profileMock.fetchProfileDisplayName.mockResolvedValue('Dev User')
  cyclesMock.fetchCycle.mockResolvedValue({
    ...cycle,
    status: options.status ?? 'discuss',
  })
  membersMock.fetchProjectMembers.mockResolvedValue(
    options.members ?? asFacilitator,
  )
  uploadsMock.fetchCycleUploads.mockResolvedValue(options.uploads ?? list())
  return renderApp({ initialEntries: [options.path ?? PATH] })
}

function makeFile(name: string, size = 16, type = ''): File {
  const file = new File([new Uint8Array(Math.min(size, 64))], name, { type })
  Object.defineProperty(file, 'size', { value: size })
  return file
}

function fileInput(label: string): HTMLInputElement {
  // "Transcript file" also names a radio.
  return screen.getByLabelText(label, { selector: 'input[type="file"]' })
}

function choose(input: HTMLInputElement, file: File | null) {
  Object.defineProperty(input, 'files', {
    value: file === null ? [] : [file],
    configurable: true,
  })
  fireEvent.change(input)
}

function statusRegion(): HTMLElement {
  const region = document.querySelector('p.sr-only[role="status"]')
  if (!(region instanceof HTMLElement)) {
    throw new Error('no status region')
  }
  return region
}

async function formReady() {
  return screen.findByRole('group', { name: 'What are you adding?' })
}

async function flush() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0))
  })
}

describe('upload page', () => {
  it('replaces the placeholder with the header and its links', async () => {
    setup()
    expect(
      await screen.findByRole('heading', { level: 1, name: 'Meeting record' }),
    ).toBeInTheDocument()
    expect(screen.getByText('Sprint twelve retro')).toBeInTheDocument()
    expect(screen.getByText('Week of Oct 26, 2026')).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'Back to board' })).toHaveAttribute(
      'href',
      `/cycles/${CYCLE_ID}/board`,
    )
    expect(
      screen.getByRole('link', { name: 'Back to project' }),
    ).toHaveAttribute('href', `/projects/${PROJECT_ID}`)
    expect(
      screen.queryByText('This screen is not built yet.'),
    ).not.toBeInTheDocument()
  })

  it('shows the loading text while the cycle or members load', async () => {
    mockRestoredSession('dev@example.com', 'user-1')
    profileMock.fetchProfileDisplayName.mockResolvedValue('Dev User')
    const members = deferred<ProjectMember[]>()
    cyclesMock.fetchCycle.mockResolvedValue(cycle)
    membersMock.fetchProjectMembers.mockReturnValue(members.promise)
    uploadsMock.fetchCycleUploads.mockResolvedValue(list())
    renderApp({ initialEntries: [PATH] })
    expect(
      await screen.findByText('Loading the meeting record…'),
    ).toBeInTheDocument()
    members.resolve(asFacilitator)
    expect(await formReady()).toBeInTheDocument()
  })

  it.each<[string, string]>([
    ['an unknown cycle', PATH],
    ['a non-UUID id', '/cycles/not-a-uuid/upload'],
  ])('shows the not-found state for %s', async (_label, path) => {
    setup({ path })
    cyclesMock.fetchCycle.mockResolvedValue(null)
    expect(await screen.findByText(NOT_FOUND)).toBeInTheDocument()
    expect(
      screen.queryByRole('heading', { name: 'Meeting record' }),
    ).not.toBeInTheDocument()
    expect(uploadsMock.fetchCycleUploads).not.toHaveBeenCalled()
  })

  it('shows the not-found state for a non-member (the cycle read returns null)', async () => {
    mockRestoredSession('dev@example.com', 'user-1')
    profileMock.fetchProfileDisplayName.mockResolvedValue('Dev User')
    cyclesMock.fetchCycle.mockResolvedValue(null)
    renderApp({ initialEntries: [PATH] })
    expect(await screen.findByText(NOT_FOUND)).toBeInTheDocument()
    expect(membersMock.fetchProjectMembers).not.toHaveBeenCalled()
    expect(uploadsMock.fetchCycleUploads).not.toHaveBeenCalled()
  })

  it('shows "Could not check your role." with Retry when the members read fails', async () => {
    setup()
    membersMock.fetchProjectMembers.mockRejectedValue(
      new MembersApiError('unknown'),
    )
    expect(
      await screen.findByText('Could not check your role.'),
    ).toBeInTheDocument()
    expect(
      screen.queryByRole('group', { name: 'What are you adding?' }),
    ).not.toBeInTheDocument()
    expect(screen.queryByRole('heading', { name: /^Uploads/ })).toBeNull()
    expect(uploadsMock.fetchCycleUploads).not.toHaveBeenCalled()
    membersMock.fetchProjectMembers.mockResolvedValue(asFacilitator)
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }))
    expect(await formReady()).toBeInTheDocument()
  })

  it.each<[string, ProjectMember[]]>([
    ['a member', asMember],
    ['the owner who is not the facilitator', asFormerFacilitator],
  ])(
    'shows only the denied copy to %s and never lists',
    async (_who, members) => {
      setup({ members })
      expect(await screen.findByText(DENIED)).toBeInTheDocument()
      expect(
        screen.queryByRole('group', { name: 'What are you adding?' }),
      ).not.toBeInTheDocument()
      expect(screen.queryByRole('heading', { name: /^Uploads/ })).toBeNull()
      await flush()
      expect(uploadsMock.fetchCycleUploads).not.toHaveBeenCalled()
    },
  )

  it('shows the stage sentence and the list, but no form, to the facilitator in vote', async () => {
    setup({ status: 'vote', uploads: list(item()) })
    expect(await screen.findByText(STAGE_SENTENCE)).toBeInTheDocument()
    expect(
      await screen.findByRole('heading', { level: 2, name: 'Uploads (1)' }),
    ).toBeInTheDocument()
    expect(
      screen.queryByRole('group', { name: 'What are you adding?' }),
    ).not.toBeInTheDocument()
  })

  it.each<CycleStatus>(['discuss', 'closed'])(
    'shows the form and the list in %s',
    async (status) => {
      setup({ status })
      expect(await formReady()).toBeInTheDocument()
      expect(await screen.findByText('No uploads yet.')).toBeInTheDocument()
      expect(screen.queryByText(STAGE_SENTENCE)).not.toBeInTheDocument()
    },
  )
})

describe('upload form', () => {
  it('has the four radios with Audio recording checked, the hints, and the per-kind input', async () => {
    setup()
    const group = await formReady()
    const radios = within(group).getAllByRole('radio')
    expect(radios.map((radio) => radio.getAttribute('value'))).toEqual([
      'audio',
      'video',
      'transcript_file',
      'transcript_text',
    ])
    expect(
      within(group).getByRole('radio', { name: 'Audio recording' }),
    ).toBeChecked()
    for (const hint of [AUDIO_HINT, VIDEO_HINT, TRANSCRIPT_HINT, TEXT_HINT]) {
      expect(within(group).getByText(hint)).toBeInTheDocument()
    }
    expect(fileInput('Audio file')).toHaveAttribute(
      'accept',
      '.mp3,.m4a,.wav,.ogg,.webm',
    )
    expect(fileInput('Audio file')).toBeVisible()
    expect(screen.getByRole('button', { name: 'Upload' })).toBeInTheDocument()

    fireEvent.click(screen.getByRole('radio', { name: 'Video recording' }))
    expect(fileInput('Video file')).toBeVisible()
    expect(fileInput('Video file')).toHaveAttribute('accept', '.mp4,.mov,.webm')
    expect(fileInput('Audio file')).not.toBeVisible()

    fireEvent.click(screen.getByRole('radio', { name: 'Transcript file' }))
    expect(fileInput('Transcript file')).toHaveAttribute(
      'accept',
      '.txt,.vtt,.srt',
    )

    fireEvent.click(
      screen.getByRole('radio', { name: 'Paste transcript text' }),
    )
    const textarea = screen.getByLabelText('Transcript text')
    expect(textarea.tagName).toBe('TEXTAREA')
    expect(textarea).not.toHaveAttribute('maxLength')
    expect(
      screen.getByRole('button', { name: 'Save transcript text' }),
    ).toBeInTheDocument()
  })

  it("keeps each kind's file and text when switching kinds", async () => {
    setup()
    uploadsMock.createMeetingUpload.mockResolvedValue(created)
    uploadsMock.uploadMeetingFile.mockResolvedValue(undefined)
    uploadsMock.completeMeetingUpload.mockResolvedValue(completed())
    await formReady()
    choose(fileInput('Audio file'), makeFile('standup.mp3'))
    fireEvent.click(
      screen.getByRole('radio', { name: 'Paste transcript text' }),
    )
    fireEvent.change(screen.getByLabelText('Transcript text'), {
      target: { value: 'Hello' },
    })
    fireEvent.click(screen.getByRole('radio', { name: 'Video recording' }))
    fireEvent.click(
      screen.getByRole('radio', { name: 'Paste transcript text' }),
    )
    expect(screen.getByLabelText('Transcript text')).toHaveValue('Hello')
    fireEvent.click(screen.getByRole('radio', { name: 'Audio recording' }))
    fireEvent.click(screen.getByRole('button', { name: 'Upload' }))
    await waitFor(() => {
      expect(uploadsMock.createMeetingUpload).toHaveBeenCalledWith(CYCLE_ID, {
        kind: 'audio',
        filename: 'standup.mp3',
        size: 16,
      })
    })
  })
})

describe('client validation', () => {
  it.each<[string, string, File | null, string]>([
    ['no file', 'Audio recording', null, 'Choose a file.'],
    [
      'an empty file',
      'Audio recording',
      makeFile('a.mp3', 0),
      'The file is empty.',
    ],
    [
      'mp4 as audio',
      'Audio recording',
      makeFile('a.mp4'),
      `This file type is not accepted. ${AUDIO_HINT}`,
    ],
    [
      'a file over 200 MB',
      'Video recording',
      makeFile('a.mp4', 209_715_201),
      `The file is too large. ${VIDEO_HINT}`,
    ],
    [
      'a transcript over 10 MB',
      'Transcript file',
      makeFile('a.srt', 10_485_761),
      `The file is too large. ${TRANSCRIPT_HINT}`,
    ],
    [
      'a 256-character name',
      'Audio recording',
      makeFile(`${'a'.repeat(252)}.mp3`),
      'The file name is too long (255 characters at most).',
    ],
    [
      'a control character',
      'Audio recording',
      makeFile('a\u0001.mp3'),
      'The file name contains characters that are not allowed.',
    ],
  ])(
    'shows its message for %s, tied to the input, and sends nothing',
    async (_label, kindLabel, file, message) => {
      setup()
      await formReady()
      fireEvent.click(screen.getByRole('radio', { name: kindLabel }))
      const label =
        kindLabel === 'Audio recording'
          ? 'Audio file'
          : kindLabel === 'Video recording'
            ? 'Video file'
            : 'Transcript file'
      const input = fileInput(label)
      if (file !== null) {
        choose(input, file)
      }
      fireEvent.click(screen.getByRole('button', { name: 'Upload' }))
      const alert = await screen.findByText(message)
      expect(input.getAttribute('aria-describedby')?.split(' ')).toContain(
        alert.id,
      )
      expect(input).toHaveAttribute('aria-invalid', 'true')
      expect(uploadsMock.createMeetingUpload).not.toHaveBeenCalled()
      if (file !== null) {
        expect(input.files?.[0]).toBe(file)
      }
    },
  )

  it.each<[string, string]>([
    ['', 'Paste the transcript text.'],
    ['  \n\t ', 'Paste the transcript text.'],
    [
      'a'.repeat(200_001),
      'The transcript text is too long (200,000 characters at most).',
    ],
  ])(
    'shows its message for text %#, and keeps the text',
    async (value, message) => {
      setup()
      await formReady()
      fireEvent.click(
        screen.getByRole('radio', { name: 'Paste transcript text' }),
      )
      const textarea = screen.getByLabelText('Transcript text')
      fireEvent.change(textarea, { target: { value } })
      fireEvent.click(
        screen.getByRole('button', { name: 'Save transcript text' }),
      )
      const alert = await screen.findByText(message)
      expect(textarea.getAttribute('aria-describedby')?.split(' ')).toContain(
        alert.id,
      )
      expect(uploadsMock.createMeetingUpload).not.toHaveBeenCalled()
      expect(textarea).toHaveValue(value)
    },
  )
})

describe('sending', () => {
  it('uploads standup.MP3: create, upload, complete; one request while pending; announced once after the refetch', async () => {
    setup()
    const create = deferred<CreatedUpload>()
    uploadsMock.createMeetingUpload.mockReturnValue(create.promise)
    uploadsMock.uploadMeetingFile.mockResolvedValue(undefined)
    uploadsMock.completeMeetingUpload.mockResolvedValue(completed())
    await formReady()
    const input = fileInput('Audio file')
    const file = makeFile('standup.MP3')
    choose(input, file)
    const button = screen.getByRole('button', { name: 'Upload' })
    fireEvent.click(button)
    fireEvent.click(button)
    fireEvent.submit(button.closest('form') as HTMLFormElement)
    fireEvent.keyDown(button, { key: 'Enter' })
    expect(
      await screen.findByRole('button', { name: 'Uploading…' }),
    ).toHaveAttribute('aria-disabled', 'true')
    expect(screen.getByText('Uploading standup.MP3…')).toBeVisible()
    fireEvent.click(screen.getByRole('button', { name: 'Uploading…' }))
    expect(uploadsMock.createMeetingUpload).toHaveBeenCalledTimes(1)
    expect(uploadsMock.createMeetingUpload).toHaveBeenCalledWith(CYCLE_ID, {
      kind: 'audio',
      filename: 'standup.MP3',
      size: 16,
    })

    uploadsMock.fetchCycleUploads.mockResolvedValue(list(item()))
    create.resolve(created)
    await waitFor(() => {
      expect(statusRegion()).toHaveTextContent('standup.MP3 uploaded.')
    })
    expect(uploadsMock.uploadMeetingFile).toHaveBeenCalledTimes(1)
    expect(uploadsMock.uploadMeetingFile).toHaveBeenCalledWith({
      storagePath: STORAGE_PATH,
      mimeType: 'audio/mpeg',
      file,
    })
    expect(uploadsMock.completeMeetingUpload).toHaveBeenCalledTimes(1)
    expect(uploadsMock.completeMeetingUpload).toHaveBeenCalledWith(UPLOAD_ID)
    expect(screen.getByText('Status: Uploaded')).toBeInTheDocument()
    expect(input.value).toBe('')
    expect(screen.getByRole('button', { name: 'Upload' })).not.toHaveAttribute(
      'aria-disabled',
    )
    // The selection was cleared: submitting again needs a new file.
    fireEvent.click(screen.getByRole('button', { name: 'Upload' }))
    expect(await screen.findByText('Choose a file.')).toBeInTheDocument()
    expect(uploadsMock.createMeetingUpload).toHaveBeenCalledTimes(1)
  })

  it('saves pasted text with no Storage call', async () => {
    setup()
    uploadsMock.createMeetingUpload.mockResolvedValue({
      uploadId: textItem().uploadId,
      kind: 'transcript_text',
      status: 'uploaded',
      storagePath: null,
      mimeType: null,
    })
    await formReady()
    fireEvent.click(
      screen.getByRole('radio', { name: 'Paste transcript text' }),
    )
    const textarea = screen.getByLabelText('Transcript text')
    fireEvent.change(textarea, { target: { value: 'We shipped it' } })
    uploadsMock.fetchCycleUploads.mockResolvedValue(
      list(textItem({ textLength: 13 })),
    )
    fireEvent.click(
      screen.getByRole('button', { name: 'Save transcript text' }),
    )
    expect(
      await screen.findByRole('button', { name: 'Saving…' }),
    ).toBeInTheDocument()
    await waitFor(() => {
      expect(statusRegion()).toHaveTextContent('Transcript text saved.')
    })
    expect(uploadsMock.createMeetingUpload).toHaveBeenCalledTimes(1)
    expect(uploadsMock.createMeetingUpload).toHaveBeenCalledWith(CYCLE_ID, {
      kind: 'transcript_text',
      pasted_text: 'We shipped it',
    })
    expect(uploadsMock.uploadMeetingFile).not.toHaveBeenCalled()
    expect(uploadsMock.completeMeetingUpload).not.toHaveBeenCalled()
    expect(textarea).toHaveValue('')
    const entry = screen.getByText('Pasted transcript text').closest('li')
    expect(entry).toHaveTextContent('13 characters')
    expect(entry).toHaveTextContent('Status: Uploaded')
  })

  it.each<[string, () => void, string]>([
    [
      'an upload failure',
      () => {
        uploadsMock.uploadMeetingFile.mockRejectedValueOnce(
          new UploadApiError('upload_failed'),
        )
      },
      'The file could not be uploaded. Check your connection and try again.',
    ],
    [
      'a completion failure (upload_file_missing)',
      () => {
        uploadsMock.completeMeetingUpload.mockRejectedValueOnce(
          new UploadApiError('upload_file_missing'),
        )
      },
      'The file has not arrived. Try the upload again.',
    ],
  ])(
    '%s shows its alert, keeps the file, and Retry upload reuses the row',
    async (_label, fail, message) => {
      setup()
      uploadsMock.createMeetingUpload.mockResolvedValue(created)
      uploadsMock.uploadMeetingFile.mockResolvedValue(undefined)
      uploadsMock.completeMeetingUpload.mockResolvedValue(completed())
      fail()
      await formReady()
      const input = fileInput('Audio file')
      const file = makeFile('standup.mp3')
      choose(input, file)
      fireEvent.click(screen.getByRole('button', { name: 'Upload' }))
      const alert = await screen.findByText(message)
      expect(alert.closest('[role="alert"]')).not.toBeNull()
      expect(statusRegion()).toHaveTextContent('')
      expect(input.files?.[0]).toBe(file)

      uploadsMock.fetchCycleUploads.mockResolvedValue(list(item()))
      fireEvent.click(screen.getByRole('button', { name: 'Retry upload' }))
      await waitFor(() => {
        expect(statusRegion()).toHaveTextContent('standup.mp3 uploaded.')
      })
      expect(uploadsMock.createMeetingUpload).toHaveBeenCalledTimes(1)
      expect(uploadsMock.uploadMeetingFile).toHaveBeenLastCalledWith({
        storagePath: STORAGE_PATH,
        mimeType: 'audio/mpeg',
        file,
      })
      expect(screen.queryByText(message)).not.toBeInTheDocument()
    },
  )

  it('a completion returning rejected announces it, keeps the file, and the item shows the reason', async () => {
    setup()
    uploadsMock.createMeetingUpload.mockResolvedValue(created)
    uploadsMock.uploadMeetingFile.mockResolvedValue(undefined)
    uploadsMock.completeMeetingUpload.mockResolvedValue(completed('rejected'))
    await formReady()
    const input = fileInput('Audio file')
    const file = makeFile('standup.mp3')
    choose(input, file)
    uploadsMock.fetchCycleUploads.mockResolvedValue(
      list(
        item({
          status: 'rejected',
          errorCode: 'upload_file_mismatch',
          uploadedAt: null,
          originalFilename: 'standup.mp3',
        }),
      ),
    )
    fireEvent.click(screen.getByRole('button', { name: 'Upload' }))
    await waitFor(() => {
      expect(statusRegion()).toHaveTextContent('standup.mp3 was rejected.')
    })
    expect(statusRegion()).not.toHaveTextContent('uploaded.')
    expect(input.files?.[0]).toBe(file)
    expect(
      screen.getByText(
        'The uploaded file did not match the file that was registered. Add it again as a new upload.',
      ),
    ).toBeInTheDocument()
  })

  it.each<[UploadErrorCode, string]>([
    ['cycle_not_discussing', STAGE_SENTENCE],
    ['invalid_upload_kind', 'Choose what you are adding.'],
    ['invalid_upload_file', 'This file type or name is not accepted.'],
    [
      'upload_too_large',
      'The file is too large. Audio and video can be up to 200 MB, transcript files up to 10 MB.',
    ],
    [
      'invalid_transcript_text',
      'Paste between 1 and 200,000 characters of transcript text.',
    ],
    [
      'upload_limit_reached',
      'This retrospective has reached its upload limit.',
    ],
    ['upload_not_found', 'This upload no longer exists.'],
    ['unknown', 'Something went wrong. Try again.'],
  ])(
    'a create refused with %s shows its copy and no Retry upload',
    async (code, message) => {
      setup()
      uploadsMock.createMeetingUpload.mockRejectedValue(
        new UploadApiError(code),
      )
      await formReady()
      const file = makeFile('standup.mp3')
      choose(fileInput('Audio file'), file)
      fireEvent.click(screen.getByRole('button', { name: 'Upload' }))
      const alerts = await screen.findAllByRole('alert')
      expect(alerts.some((alert) => alert.textContent === message)).toBe(true)
      expect(screen.queryByRole('button', { name: 'Retry upload' })).toBeNull()
      expect(uploadsMock.uploadMeetingFile).not.toHaveBeenCalled()
      expect(statusRegion()).toHaveTextContent('')
      expect(fileInput('Audio file').files?.[0]).toBe(file)
    },
  )

  it('not_project_facilitator re-reads the members and reaches the denied state', async () => {
    setup()
    uploadsMock.createMeetingUpload.mockRejectedValue(
      new UploadApiError('not_project_facilitator'),
    )
    await formReady()
    choose(fileInput('Audio file'), makeFile('standup.mp3'))
    membersMock.fetchProjectMembers.mockResolvedValue(asFormerFacilitator)
    fireEvent.click(screen.getByRole('button', { name: 'Upload' }))
    expect(await screen.findByText(DENIED)).toBeInTheDocument()
    expect(membersMock.fetchProjectMembers).toHaveBeenCalledTimes(2)
  })

  it('not_project_member reaches the not-found state', async () => {
    setup()
    uploadsMock.createMeetingUpload.mockRejectedValue(
      new UploadApiError('not_project_member'),
    )
    await formReady()
    choose(fileInput('Audio file'), makeFile('standup.mp3'))
    fireEvent.click(screen.getByRole('button', { name: 'Upload' }))
    expect(await screen.findByText(NOT_FOUND)).toBeInTheDocument()
  })
})

describe('upload list', () => {
  it('shows the loading line, then the load error with a Retry that re-reads', async () => {
    mockRestoredSession('dev@example.com', 'user-1')
    profileMock.fetchProfileDisplayName.mockResolvedValue('Dev User')
    cyclesMock.fetchCycle.mockResolvedValue(cycle)
    membersMock.fetchProjectMembers.mockResolvedValue(asFacilitator)
    const first = deferred<CycleUploads>()
    uploadsMock.fetchCycleUploads.mockReturnValueOnce(first.promise)
    renderApp({ initialEntries: [PATH] })
    expect(await screen.findByText('Loading uploads…')).toBeInTheDocument()
    first.reject(new UploadApiError('unknown'))
    expect(
      await screen.findByText('Could not load the uploads.'),
    ).toBeInTheDocument()
    uploadsMock.fetchCycleUploads.mockResolvedValue(list(item()))
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }))
    expect(
      await screen.findByRole('heading', { level: 2, name: 'Uploads (1)' }),
    ).toBeInTheDocument()
    expect(uploadsMock.fetchCycleUploads).toHaveBeenCalledTimes(2)
  })

  it('lists every status, both rejected reasons, sizes, dates and long or HTML-like names as text, in server order', async () => {
    const statuses: UploadStatus[] = [
      'uploaded',
      'transcribing',
      'extracting',
      'draft_ready',
      'confirmed',
      'published',
      'failed',
    ]
    const longName = `${'x'.repeat(251)}.mp3`
    const uploads: MeetingUpload[] = [
      item({
        uploadId: 'b2000000-0000-4000-8000-000000000001',
        originalFilename: '<b>bold</b>.mp3',
        sizeBytes: 12.4 * 1024 * 1024,
        status: 'rejected',
        errorCode: 'upload_file_mismatch',
        uploadedAt: null,
      }),
      item({
        uploadId: 'b2000000-0000-4000-8000-000000000002',
        originalFilename: longName,
        status: 'rejected',
        errorCode: 'upload_abandoned',
        uploadedAt: null,
      }),
      ...statuses.map((status, index) =>
        item({
          uploadId: `b3000000-0000-4000-8000-00000000000${index}`,
          originalFilename: `${status}.mp3`,
          status,
          sizeBytes: 512,
        }),
      ),
      textItem({ textLength: 1234 }),
    ]
    setup({ uploads: list(...uploads) })
    expect(
      await screen.findByRole('heading', {
        level: 2,
        name: `Uploads (${uploads.length})`,
      }),
    ).toHaveAttribute('tabindex', '-1')
    const items = Array.from(
      document.querySelectorAll<HTMLElement>('li[data-upload-id]'),
    )
    expect(items.map((entry) => entry.getAttribute('data-upload-id'))).toEqual(
      uploads.map((upload) => upload.uploadId),
    )
    expect(items[0]).toHaveTextContent('<b>bold</b>.mp3')
    expect(items[0].querySelector('b')).toBeNull()
    expect(items[0]).toHaveTextContent('Audio recording · 12.4 MB')
    expect(items[0]).toHaveTextContent('Status: Rejected')
    expect(items[0]).toHaveTextContent(
      'The uploaded file did not match the file that was registered. Add it again as a new upload.',
    )
    expect(items[0]).toHaveTextContent('Added Nov 4, 2026')
    expect(items[1]).toHaveTextContent(
      'The file never arrived. Add it again as a new upload.',
    )
    const longText = within(items[1]).getByText(longName)
    expect(longText.className).toContain('[overflow-wrap:anywhere]')
    const labels = [
      'Uploaded',
      'Transcribing',
      'Extracting outcomes',
      'Ready for review',
      'Confirmed',
      'Published',
      'Failed',
    ]
    labels.forEach((label, index) => {
      expect(items[index + 2]).toHaveTextContent(`Status: ${label}`)
      expect(items[index + 2]).toHaveTextContent('512 bytes')
    })
    expect(items[items.length - 1]).toHaveTextContent('Pasted transcript text')
    expect(items[items.length - 1]).toHaveTextContent('1,234 characters')
    expect(screen.queryByText('Upload not finished.')).not.toBeInTheDocument()
  })

  it('a pending item offers Check again, which completes once and refreshes it to Uploaded', async () => {
    setup({
      uploads: list(item({ status: 'pending_upload', uploadedAt: null })),
    })
    const entry = (
      await screen.findByText('Status: Waiting for the file')
    ).closest('li') as HTMLElement
    expect(entry).toHaveTextContent('Upload not finished.')
    uploadsMock.completeMeetingUpload.mockResolvedValue(completed())
    uploadsMock.fetchCycleUploads.mockResolvedValue(list(item()))
    const check = within(entry).getByRole('button', { name: 'Check again' })
    fireEvent.click(check)
    fireEvent.click(check)
    expect(await screen.findByText('Status: Uploaded')).toBeInTheDocument()
    expect(uploadsMock.completeMeetingUpload).toHaveBeenCalledTimes(1)
    expect(uploadsMock.completeMeetingUpload).toHaveBeenCalledWith(UPLOAD_ID)
    expect(screen.queryByText('Upload not finished.')).not.toBeInTheDocument()
  })

  it('Check again on a missing file toasts the missing-file copy', async () => {
    const toastError = vi.spyOn(toast, 'error')
    setup({
      uploads: list(item({ status: 'pending_upload', uploadedAt: null })),
    })
    uploadsMock.completeMeetingUpload.mockRejectedValue(
      new UploadApiError('upload_file_missing'),
    )
    fireEvent.click(await screen.findByRole('button', { name: 'Check again' }))
    await waitFor(() => {
      expect(toastError).toHaveBeenCalledWith(
        'The file has not arrived. Add it again as a new upload.',
      )
    })
    expect(uploadsMock.completeMeetingUpload).toHaveBeenCalledTimes(1)
  })
})

describe('leaving during an upload', () => {
  it('still completes once, then announces nothing, moves no focus and logs nothing', async () => {
    const consoleError = vi.spyOn(console, 'error')
    const consoleWarn = vi.spyOn(console, 'warn')
    setup()
    const upload = deferred<undefined>()
    uploadsMock.createMeetingUpload.mockResolvedValue(created)
    uploadsMock.uploadMeetingFile.mockReturnValue(upload.promise)
    uploadsMock.completeMeetingUpload.mockResolvedValue(completed())
    await formReady()
    choose(fileInput('Audio file'), makeFile('standup.mp3'))
    fireEvent.click(screen.getByRole('button', { name: 'Upload' }))
    await waitFor(() => {
      expect(uploadsMock.uploadMeetingFile).toHaveBeenCalledTimes(1)
    })
    fireEvent.click(screen.getByRole('link', { name: 'Back to board' }))
    await waitFor(() => {
      expect(screen.getByTestId('location')).toHaveTextContent(
        `/cycles/${CYCLE_ID}/board`,
      )
    })
    const focused = document.activeElement
    upload.resolve(undefined)
    await waitFor(() => {
      expect(uploadsMock.completeMeetingUpload).toHaveBeenCalledTimes(1)
    })
    await flush()
    expect(document.activeElement).toBe(focused)
    expect(screen.queryByText('standup.mp3 uploaded.')).not.toBeInTheDocument()
    expect(consoleError).not.toHaveBeenCalled()
    expect(consoleWarn).not.toHaveBeenCalled()
  })
})
