import { afterEach, describe, expect, it, vi } from 'vitest'
import parserSource from './transcriptParser.ts?raw'
import {
  ALL_FIXTURES,
  PLAIN_FIXTURES,
  SRT_FIXTURES,
  VTT_FIXTURES,
} from './transcriptFixtures'
import {
  decodeTranscriptBytes,
  isTranscriptParseError,
  parseTranscript,
  resolveTranscriptFormat,
  type ParsedTranscript,
} from './transcriptParser'

const MIB = 1024 * 1024

function bytes(...values: number[]): Uint8Array {
  return new Uint8Array(values)
}

function utf8(text: string): Uint8Array {
  return new TextEncoder().encode(text)
}

function utf16le(text: string): Uint8Array {
  const out = new Uint8Array(text.length * 2)
  for (let i = 0; i < text.length; i += 1) {
    const c = text.charCodeAt(i)
    out[i * 2] = c & 0xff
    out[i * 2 + 1] = c >> 8
  }
  return out
}

function utf16be(text: string): Uint8Array {
  const le = utf16le(text)
  const out = new Uint8Array(le.length)
  for (let i = 0; i < le.length; i += 2) {
    out[i] = le[i + 1]
    out[i + 1] = le[i]
  }
  return out
}

function concat(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, part) => n + part.length, 0))
  let offset = 0
  for (const part of parts) {
    out.set(part, offset)
    offset += part.length
  }
  return out
}

function parsed(result: ReturnType<typeof parseTranscript>): ParsedTranscript {
  if (isTranscriptParseError(result)) {
    throw new Error(`expected a transcript, got ${result.code}`)
  }
  return result
}

/** n VTT cues, one second apart, each with the given text. */
function vttCues(n: number, text: string): string {
  const parts = ['WEBVTT', '']
  for (let i = 0; i < n; i += 1) {
    parts.push(`${ms(i * 1000, '.')} --> ${ms(i * 1000 + 500, '.')}`, text, '')
  }
  return parts.join('\n')
}

function srtCues(n: number, text: string): string {
  const parts: string[] = []
  for (let i = 0; i < n; i += 1) {
    parts.push(
      String(i + 1),
      `${ms(i * 1000, ',')} --> ${ms(i * 1000 + 500, ',')}`,
      text,
      '',
    )
  }
  return parts.join('\n')
}

function ms(value: number, separator: string): string {
  const h = Math.floor(value / 3_600_000)
  const m = Math.floor(value / 60_000) % 60
  const s = Math.floor(value / 1000) % 60
  const t = value % 1000
  const two = (n: number) => String(n).padStart(2, '0')
  return `${two(h)}:${two(m)}:${two(s)}${separator}${String(t).padStart(3, '0')}`
}

afterEach(() => {
  vi.restoreAllMocks()
})

describe('decodeTranscriptBytes', () => {
  it('decodes UTF-8 without a byte order mark', () => {
    expect(decodeTranscriptBytes(utf8('Hi 😀 é'))).toBe('Hi 😀 é')
  })

  it('removes a UTF-8 byte order mark', () => {
    expect(
      decodeTranscriptBytes(concat(bytes(0xef, 0xbb, 0xbf), utf8('Hi'))),
    ).toBe('Hi')
  })

  it('decodes UTF-16LE with a mark and removes it', () => {
    expect(
      decodeTranscriptBytes(concat(bytes(0xff, 0xfe), utf16le('Hi 😀\r\n'))),
    ).toBe('Hi 😀\r\n')
  })

  it('decodes UTF-16BE with a mark and removes it', () => {
    expect(
      decodeTranscriptBytes(concat(bytes(0xfe, 0xff), utf16be('Hi 😀'))),
    ).toBe('Hi 😀')
  })

  it('treats UTF-16 without a mark as not text (it decodes to NULs)', () => {
    expect(decodeTranscriptBytes(utf16le('Hello'))).toEqual({
      code: 'not_text',
      line: null,
    })
  })

  it.each<[string, Uint8Array]>([
    ['the UTF-32LE mark', bytes(0xff, 0xfe, 0x00, 0x00, 0x48, 0, 0, 0)],
    ['the UTF-32BE mark', bytes(0x00, 0x00, 0xfe, 0xff, 0, 0, 0, 0x48)],
    ['a Windows-1252 0x93', concat(utf8('He said '), bytes(0x93), utf8('hi'))],
    ['a Latin-1 é', bytes(0x63, 0x61, 0x66, 0xe9)],
    ['a truncated UTF-8 sequence', concat(utf8('a'), bytes(0xe2, 0x82))],
    ['an odd-length UTF-16LE body', bytes(0xff, 0xfe, 0x48, 0x00, 0x69)],
    ['an odd-length UTF-16BE body', bytes(0xfe, 0xff, 0x00, 0x48, 0x00)],
  ])('refuses %s as bad_encoding', (_label, input) => {
    expect(decodeTranscriptBytes(input)).toEqual({
      code: 'bad_encoding',
      line: null,
    })
  })

  it('refuses a NUL byte as not_text', () => {
    expect(
      decodeTranscriptBytes(concat(utf8('a'), bytes(0), utf8('b'))),
    ).toEqual({ code: 'not_text', line: null })
  })

  it('gives empty for a file of only a byte order mark and whitespace', () => {
    const text = decodeTranscriptBytes(
      concat(bytes(0xef, 0xbb, 0xbf), utf8(' \r\n\t ')),
    )
    expect(text).toBe(' \r\n\t ')
    expect(parseTranscript(text as string, 'auto')).toEqual({
      code: 'empty',
      line: null,
    })
  })

  it('applies no Unicode normalization and counts by code point', () => {
    const decomposed = 'e\u0301'
    const text = decodeTranscriptBytes(utf8(decomposed))
    expect(text).toBe(decomposed)
    const result = parsed(parseTranscript('😀'.repeat(200_000), 'auto'))
    expect(result.text).toHaveLength(400_000)
    expect(parseTranscript('😀'.repeat(200_001), 'auto')).toEqual({
      code: 'too_long',
      line: null,
    })
    expect(
      parsed(parseTranscript(decomposed.repeat(100_000), 'auto')).text,
    ).toBe(decomposed.repeat(100_000))
    expect(parseTranscript(decomposed.repeat(100_001), 'auto')).toEqual({
      code: 'too_long',
      line: null,
    })
  })
})

describe('format detection', () => {
  it.each<[string, string]>([
    ['WEBVTT', 'vtt'],
    ['WEBVTT - x\n\n00:01.000 --> 00:02.000\nHi', 'vtt'],
    ['\ufeffWEBVTT\n', 'vtt'],
    ['1\n00:00:01,000 --> 00:00:02,000\nHi', 'srt'],
    ['WEBVTTX', 'plain'],
    ['42', 'plain'],
    ['Notes\n00:00:01,000 --> 00:00:02,000', 'plain'],
    ['', 'plain'],
  ])('auto reads %j as %s', (text, format) => {
    expect(resolveTranscriptFormat(text, 'auto')).toBe(format)
  })

  it('never treats a .vtt or .srt file as plain text', () => {
    expect(resolveTranscriptFormat('Just words', 'vtt')).toBe('vtt')
    expect(resolveTranscriptFormat('Just words', 'srt')).toBe('srt')
    expect(parseTranscript('Just words', 'vtt')).toEqual({
      code: 'missing_header',
      line: 1,
    })
    expect(parseTranscript('Just words', 'srt')).toEqual({
      code: 'bad_timing_line',
      line: 1,
    })
  })
})

describe.each([
  ['VTT', VTT_FIXTURES],
  ['SRT', SRT_FIXTURES],
  ['plain and auto', PLAIN_FIXTURES],
])('%s fixtures', (_group, fixtures) => {
  it.each(fixtures.map((fixture) => [fixture.name, fixture] as const))(
    '%s',
    (_name, fixture) => {
      expect(parseTranscript(fixture.input, fixture.format)).toEqual(
        fixture.expected,
      )
    },
  )
})

describe('rules over every fixture', () => {
  it('keeps the join rule: text is the segment texts joined with \\n', () => {
    for (const fixture of ALL_FIXTURES) {
      const result = parseTranscript(fixture.input, fixture.format)
      if (!isTranscriptParseError(result) && result.format !== 'plain') {
        expect(result.text).toBe(
          result.segments.map((segment) => segment.text).join('\n'),
        )
        for (const segment of result.segments) {
          expect(segment.text).not.toMatch(/[\r\n]/)
          expect(segment.text.trim()).toBe(segment.text)
          expect(segment.text).not.toBe('')
        }
      }
    }
  })

  it('is deterministic: parsing twice gives deep-equal results', () => {
    for (const fixture of ALL_FIXTURES) {
      expect(parseTranscript(fixture.input, fixture.format)).toEqual(
        parseTranscript(fixture.input, fixture.format),
      )
    }
  })

  it('gives plain text no segments', () => {
    for (const fixture of PLAIN_FIXTURES) {
      const result = parseTranscript(fixture.input, fixture.format)
      if (!isTranscriptParseError(result) && result.format === 'plain') {
        expect(result.segments).toEqual([])
      }
    }
  })
})

describe('limits', () => {
  it('accepts exactly 200,000 characters and refuses 200,001', () => {
    expect(
      parsed(parseTranscript('a'.repeat(200_000), 'auto')).text,
    ).toHaveLength(200_000)
    expect(parseTranscript('a'.repeat(200_001), 'auto')).toEqual({
      code: 'too_long',
      line: null,
    })
    // Line breaks count too.
    const lines = `${'a'.repeat(99_999)}\n${'b'.repeat(100_000)}`
    expect(parsed(parseTranscript(lines, 'auto')).text).toHaveLength(200_000)
    expect(parseTranscript(`${lines}b`, 'auto')).toEqual({
      code: 'too_long',
      line: null,
    })
  })

  it('accepts a VTT whose joined text is exactly 200,000 characters', () => {
    const input = `WEBVTT\n\n00:01.000 --> 00:02.000\n${'a'.repeat(100_000)}\n\n00:02.000 --> 00:03.000\n${'b'.repeat(99_999)}\n`
    expect(parsed(parseTranscript(input, 'vtt')).text).toHaveLength(200_000)
    expect(parseTranscript(`${input.trimEnd()}b\n`, 'vtt')).toEqual({
      code: 'too_long',
      line: null,
    })
  })

  it('accepts exactly 20,000 cues within 200,000 characters and refuses 20,001', () => {
    const result = parsed(parseTranscript(vttCues(20_000, 'abcdefghi'), 'vtt'))
    expect(result.segments).toHaveLength(20_000)
    expect(result.text).toHaveLength(199_999)
    expect(parseTranscript(vttCues(20_001, 'a'), 'vtt')).toEqual({
      code: 'too_many_segments',
      line: null,
    })
    expect(
      parsed(parseTranscript(srtCues(20_000, 'a'), 'srt')).segments,
    ).toHaveLength(20_000)
    expect(parseTranscript(srtCues(20_001, 'a'), 'srt')).toEqual({
      code: 'too_many_segments',
      line: null,
    })
  })

  // Equal starts and duplicate indexes are allowed, so one cue repeats.
  const tenMib: ReadonlyArray<
    readonly [string, () => string, 'auto' | 'vtt' | 'srt', string]
  > = [
    [
      'plain text',
      () => `${'word '.repeat(19)}\n`.repeat(Math.ceil((10 * MIB) / 96)),
      'auto',
      'too_long',
    ],
    [
      'VTT',
      () =>
        `WEBVTT\n\n${'00:00:01.000 --> 00:00:01.500\na\n\n'.repeat(Math.ceil((10 * MIB) / 33))}`,
      'vtt',
      'too_many_segments',
    ],
    [
      'SRT',
      () =>
        '1\n00:00:01,000 --> 00:00:01,500\na\n\n'.repeat(
          Math.ceil((10 * MIB) / 35),
        ),
      'srt',
      'too_many_segments',
    ],
    [
      // One 10 MiB line of `<` must not rescan the line for every `<`.
      'VTT with one 10 MiB line of <',
      () => `WEBVTT\n\n00:01.000 --> 00:02.000\n${'<'.repeat(10 * MIB)}\n`,
      'vtt',
      'too_long',
    ],
  ]

  it.each(tenMib)(
    'stops at the limit on a 10 MiB %s file',
    (_label, build, format, code) => {
      const input = build()
      expect(input.length).toBeGreaterThanOrEqual(10 * MIB)
      const decoded = decodeTranscriptBytes(utf8(input))
      expect(typeof decoded).toBe('string')
      expect(parseTranscript(decoded as string, format)).toEqual({
        code,
        line: null,
      })
    },
  )
})

describe('module rules', () => {
  it('imports nothing but uploadRules.ts', () => {
    const imports = [...parserSource.matchAll(/from '([^']+)'/g)].map(
      (match) => match[1],
    )
    expect(imports).toEqual(['./uploadRules'])
  })

  it('calls no console method', () => {
    const spies = (['log', 'info', 'warn', 'error', 'debug'] as const).map(
      (method) => vi.spyOn(console, method),
    )
    for (const fixture of ALL_FIXTURES) {
      parseTranscript(fixture.input, fixture.format)
    }
    decodeTranscriptBytes(bytes(0x93))
    for (const spy of spies) {
      expect(spy).not.toHaveBeenCalled()
    }
    expect(parserSource).not.toMatch(/console\./)
  })
})
