import { describe, expect, it } from 'vitest'
import {
  ACTIVE_UPLOADS_LIMIT,
  FILE_NAME_MAX_LENGTH,
  MEDIA_MAX_BYTES,
  TOTAL_UPLOADS_LIMIT,
  TRANSCRIPT_FILE_MAX_BYTES,
  TRANSCRIPT_TEXT_MAX_LENGTH,
  UPLOAD_KINDS,
  UPLOAD_MAX_BYTES,
  UPLOAD_MIME_TYPES,
  UPLOAD_STATUSES,
  acceptFor,
  codePointLength,
  fileExtension,
  formatFileSize,
  mimeTypeFor,
  validateTranscriptText,
  validateUploadFile,
} from './uploadRules'

function file(name: string, size = 16) {
  return { name, size }
}

describe('upload rules (#28 decisions 3, 4 and 9)', () => {
  it('pins the kinds, statuses, table, limits and name length to the literal values', () => {
    expect(UPLOAD_KINDS).toEqual([
      'audio',
      'video',
      'transcript_file',
      'transcript_text',
    ])
    expect(UPLOAD_STATUSES).toEqual([
      'pending_upload',
      'uploaded',
      'transcribing',
      'extracting',
      'draft_ready',
      'confirmed',
      'published',
      'failed',
      'rejected',
    ])
    expect(UPLOAD_MIME_TYPES).toEqual({
      audio: {
        mp3: 'audio/mpeg',
        m4a: 'audio/mp4',
        wav: 'audio/wav',
        ogg: 'audio/ogg',
        webm: 'audio/webm',
      },
      video: { mp4: 'video/mp4', mov: 'video/quicktime', webm: 'video/webm' },
      transcript_file: {
        txt: 'text/plain',
        vtt: 'text/vtt',
        srt: 'application/x-subrip',
      },
    })
    expect(MEDIA_MAX_BYTES).toBe(209_715_200)
    expect(TRANSCRIPT_FILE_MAX_BYTES).toBe(10_485_760)
    expect(UPLOAD_MAX_BYTES).toEqual({
      audio: 209_715_200,
      video: 209_715_200,
      transcript_file: 10_485_760,
    })
    expect(TRANSCRIPT_TEXT_MAX_LENGTH).toBe(200_000)
    expect(ACTIVE_UPLOADS_LIMIT).toBe(20)
    expect(TOTAL_UPLOADS_LIMIT).toBe(50)
    expect(FILE_NAME_MAX_LENGTH).toBe(255)
    expect(acceptFor('audio')).toBe('.mp3,.m4a,.wav,.ogg,.webm')
    expect(acceptFor('video')).toBe('.mp4,.mov,.webm')
    expect(acceptFor('transcript_file')).toBe('.txt,.vtt,.srt')
  })

  it.each<[string, string | null]>([
    ['Talk.MP3', 'mp3'],
    ['talk.txt.mp3', 'mp3'],
    ['talk.txt.mp4', 'mp4'],
    ['.mp3', null],
    ['notes.', null],
    ['README', null],
    ['a..mp3', 'mp3'],
  ])('fileExtension(%j) is %j', (name, ext) => {
    expect(fileExtension(name)).toBe(ext)
  })

  it('accepts every allowed extension for its kind, in any case, with its canonical type', () => {
    for (const kind of ['audio', 'video', 'transcript_file'] as const) {
      for (const [ext, mime] of Object.entries(UPLOAD_MIME_TYPES[kind])) {
        expect(validateUploadFile(kind, file(`f.${ext}`))).toBeNull()
        expect(
          validateUploadFile(kind, file(`F.${ext.toUpperCase()}`)),
        ).toBeNull()
        expect(mimeTypeFor(kind, `f.${ext.toUpperCase()}`)).toBe(mime)
      }
    }
    expect(mimeTypeFor('audio', 'a.webm')).toBe('audio/webm')
    expect(mimeTypeFor('video', 'a.webm')).toBe('video/webm')
    // A browser reports '' for .srt; the type comes from the extension.
    expect(mimeTypeFor('transcript_file', 'captions.srt')).toBe(
      'application/x-subrip',
    )
  })

  it.each<[string, string, string]>([
    ['audio', 'standup.mp4', 'type'],
    ['video', 'standup.wav', 'type'],
    ['transcript_file', 'notes.pdf', 'type'],
    ['audio', '.mp3', 'type'],
    ['audio', 'notes.', 'type'],
    ['audio', 'README', 'type'],
    ['audio', 'a/b.mp3', 'name_characters'],
    ['audio', 'a\\b.mp3', 'name_characters'],
    ['audio', '../a.mp3', 'name_characters'],
    ['audio', 'a\u0000.mp3', 'name_characters'],
    ['audio', 'a\u0001.mp3', 'name_characters'],
    ['audio', 'a\u007f.mp3', 'name_characters'],
    ['audio', 'a\u0085.mp3', 'name_characters'],
    ['audio', 'a‮3pm.mp3', 'name_characters'],
    ['audio', 'a⁦.mp3', 'name_characters'],
    ['audio', `${'a'.repeat(252)}.mp3`, 'name_too_long'],
  ])('%s %j is refused as %s', (kind, name, problem) => {
    expect(
      validateUploadFile(
        kind as 'audio' | 'video' | 'transcript_file',
        file(name),
      ),
    ).toBe(problem)
  })

  it('accepts a 255-character name, talk.txt.mp3, and an HTML-like name', () => {
    expect(
      validateUploadFile('audio', file(`${'a'.repeat(251)}.mp3`)),
    ).toBeNull()
    expect(validateUploadFile('audio', file('talk.txt.mp3'))).toBeNull()
    expect(
      validateUploadFile('audio', file('<img src=x onerror=1>.mp3')),
    ).toBeNull()
  })

  it('checks sizes against the kind', () => {
    expect(validateUploadFile('audio', null)).toBe('missing')
    expect(validateUploadFile('audio', file('a.mp3', 0))).toBe('empty')
    expect(validateUploadFile('audio', file('a.mp3', 1))).toBeNull()
    expect(validateUploadFile('audio', file('a.mp3', 209_715_200))).toBeNull()
    expect(validateUploadFile('video', file('a.mp4', 209_715_201))).toBe(
      'too_large',
    )
    expect(
      validateUploadFile('transcript_file', file('a.txt', 10_485_760)),
    ).toBeNull()
    expect(
      validateUploadFile('transcript_file', file('a.txt', 10_485_761)),
    ).toBe('too_large')
  })

  it('validates pasted text in code points, so an emoji counts as one', () => {
    expect(validateTranscriptText('')).toBe('missing')
    expect(validateTranscriptText('  \n\t ')).toBe('missing')
    expect(codePointLength('😀')).toBe(1)
    expect(validateTranscriptText('😀'.repeat(200_000))).toBeNull()
    expect(validateTranscriptText('😀'.repeat(200_001))).toBe('too_long')
    expect(validateTranscriptText('a'.repeat(200_001))).toBe('too_long')
  })

  it.each<[number, string]>([
    [0, '0 bytes'],
    [512, '512 bytes'],
    [1024, '1.0 KB'],
    [980 * 1024, '980.0 KB'],
    [Math.round(12.4 * 1024 * 1024), '12.4 MB'],
    [209_715_200, '200.0 MB'],
  ])('formatFileSize(%i) is %s', (bytes, text) => {
    expect(formatFileSize(bytes)).toBe(text)
  })
})
