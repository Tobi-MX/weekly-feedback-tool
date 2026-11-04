import { describe, expect, it } from 'vitest'
import {
  UPLOAD_ERROR_MESSAGES,
  UploadApiError,
  toUploadErrorCode,
  uploadErrorCodeOf,
  uploadErrorMessage,
} from './uploadErrors'

describe('upload error copy (#28)', () => {
  it('has exactly the copy of the table for every code', () => {
    expect(UPLOAD_ERROR_MESSAGES).toEqual({
      not_project_member: null,
      not_project_facilitator:
        'Only the facilitator can upload the meeting record.',
      cycle_not_discussing:
        'The meeting record can be uploaded once the retrospective reaches the Discuss stage.',
      invalid_upload_kind: 'Choose what you are adding.',
      invalid_upload_file: 'This file type or name is not accepted.',
      upload_too_large:
        'The file is too large. Audio and video can be up to 200 MB, transcript files up to 10 MB.',
      invalid_transcript_text:
        'Paste between 1 and 200,000 characters of transcript text.',
      upload_limit_reached: 'This retrospective has reached its upload limit.',
      upload_not_found: 'This upload no longer exists.',
      upload_file_missing: 'The file has not arrived. Try the upload again.',
      upload_failed:
        'The file could not be uploaded. Check your connection and try again.',
      unknown: 'Something went wrong. Try again.',
    })
  })

  it('maps an unknown or missing code to unknown', () => {
    expect(toUploadErrorCode('upload_limit_reached')).toBe(
      'upload_limit_reached',
    )
    expect(toUploadErrorCode('permission denied for function x')).toBe(
      'unknown',
    )
    expect(toUploadErrorCode(null)).toBe('unknown')
    expect(toUploadErrorCode(undefined)).toBe('unknown')
    expect(uploadErrorCodeOf(new Error('upload_failed'))).toBe('unknown')
    expect(uploadErrorCodeOf(new UploadApiError('upload_failed'))).toBe(
      'upload_failed',
    )
    expect(uploadErrorMessage('unknown')).toBe(
      'Something went wrong. Try again.',
    )
  })
})
