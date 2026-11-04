import { describe, expect, it } from 'vitest'
import type { TranscriptParseErrorCode } from './transcriptParser'
import {
  TRANSCRIPT_PARSE_MESSAGES,
  TRANSCRIPT_REJECTED_REASONS,
  UPLOAD_ERROR_MESSAGES,
  UploadApiError,
  toUploadErrorCode,
  transcriptParseMessage,
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
      // #29.
      upload_not_transcript: 'This upload is not a transcript.',
      upload_not_ready: 'This upload cannot be read now.',
      transcript_already_stored:
        'A different transcript is already stored for this upload.',
      invalid_transcript:
        'The transcript could not be saved. Add it again as a new upload.',
      invalid_reject_reason: 'Something went wrong. Try again.',
      transcript_download_failed:
        'The transcript file could not be downloaded. Check your connection and try again.',
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

describe('transcript copy (#29)', () => {
  it('maps every new server code and the client download code', () => {
    for (const code of [
      'upload_not_transcript',
      'upload_not_ready',
      'transcript_already_stored',
      'invalid_transcript',
      'invalid_reject_reason',
      'transcript_download_failed',
    ] as const) {
      expect(toUploadErrorCode(code)).toBe(code)
    }
    expect(uploadErrorMessage('invalid_reject_reason')).toBe(
      uploadErrorMessage('unknown'),
    )
    expect(toUploadErrorCode('transcript_immutable')).toBe('unknown')
  })

  it('has exactly the parse copy of the table', () => {
    expect(TRANSCRIPT_PARSE_MESSAGES).toEqual({
      bad_encoding:
        'The file is not UTF-8 or UTF-16 text. Save it as UTF-8 and add it again.',
      not_text: 'This does not look like a text file.',
      empty: 'The transcript is empty.',
      missing_header: 'A VTT file must start with WEBVTT.',
      bad_timing_line:
        'expected a timing line like 00:01:02.500 --> 00:01:05.000.',
      bad_timestamp: 'a timestamp is not valid.',
      end_before_start: 'the cue ends before it starts.',
      out_of_order: 'the cue starts before the previous cue.',
      missing_blank_line: 'a blank line is missing before this cue.',
      no_cues: 'The file has no cues with text.',
      too_long: 'The transcript is longer than 200,000 characters.',
      too_many_segments: 'The transcript has more than 20,000 cues.',
    })
  })

  it.each<
    [TranscriptParseErrorCode, number | null, 'plain' | 'vtt' | 'srt', string]
  >([
    ['end_before_start', 4, 'vtt', 'Line 4: the cue ends before it starts.'],
    [
      'bad_timing_line',
      7,
      'vtt',
      'Line 7: expected a timing line like 00:01:02.500 --> 00:01:05.000.',
    ],
    [
      'bad_timing_line',
      7,
      'srt',
      'Line 7: expected a timing line like 00:01:02,500 --> 00:01:05,000.',
    ],
    ['missing_header', 1, 'vtt', 'Line 1: A VTT file must start with WEBVTT.'],
    ['bad_timestamp', 12, 'srt', 'Line 12: a timestamp is not valid.'],
    [
      'out_of_order',
      9,
      'vtt',
      'Line 9: the cue starts before the previous cue.',
    ],
    [
      'missing_blank_line',
      5,
      'srt',
      'Line 5: a blank line is missing before this cue.',
    ],
    [
      'bad_encoding',
      null,
      'plain',
      'The file is not UTF-8 or UTF-16 text. Save it as UTF-8 and add it again.',
    ],
    ['empty', null, 'vtt', 'The transcript is empty.'],
  ])('%s on line %s (%s) reads %j', (code, line, format, copy) => {
    expect(transcriptParseMessage({ code, line }, format)).toBe(copy)
  })

  it('has exactly the rejected-reason copy of the table', () => {
    expect(TRANSCRIPT_REJECTED_REASONS).toEqual({
      transcript_bad_encoding:
        'The file is not UTF-8 or UTF-16 text. Save it as UTF-8 and add it again as a new upload.',
      transcript_not_text:
        'The file is not a text file. Add the right file as a new upload.',
      transcript_empty:
        'The file is empty. Add the right file as a new upload.',
      transcript_malformed:
        "The file's cues or timestamps are not valid. Fix the file and add it again as a new upload.",
      transcript_no_cues:
        'The file has no cues with text. Add the right file as a new upload.',
      transcript_too_long: 'The transcript is longer than 200,000 characters.',
      transcript_too_many_segments: 'The transcript has more than 20,000 cues.',
    })
  })
})
