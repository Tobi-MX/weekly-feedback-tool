/**
 * The one transcript parser (#29, decisions 2-6). Pure and synchronous: no
 * I/O, no dependency, no regular expression with nested quantifiers. It
 * turns the bytes of a `.txt`, `.vtt` or `.srt` file, or pasted text, into
 * normalized text plus timestamped segments, or the first problem found.
 * The database re-validates every limit (`store_transcript`); this gives
 * fast feedback and the stored shape.
 */
import {
  TRANSCRIPT_MAX_MS,
  TRANSCRIPT_MAX_SEGMENTS,
  TRANSCRIPT_TEXT_MAX_LENGTH,
} from './uploadRules'

export interface TranscriptSegment {
  readonly start_ms: number
  readonly end_ms: number
  readonly text: string
}

export type TranscriptFormat = 'plain' | 'vtt' | 'srt'

/** The format to parse as: from the upload's MIME type, or `auto`. */
export type TranscriptParseFormat = 'auto' | 'vtt' | 'srt'

export interface ParsedTranscript {
  readonly format: TranscriptFormat
  readonly text: string
  readonly segments: readonly TranscriptSegment[]
}

export type TranscriptParseErrorCode =
  | 'bad_encoding'
  | 'not_text'
  | 'empty'
  | 'missing_header'
  | 'bad_timing_line'
  | 'bad_timestamp'
  | 'end_before_start'
  | 'out_of_order'
  | 'missing_blank_line'
  | 'no_cues'
  | 'too_long'
  | 'too_many_segments'

/** The first problem found; `line` is 1-based, or null when it has none. */
export interface TranscriptParseError {
  readonly code: TranscriptParseErrorCode
  readonly line: number | null
}

export function isTranscriptParseError(
  value: ParsedTranscript | TranscriptParseError | string,
): value is TranscriptParseError {
  return typeof value === 'object' && 'code' in value
}

function fail(
  code: TranscriptParseErrorCode,
  line: number | null = null,
): TranscriptParseError {
  return { code, line }
}

// ---------------------------------------------------------------------------
// Decoding (decision 3).
// ---------------------------------------------------------------------------

function decodeWith(
  label: 'utf-8' | 'utf-16le',
  bytes: Uint8Array,
): string | null {
  try {
    return new TextDecoder(label, { fatal: true, ignoreBOM: true }).decode(
      bytes,
    )
  } catch {
    return null
  }
}

/**
 * Decodes a transcript file. The byte order mark decides first (UTF-8,
 * UTF-16LE, UTF-16BE; a UTF-32 mark is refused) and is removed; without one
 * the bytes must be valid UTF-8. Text with U+0000 is not text.
 */
export function decodeTranscriptBytes(
  bytes: Uint8Array,
): string | TranscriptParseError {
  const b = bytes
  let text: string | null
  if (
    (b.length >= 4 &&
      b[0] === 0xff &&
      b[1] === 0xfe &&
      b[2] === 0x00 &&
      b[3] === 0x00) ||
    (b.length >= 4 &&
      b[0] === 0x00 &&
      b[1] === 0x00 &&
      b[2] === 0xfe &&
      b[3] === 0xff)
  ) {
    return fail('bad_encoding')
  } else if (b.length >= 3 && b[0] === 0xef && b[1] === 0xbb && b[2] === 0xbf) {
    text = decodeWith('utf-8', b.subarray(3))
  } else if (b.length >= 2 && b[0] === 0xff && b[1] === 0xfe) {
    text = decodeWith('utf-16le', b.subarray(2))
  } else if (b.length >= 2 && b[0] === 0xfe && b[1] === 0xff) {
    // Swap to little-endian so only the always-available decoders are used.
    const body = b.subarray(2)
    if (body.length % 2 !== 0) {
      return fail('bad_encoding')
    }
    const swapped = new Uint8Array(body.length)
    for (let i = 0; i < body.length; i += 2) {
      swapped[i] = body[i + 1]
      swapped[i + 1] = body[i]
    }
    text = decodeWith('utf-16le', swapped)
  } else {
    text = decodeWith('utf-8', b)
  }
  if (text === null) {
    return fail('bad_encoding')
  }
  if (text.includes('\u0000')) {
    return fail('not_text')
  }
  return text
}

// ---------------------------------------------------------------------------
// Lines and normalization (decision 4).
// ---------------------------------------------------------------------------

// C0 controls other than tab, LF and CR, and DEL. Line breaks are already
// gone when this runs.
// eslint-disable-next-line no-control-regex
const CONTROL_CHARACTERS = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g

// A character that is neither whitespace (\s) nor a removed control.
// eslint-disable-next-line no-control-regex
const HAS_CONTENT = /[^\s\u0000-\u0008\u000e-\u001f\u007f]/

/**
 * The lines of a text, read lazily so a limit stops the work early. CRLF,
 * LF and lone CR each end a line; control characters are removed. The next
 * CR and LF are found once and reused, so reading stays linear.
 */
class Lines {
  private readonly text: string
  private readonly read: string[] = []
  private pos = 0
  private nextCr = -2
  private nextLf = -2

  constructor(text: string) {
    this.text = text
  }

  /** Whether line `index` (0-based) exists. */
  has(index: number): boolean {
    while (this.read.length <= index && this.pos <= this.text.length) {
      this.readLine()
    }
    return index < this.read.length
  }

  /** Line `index`; call `has` first. */
  get(index: number): string {
    return this.has(index) ? this.read[index] : ''
  }

  private readLine(): void {
    const t = this.text
    if (this.nextCr !== -1 && this.nextCr < this.pos) {
      this.nextCr = t.indexOf('\r', this.pos)
    }
    if (this.nextLf !== -1 && this.nextLf < this.pos) {
      this.nextLf = t.indexOf('\n', this.pos)
    }
    let end = t.length
    if (this.nextCr !== -1) {
      end = this.nextCr
    }
    if (this.nextLf !== -1 && this.nextLf < end) {
      end = this.nextLf
    }
    this.read.push(t.slice(this.pos, end).replace(CONTROL_CHARACTERS, ''))
    if (end === t.length) {
      this.pos = t.length + 1
    } else {
      this.pos = end + (t[end] === '\r' && t[end + 1] === '\n' ? 2 : 1)
    }
  }
}

/** The index of the first non-blank line, or -1. */
function firstNonBlank(lines: Lines): number {
  for (let i = 0; lines.has(i); i += 1) {
    if (!isBlank(lines.get(i))) {
      return i
    }
  }
  return -1
}

function isBlank(line: string): boolean {
  return line.trim() === ''
}

/** Code points, like Postgres `char_length`, without copying the string. */
function codePoints(text: string): number {
  let n = 0
  for (let i = 0; i < text.length; i += 1) {
    const c = text.charCodeAt(i)
    if (c >= 0xd800 && c <= 0xdbff && i + 1 < text.length) {
      const d = text.charCodeAt(i + 1)
      if (d >= 0xdc00 && d <= 0xdfff) {
        i += 1
      }
    }
    n += 1
  }
  return n
}

/** Runs of whitespace become one space; the result is trimmed. */
function collapseWhitespace(text: string): string {
  return text.replace(/\s+/g, ' ').trim()
}

function isVttHeader(line: string): boolean {
  return (
    line === 'WEBVTT' ||
    line.startsWith('WEBVTT ') ||
    line.startsWith('WEBVTT\t')
  )
}

function isDigits(text: string): boolean {
  if (text === '') {
    return false
  }
  for (let i = 0; i < text.length; i += 1) {
    const c = text.charCodeAt(i)
    if (c < 48 || c > 57) {
      return false
    }
  }
  return true
}

/**
 * The format `auto` resolves to (decision 2), from the first non-blank
 * line: `WEBVTT` is VTT; digits followed by a line with `-->` is SRT;
 * anything else is plain text.
 */
export function resolveTranscriptFormat(
  text: string,
  format: TranscriptParseFormat,
): TranscriptFormat {
  if (format !== 'auto') {
    return format
  }
  const lines = new Lines(stripBom(text))
  const first = firstNonBlank(lines)
  if (first === -1) {
    return 'plain'
  }
  if (isVttHeader(lines.get(first))) {
    return 'vtt'
  }
  if (
    isDigits(lines.get(first).trim()) &&
    lines.has(first + 1) &&
    lines.get(first + 1).includes('-->')
  ) {
    return 'srt'
  }
  return 'plain'
}

function stripBom(text: string): string {
  return text.startsWith('\ufeff') ? text.slice(1) : text
}

// ---------------------------------------------------------------------------
// Plain text.
// ---------------------------------------------------------------------------

function parsePlain(lines: Lines): ParsedTranscript | TranscriptParseError {
  const kept: string[] = []
  let length = 0
  let pendingBlank = false
  for (let i = 0; lines.has(i); i += 1) {
    const line = lines.get(i).trimEnd()
    if (line === '') {
      // Leading blank lines are dropped; inner runs become one blank line.
      pendingBlank = kept.length > 0
      continue
    }
    if (pendingBlank) {
      kept.push('')
      length += 1
      pendingBlank = false
    }
    length += (kept.length > 0 ? 1 : 0) + codePoints(line)
    if (length > TRANSCRIPT_TEXT_MAX_LENGTH) {
      return fail('too_long')
    }
    kept.push(line)
  }
  return { format: 'plain', text: kept.join('\n'), segments: [] }
}

// ---------------------------------------------------------------------------
// Timestamps (decision 5).
// ---------------------------------------------------------------------------

/** Digits, colons, dots and commas only, with at least one digit. */
function looksLikeTimestamp(token: string): boolean {
  if (token === '') {
    return false
  }
  let digit = false
  for (let i = 0; i < token.length; i += 1) {
    const c = token[i]
    if (c >= '0' && c <= '9') {
      digit = true
    } else if (c !== ':' && c !== '.' && c !== ',') {
      return false
    }
  }
  return digit
}

/**
 * Milliseconds, or null when the timestamp breaks the rules: VTT takes
 * `mm:ss.ttt` or `h+:mm:ss.ttt`; SRT takes `h+:mm:ss,ttt` or `h+:mm:ss.ttt`.
 */
function parseTimestamp(token: string, format: 'vtt' | 'srt'): number | null {
  const parts = token.split(':')
  if (parts.length !== 2 && parts.length !== 3) {
    return null
  }
  if (format === 'srt' && parts.length !== 3) {
    return null
  }
  const last = parts[parts.length - 1]
  const separators = format === 'vtt' ? ['.'] : [',', '.']
  const sep = separators.find((s) => last.includes(s))
  if (sep === undefined) {
    return null
  }
  const [seconds, millis, ...rest] = last.split(sep)
  const hours = parts.length === 3 ? parts[0] : '0'
  const minutes = parts[parts.length - 2]
  if (
    rest.length > 0 ||
    !isDigits(hours) ||
    minutes.length !== 2 ||
    !isDigits(minutes) ||
    seconds.length !== 2 ||
    !isDigits(seconds) ||
    millis.length !== 3 ||
    !isDigits(millis)
  ) {
    return null
  }
  const m = Number(minutes)
  const s = Number(seconds)
  if (m > 59 || s > 59) {
    return null
  }
  // Long hour strings are compared without building a huge number.
  let firstDigit = 0
  while (firstDigit < hours.length - 1 && hours[firstDigit] === '0') {
    firstDigit += 1
  }
  const significant = hours.slice(firstDigit)
  const h =
    significant.length > 3 ? Number.POSITIVE_INFINITY : Number(significant)
  const ms = ((h * 60 + m) * 60 + s) * 1000 + Number(millis)
  return ms > TRANSCRIPT_MAX_MS ? null : ms
}

interface Timing {
  readonly start: number
  readonly end: number
}

function parseTimingLine(
  line: string,
  format: 'vtt' | 'srt',
  lineNumber: number,
): Timing | TranscriptParseError {
  const arrow = line.indexOf('-->')
  if (arrow === -1) {
    return fail('bad_timing_line', lineNumber)
  }
  const left = line.slice(0, arrow).trim()
  const right = line.slice(arrow + 3).trimStart()
  // Cue settings (VTT) and coordinates (SRT) after the end time are ignored.
  let cut = 0
  while (cut < right.length && right[cut] !== ' ' && right[cut] !== '\t') {
    cut += 1
  }
  const endToken = right.slice(0, cut)
  if (!looksLikeTimestamp(left) || !looksLikeTimestamp(endToken)) {
    return fail('bad_timing_line', lineNumber)
  }
  const start = parseTimestamp(left, format)
  const end = parseTimestamp(endToken, format)
  if (start === null || end === null) {
    return fail('bad_timestamp', lineNumber)
  }
  if (end < start) {
    return fail('end_before_start', lineNumber)
  }
  return { start, end }
}

// ---------------------------------------------------------------------------
// Markup (decision 5).
// ---------------------------------------------------------------------------

const VTT_TAGS = new Set(['c', 'i', 'b', 'u', 'lang', 'ruby', 'rt', 'v'])

const VTT_ENTITIES: ReadonlyArray<readonly [string, string]> = [
  ['&amp;', '&'],
  ['&lt;', '<'],
  ['&gt;', '>'],
  ['&quot;', '"'],
  ['&#39;', "'"],
  ['&nbsp;', '\u00a0'],
  ['&lrm;', '\u200e'],
  ['&rlm;', '\u200f'],
]

/** The tag name: everything up to a dot, space or tab. */
function tagName(content: string): string {
  let i = 0
  while (
    i < content.length &&
    content[i] !== '.' &&
    content[i] !== ' ' &&
    content[i] !== '\t'
  ) {
    i += 1
  }
  return content.slice(0, i)
}

/** The replacement for a VTT tag's content, or null to keep the `<`. */
function vttTag(content: string): string | null {
  if (content.startsWith('/')) {
    return VTT_TAGS.has(tagName(content.slice(1))) ? '' : null
  }
  const name = tagName(content)
  if (name === 'v') {
    const rest = content.slice(1)
    let space = 0
    while (space < rest.length && rest[space] !== ' ' && rest[space] !== '\t') {
      space += 1
    }
    const speaker = collapseWhitespace(rest.slice(space))
    return speaker === '' ? '' : `${speaker}: `
  }
  if (VTT_TAGS.has(name)) {
    return ''
  }
  if (looksLikeTimestamp(content) && parseTimestamp(content, 'vtt') !== null) {
    return ''
  }
  return null
}

const SRT_TAGS = new Set(['i', 'b', 'u', 'font'])

function srtTag(content: string): string | null {
  const closing = content.startsWith('/')
  const body = (closing ? content.slice(1) : content).toLowerCase()
  if (closing) {
    return SRT_TAGS.has(body.trim()) ? '' : null
  }
  let i = 0
  while (i < body.length && body[i] !== ' ' && body[i] !== '\t') {
    i += 1
  }
  const name = body.slice(0, i)
  if (name === 'font' || (SRT_TAGS.has(name) && i === body.length)) {
    return ''
  }
  return null
}

/**
 * Removes the format's tags from one cue line. The next `<`, `>` and `}` are
 * found once and reused, and kept text is copied in slices, so the scan
 * stays linear on long lines.
 */
function stripMarkup(line: string, format: 'vtt' | 'srt'): string {
  let out = ''
  // Kept text runs from `kept` to the current position.
  let kept = 0
  let nextLt = -2
  let nextGt = -2
  let nextBrace = -2
  let i = 0
  const replace = (end: number, replacement: string) => {
    out += line.slice(kept, i) + replacement
    i = end
    kept = end
  }
  while (i < line.length) {
    const c = line[i]
    if (c === '<') {
      if (nextGt !== -1 && nextGt < i) {
        nextGt = line.indexOf('>', i)
      }
      // With no `>` left, no `<` can start a tag.
      if (nextGt !== -1 && nextLt !== -1 && nextLt <= i) {
        nextLt = line.indexOf('<', i + 1)
      }
      // A tag ends at the next `>` and holds no other `<`.
      if (nextGt !== -1 && (nextLt === -1 || nextLt > nextGt)) {
        const content = line.slice(i + 1, nextGt)
        const replacement = format === 'vtt' ? vttTag(content) : srtTag(content)
        if (replacement !== null) {
          replace(nextGt + 1, replacement)
          continue
        }
      }
    } else if (c === '{' && format === 'srt' && line[i + 1] === '\\') {
      if (nextBrace !== -1 && nextBrace < i) {
        nextBrace = line.indexOf('}', i)
      }
      if (nextBrace !== -1) {
        replace(nextBrace + 1, '')
        continue
      }
    } else if (c === '&' && format === 'vtt') {
      const entity = VTT_ENTITIES.find(([name]) => line.startsWith(name, i))
      if (entity !== undefined) {
        replace(i + entity[0].length, entity[1])
        continue
      }
    }
    i += 1
  }
  return out + line.slice(kept)
}

// ---------------------------------------------------------------------------
// Cues (decisions 5 and 6).
// ---------------------------------------------------------------------------

/** Collects segments and enforces the limits as it goes. */
class SegmentBuilder {
  readonly segments: TranscriptSegment[] = []
  private length = 0
  private lastStart = -1

  /** Returns an error, or null when the cue was accepted. */
  add(
    timing: Timing,
    textLines: readonly string[],
    format: 'vtt' | 'srt',
    timingLine: number,
  ): TranscriptParseError | null {
    if (timing.start < this.lastStart) {
      return fail('out_of_order', timingLine)
    }
    this.lastStart = timing.start
    const text = collapseWhitespace(
      textLines.map((line) => stripMarkup(line, format)).join(' '),
    )
    if (text === '') {
      return null
    }
    if (this.segments.length >= TRANSCRIPT_MAX_SEGMENTS) {
      return fail('too_many_segments')
    }
    this.length += (this.segments.length > 0 ? 1 : 0) + codePoints(text)
    if (this.length > TRANSCRIPT_TEXT_MAX_LENGTH) {
      return fail('too_long')
    }
    this.segments.push({ start_ms: timing.start, end_ms: timing.end, text })
    return null
  }

  result(format: 'vtt' | 'srt'): ParsedTranscript | TranscriptParseError {
    if (this.segments.length === 0) {
      return fail('no_cues')
    }
    return {
      format,
      text: this.segments.map((segment) => segment.text).join('\n'),
      segments: this.segments,
    }
  }
}

/**
 * Reads one cue's text lines from `from` up to the next blank line. A line
 * with `-->` means a blank line is missing.
 */
function readCueText(
  lines: Lines,
  from: number,
): { readonly text: string[]; readonly next: number } | TranscriptParseError {
  const text: string[] = []
  let i = from
  while (lines.has(i) && !isBlank(lines.get(i))) {
    if (lines.get(i).includes('-->')) {
      return fail('missing_blank_line', i + 1)
    }
    text.push(lines.get(i))
    i += 1
  }
  return { text, next: i }
}

function isVttBlock(line: string, keyword: string): boolean {
  return (
    line === keyword ||
    line.startsWith(`${keyword} `) ||
    line.startsWith(`${keyword}\t`)
  )
}

function parseVtt(
  lines: Lines,
  start: number,
): ParsedTranscript | TranscriptParseError {
  if (!lines.has(start) || !isVttHeader(lines.get(start))) {
    return fail('missing_header', start + 1)
  }
  let i = start + 1
  // Header lines up to the first blank line are ignored.
  while (lines.has(i) && !isBlank(lines.get(i))) {
    i += 1
  }
  const builder = new SegmentBuilder()
  while (lines.has(i)) {
    if (isBlank(lines.get(i))) {
      i += 1
      continue
    }
    const first = lines.get(i)
    if (!first.includes('-->')) {
      if (
        isVttBlock(first, 'NOTE') ||
        isVttBlock(first, 'STYLE') ||
        isVttBlock(first, 'REGION')
      ) {
        while (lines.has(i) && !isBlank(lines.get(i))) {
          i += 1
        }
        continue
      }
      // A cue identifier; the timing line must follow. A block with no
      // second line has no timing line at all: report its first line.
      i += 1
      if (!lines.has(i) || isBlank(lines.get(i))) {
        return fail('bad_timing_line', i)
      }
    }
    const timingLine = i + 1
    const timing = parseTimingLine(lines.get(i), 'vtt', timingLine)
    if ('code' in timing) {
      return timing
    }
    const cue = readCueText(lines, i + 1)
    if ('code' in cue) {
      return cue
    }
    const problem = builder.add(timing, cue.text, 'vtt', timingLine)
    if (problem !== null) {
      return problem
    }
    i = cue.next
  }
  return builder.result('vtt')
}

function parseSrt(lines: Lines): ParsedTranscript | TranscriptParseError {
  const builder = new SegmentBuilder()
  let i = 0
  while (lines.has(i)) {
    if (isBlank(lines.get(i))) {
      i += 1
      continue
    }
    if (!lines.get(i).includes('-->')) {
      if (!isDigits(lines.get(i).trim())) {
        return fail('bad_timing_line', i + 1)
      }
      // The index line; gaps and duplicates are fine.
      i += 1
      if (!lines.has(i) || isBlank(lines.get(i))) {
        return fail('bad_timing_line', i)
      }
    }
    const timingLine = i + 1
    const timing = parseTimingLine(lines.get(i), 'srt', timingLine)
    if ('code' in timing) {
      return timing
    }
    const cue = readCueText(lines, i + 1)
    if ('code' in cue) {
      return cue
    }
    const problem = builder.add(timing, cue.text, 'srt', timingLine)
    if (problem !== null) {
      return problem
    }
    i = cue.next
  }
  return builder.result('srt')
}

/**
 * Parses decoded text or pasted text. Deterministic: the same input always
 * gives a deep-equal result. Only the first problem is reported.
 */
export function parseTranscript(
  input: string,
  format: TranscriptParseFormat,
): ParsedTranscript | TranscriptParseError {
  const text = stripBom(input)
  if (text.includes('\u0000')) {
    return fail('not_text')
  }
  if (!HAS_CONTENT.test(text)) {
    return fail('empty')
  }
  const lines = new Lines(text)
  const first = firstNonBlank(lines)
  const resolved = resolveTranscriptFormat(text, format)
  switch (resolved) {
    case 'plain':
      return parsePlain(lines)
    case 'vtt':
      // An explicit VTT file starts at line 1; auto found the header at the
      // first non-blank line.
      return parseVtt(lines, format === 'auto' ? first : 0)
    case 'srt':
      return parseSrt(lines)
  }
}
