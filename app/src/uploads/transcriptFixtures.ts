import type {
  ParsedTranscript,
  TranscriptParseError,
  TranscriptParseFormat,
} from './transcriptParser'

/**
 * Parser fixtures (#29): each is one input, the format it is parsed as, and
 * the exact result. `transcriptParser.test.ts` checks every fixture for its
 * result, the join rule, and determinism. To add a case, append an entry;
 * nothing else needs to change. Byte-level cases (encodings, byte order
 * marks) live in the test file, because they start from bytes.
 */
export interface TranscriptFixture {
  readonly name: string
  readonly input: string
  readonly format: TranscriptParseFormat
  readonly expected: ParsedTranscript | TranscriptParseError
}

function seg(start_ms: number, end_ms: number, text: string) {
  return { start_ms, end_ms, text }
}

function cues(
  format: 'vtt' | 'srt',
  ...segments: ReturnType<typeof seg>[]
): ParsedTranscript {
  return {
    format,
    text: segments.map((s) => s.text).join('\n'),
    segments,
  }
}

function error(
  code: TranscriptParseError['code'],
  line: number | null = null,
): TranscriptParseError {
  return { code, line }
}

export const VTT_FIXTURES: readonly TranscriptFixture[] = [
  {
    name: 'two cues, one with two text lines',
    format: 'vtt',
    input:
      'WEBVTT\n\n00:00:01.000 --> 00:00:02.500\nHello there\n\n00:00:03.000 --> 00:00:04.000\nSecond line\ncontinues\n',
    expected: cues(
      'vtt',
      seg(1000, 2500, 'Hello there'),
      seg(3000, 4000, 'Second line continues'),
    ),
  },
  {
    name: 'WEBVTT - Title with header metadata lines',
    format: 'vtt',
    input:
      'WEBVTT - Weekly standup\nKind: captions\nLanguage: en\n\n00:01.000 --> 00:02.000\nHi\n',
    expected: cues('vtt', seg(1000, 2000, 'Hi')),
  },
  {
    name: 'WEBVTT followed by a tab',
    format: 'vtt',
    input: 'WEBVTT\tx\n\n00:01.000 --> 00:02.000\nHi\n',
    expected: cues('vtt', seg(1000, 2000, 'Hi')),
  },
  {
    name: 'missing WEBVTT',
    format: 'vtt',
    input: '00:00:01.000 --> 00:00:02.000\nHi\n',
    expected: error('missing_header', 1),
  },
  {
    name: 'WEBVTTX is not a header',
    format: 'vtt',
    input: 'WEBVTTX\n\n00:00:01.000 --> 00:00:02.000\nHi\n',
    expected: error('missing_header', 1),
  },
  {
    name: 'a blank first line is not a header',
    format: 'vtt',
    input: '\nWEBVTT\n\n00:00:01.000 --> 00:00:02.000\nHi\n',
    expected: error('missing_header', 1),
  },
  {
    name: 'NOTE (single and multi-line), STYLE and REGION blocks are skipped',
    format: 'vtt',
    input: [
      'WEBVTT',
      '',
      'NOTE a single line',
      '',
      'NOTE',
      'a note over',
      'two lines',
      '',
      'STYLE',
      '::cue { color: red }',
      '',
      'REGION',
      'id:fred width:40%',
      '',
      '00:00:01.000 --> 00:00:02.000',
      'Hi',
    ].join('\n'),
    expected: cues('vtt', seg(1000, 2000, 'Hi')),
  },
  {
    name: 'numeric and text cue identifiers',
    format: 'vtt',
    input:
      'WEBVTT\n\n1\n00:00:01.000 --> 00:00:02.000\nOne\n\nintro-2\n00:00:03.000 --> 00:00:04.000\nTwo\n',
    expected: cues('vtt', seg(1000, 2000, 'One'), seg(3000, 4000, 'Two')),
  },
  {
    name: 'cue settings after the end time are ignored',
    format: 'vtt',
    input:
      'WEBVTT\n\n00:00:01.000 --> 00:00:02.000 align:start position:10% line:0\nHi\n',
    expected: cues('vtt', seg(1000, 2000, 'Hi')),
  },
  {
    name: 'hour-less 01:02.500',
    format: 'vtt',
    input: 'WEBVTT\n\n01:02.500 --> 01:03.000\nHi\n',
    expected: cues('vtt', seg(62500, 63000, 'Hi')),
  },
  {
    name: 'many-digit hours',
    format: 'vtt',
    input: 'WEBVTT\n\n0001:00:00.000 --> 0001:00:01.000\nHi\n',
    expected: cues('vtt', seg(3600000, 3601000, 'Hi')),
  },
  {
    name: '1:02.500 (one-digit minutes)',
    format: 'vtt',
    input: 'WEBVTT\n\n1:02.500 --> 1:03.000\nHi\n',
    expected: error('bad_timestamp', 3),
  },
  {
    name: '00:60.000 (60 seconds)',
    format: 'vtt',
    input: 'WEBVTT\n\n00:59.000 --> 00:60.000\nHi\n',
    expected: error('bad_timestamp', 3),
  },
  {
    name: '60 minutes',
    format: 'vtt',
    input: 'WEBVTT\n\n00:60:00.000 --> 01:00:00.000\nHi\n',
    expected: error('bad_timestamp', 3),
  },
  {
    name: 'a comma separator',
    format: 'vtt',
    input: 'WEBVTT\n\n00:00:01,000 --> 00:00:02,000\nHi\n',
    expected: error('bad_timestamp', 3),
  },
  {
    name: 'two-digit milliseconds',
    format: 'vtt',
    input: 'WEBVTT\n\n00:00:01.00 --> 00:00:02.000\nHi\n',
    expected: error('bad_timestamp', 3),
  },
  {
    name: 'no arrow',
    format: 'vtt',
    input: 'WEBVTT\n\n00:00:01.000 00:00:02.000\n\n',
    expected: error('bad_timing_line', 3),
  },
  {
    name: 'an identifier followed by a line with no arrow',
    format: 'vtt',
    input: 'WEBVTT\n\nintro\n00:00:01.000 00:00:02.000\nHi\n',
    expected: error('bad_timing_line', 4),
  },
  {
    name: 'words around the arrow',
    format: 'vtt',
    input: 'WEBVTT\n\nstart --> end\nHi\n',
    expected: error('bad_timing_line', 3),
  },
  {
    name: '--> without spaces',
    format: 'vtt',
    input: 'WEBVTT\n\n00:00:01.000-->00:00:02.000\nHi\n',
    expected: cues('vtt', seg(1000, 2000, 'Hi')),
  },
  {
    name: 'exactly 24 hours',
    format: 'vtt',
    input: 'WEBVTT\n\n23:59:59.000 --> 24:00:00.000\nHi\n',
    expected: cues('vtt', seg(86399000, 86400000, 'Hi')),
  },
  {
    name: 'over 24 hours',
    format: 'vtt',
    input: 'WEBVTT\n\n23:59:59.000 --> 24:00:00.001\nHi\n',
    expected: error('bad_timestamp', 3),
  },
  {
    name: 'end before start',
    format: 'vtt',
    input: 'WEBVTT\n\n00:00:02.000 --> 00:00:01.000\nHi\n',
    expected: error('end_before_start', 3),
  },
  {
    name: 'end equal to start',
    format: 'vtt',
    input: 'WEBVTT\n\n00:00:02.000 --> 00:00:02.000\nHi\n',
    expected: cues('vtt', seg(2000, 2000, 'Hi')),
  },
  {
    name: 'out-of-order cues',
    format: 'vtt',
    input:
      'WEBVTT\n\n00:00:05.000 --> 00:00:06.000\nB\n\n00:00:01.000 --> 00:00:02.000\nA\n',
    expected: error('out_of_order', 6),
  },
  {
    name: 'overlapping cues and equal starts',
    format: 'vtt',
    input:
      'WEBVTT\n\n00:00:01.000 --> 00:00:05.000\nA\n\n00:00:01.000 --> 00:00:02.000\nB\n\n00:00:03.000 --> 00:00:04.000\nC\n',
    expected: cues(
      'vtt',
      seg(1000, 5000, 'A'),
      seg(1000, 2000, 'B'),
      seg(3000, 4000, 'C'),
    ),
  },
  {
    name: 'a timing line with no text is dropped',
    format: 'vtt',
    input:
      'WEBVTT\n\n00:00:01.000 --> 00:00:02.000\n\n00:00:03.000 --> 00:00:04.000\nKept\n',
    expected: cues('vtt', seg(3000, 4000, 'Kept')),
  },
  {
    name: 'a cue whose text is only markup is dropped',
    format: 'vtt',
    input:
      'WEBVTT\n\n00:00:01.000 --> 00:00:02.000\n<i> </i>\n\n00:00:03.000 --> 00:00:04.000\nKept\n',
    expected: cues('vtt', seg(3000, 4000, 'Kept')),
  },
  {
    name: 'duplicate cues are kept',
    format: 'vtt',
    input:
      'WEBVTT\n\n00:00:01.000 --> 00:00:02.000\nSame\n\n00:00:01.000 --> 00:00:02.000\nSame\n',
    expected: cues('vtt', seg(1000, 2000, 'Same'), seg(1000, 2000, 'Same')),
  },
  {
    name: 'a trailing cue with no final newline',
    format: 'vtt',
    input: 'WEBVTT\n\n00:00:01.000 --> 00:00:02.000\nEnd',
    expected: cues('vtt', seg(1000, 2000, 'End')),
  },
  {
    name: 'a trailing timing line at end of file',
    format: 'vtt',
    input:
      'WEBVTT\n\n00:00:01.000 --> 00:00:02.000\nA\n\n00:00:03.000 --> 00:00:04.000',
    expected: cues('vtt', seg(1000, 2000, 'A')),
  },
  {
    name: 'an identifier at end of file',
    format: 'vtt',
    input: 'WEBVTT\n\n00:00:01.000 --> 00:00:02.000\nA\n\nlast',
    expected: error('bad_timing_line', 6),
  },
  {
    name: '--> inside cue text',
    format: 'vtt',
    input:
      'WEBVTT\n\n00:00:01.000 --> 00:00:02.000\nA\n00:00:03.000 --> 00:00:04.000\nB\n',
    expected: error('missing_blank_line', 5),
  },
  {
    name: 'WEBVTT with no cues',
    format: 'vtt',
    input: 'WEBVTT\n\n',
    expected: error('no_cues'),
  },
  {
    name: 'voice tags',
    format: 'vtt',
    input: [
      'WEBVTT',
      '',
      '00:00:01.000 --> 00:00:02.000',
      '<v Alice>Hi',
      '',
      '00:00:02.000 --> 00:00:03.000',
      '<v.loud Bob Smith>Loud',
      '',
      '00:00:03.000 --> 00:00:04.000',
      '<v>Nobody',
      '',
      '00:00:04.000 --> 00:00:05.000',
      '<v Alice>Hi</v> <v Bob>Hello</v>',
    ].join('\n'),
    expected: cues(
      'vtt',
      seg(1000, 2000, 'Alice: Hi'),
      seg(2000, 3000, 'Bob Smith: Loud'),
      seg(3000, 4000, 'Nobody'),
      seg(4000, 5000, 'Alice: Hi Bob: Hello'),
    ),
  },
  {
    name: 'nested, unclosed and classed tags, ruby and lang',
    format: 'vtt',
    input:
      'WEBVTT\n\n00:00:01.000 --> 00:00:02.000\n<b><i>Bold</i></b> <c.yellow.bg>col</c> <u>open <lang en>yes</lang> <ruby>漢<rt>kan</rt></ruby>\n',
    expected: cues('vtt', seg(1000, 2000, 'Bold col open yes 漢kan')),
  },
  {
    name: 'inline timestamps',
    format: 'vtt',
    input:
      'WEBVTT\n\n00:00:01.000 --> 00:00:03.000\nOne <00:00:01.500>two <00:02.000>three\n',
    expected: cues('vtt', seg(1000, 3000, 'One two three')),
  },
  {
    name: 'entities, unknown entities and a literal <',
    format: 'vtt',
    input:
      'WEBVTT\n\n00:00:01.000 --> 00:00:02.000\nR&amp;D &lt;tag&gt; &quot;q&quot; it&#39;s a&nbsp;b &copy; a < b &amp;lt;\n',
    expected: cues(
      'vtt',
      seg(1000, 2000, 'R&D <tag> "q" it\'s a b &copy; a < b &lt;'),
    ),
  },
  {
    name: '&lrm; and &rlm; are decoded',
    format: 'vtt',
    input: 'WEBVTT\n\n00:00:01.000 --> 00:00:02.000\na&lrm;b&rlm;c\n',
    expected: cues('vtt', seg(1000, 2000, 'a‎b‏c')),
  },
  {
    name: 'an unknown tag keeps its <',
    format: 'vtt',
    input: 'WEBVTT\n\n00:00:01.000 --> 00:00:02.000\n<span>x</span> 3 <4\n',
    expected: cues('vtt', seg(1000, 2000, '<span>x</span> 3 <4')),
  },
  {
    name: 'a < before a real tag is kept',
    format: 'vtt',
    input: 'WEBVTT\n\n00:00:01.000 --> 00:00:02.000\na <b <i>x</i> c\n',
    expected: cues('vtt', seg(1000, 2000, 'a <b x c')),
  },
  {
    name: 'Zoom-style speaker text is kept verbatim, whitespace collapsed',
    format: 'vtt',
    input:
      'WEBVTT\n\n1\n00:00:01.000 --> 00:00:02.000\nAlice:   We   shipped\n\tit\n',
    expected: cues('vtt', seg(1000, 2000, 'Alice: We shipped it')),
  },
  {
    name: 'CRLF line endings: errors on the right line',
    format: 'vtt',
    input:
      'WEBVTT\r\n\r\n00:00:01.000 --> 00:00:02.000\r\nA\r\n\r\n00:00:03.000 --> 00:00:02.000\r\nB\r\n',
    expected: error('end_before_start', 6),
  },
  {
    name: 'lone CR line endings: errors on the right line',
    format: 'vtt',
    input:
      'WEBVTT\r\r00:00:01.000 --> 00:00:02.000\rA\r\r00:00:03.000 --> 00:00:02.000\rB\r',
    expected: error('end_before_start', 6),
  },
  {
    name: 'mixed line endings',
    format: 'vtt',
    input:
      'WEBVTT\r\n\n00:00:01.000 --> 00:00:02.000\rA\r\n\r00:00:03.000 --> 00:00:04.000\nB',
    expected: cues('vtt', seg(1000, 2000, 'A'), seg(3000, 4000, 'B')),
  },
  {
    name: 'control characters are removed',
    format: 'vtt',
    input: 'WEBVTT\n\n00:00:01.000 --> 00:00:02.000\nA\u0007B\u007fC\n',
    expected: cues('vtt', seg(1000, 2000, 'ABC')),
  },
]

export const SRT_FIXTURES: readonly TranscriptFixture[] = [
  {
    name: 'two cues with indexes',
    format: 'srt',
    input:
      '1\n00:00:01,000 --> 00:00:02,500\nHello\n\n2\n00:00:03,000 --> 00:00:04,000\nTwo\nlines\n',
    expected: cues(
      'srt',
      seg(1000, 2500, 'Hello'),
      seg(3000, 4000, 'Two lines'),
    ),
  },
  {
    name: 'an index missing',
    format: 'srt',
    input: '00:00:01,000 --> 00:00:02,000\nHi\n',
    expected: cues('srt', seg(1000, 2000, 'Hi')),
  },
  {
    name: 'a non-numeric index',
    format: 'srt',
    input:
      '1\n00:00:01,000 --> 00:00:02,000\nA\n\nTwo\n00:00:03,000 --> 00:00:04,000\nB\n',
    expected: error('bad_timing_line', 5),
  },
  {
    name: 'gaps and duplicate indexes',
    format: 'srt',
    input:
      '3\n00:00:01,000 --> 00:00:02,000\nA\n\n3\n00:00:03,000 --> 00:00:04,000\nB\n\n9\n00:00:05,000 --> 00:00:06,000\nC\n',
    expected: cues(
      'srt',
      seg(1000, 2000, 'A'),
      seg(3000, 4000, 'B'),
      seg(5000, 6000, 'C'),
    ),
  },
  {
    name: '. instead of ,',
    format: 'srt',
    input: '1\n00:00:01.000 --> 00:00:02.000\nHi\n',
    expected: cues('srt', seg(1000, 2000, 'Hi')),
  },
  {
    name: 'hours are required',
    format: 'srt',
    input: '1\n00:01,000 --> 00:02,000\nHi\n',
    expected: error('bad_timestamp', 2),
  },
  {
    name: 'two-digit milliseconds',
    format: 'srt',
    input: '1\n00:00:01,00 --> 00:00:02,000\nHi\n',
    expected: error('bad_timestamp', 2),
  },
  {
    name: 'coordinates are ignored',
    format: 'srt',
    input: '1\n00:00:01,000 --> 00:00:02,000 X1:100 X2:200 Y1:10 Y2:20\nHi\n',
    expected: cues('srt', seg(1000, 2000, 'Hi')),
  },
  {
    name: 'a missing blank line between cues',
    format: 'srt',
    input:
      '1\n00:00:01,000 --> 00:00:02,000\nA\n2\n00:00:03,000 --> 00:00:04,000\nB\n',
    expected: error('missing_blank_line', 5),
  },
  {
    name: 'a text-only trailing block',
    format: 'srt',
    input: '1\n00:00:01,000 --> 00:00:02,000\nA\n\nThe end\n',
    expected: error('bad_timing_line', 5),
  },
  {
    name: 'an index at end of file',
    format: 'srt',
    input: '1\n00:00:01,000 --> 00:00:02,000\nA\n\n2',
    expected: error('bad_timing_line', 5),
  },
  {
    name: 'end before start',
    format: 'srt',
    input: '1\n00:00:02,000 --> 00:00:01,000\nA\n',
    expected: error('end_before_start', 2),
  },
  {
    name: 'out of order',
    format: 'srt',
    input:
      '1\n00:00:05,000 --> 00:00:06,000\nA\n\n2\n00:00:01,000 --> 00:00:02,000\nB\n',
    expected: error('out_of_order', 6),
  },
  {
    name: 'over 24 hours',
    format: 'srt',
    input: '1\n24:00:00,000 --> 24:00:00,001\nA\n',
    expected: error('bad_timestamp', 2),
  },
  {
    name: '{\\an8}, <font>, <i>, <b>, <u> and dialogue dashes',
    format: 'srt',
    input:
      '1\n00:00:01,000 --> 00:00:02,000\n{\\an8}<font color="#ff0000">Red</font> <I>it</I> <b>b</b> <u>u</u>\n- Yes.\n- No.\n',
    expected: cues('srt', seg(1000, 2000, 'Red it b u - Yes. - No.')),
  },
  {
    name: 'ALICE: lines are kept verbatim',
    format: 'srt',
    input: '1\n00:00:01,000 --> 00:00:02,000\nALICE: We shipped it.\n',
    expected: cues('srt', seg(1000, 2000, 'ALICE: We shipped it.')),
  },
  {
    name: 'an SRT file with only empty cues',
    format: 'srt',
    input: '1\n00:00:01,000 --> 00:00:02,000\n\n',
    expected: error('no_cues'),
  },
  {
    name: 'CRLF line endings: errors on the right line',
    format: 'srt',
    input:
      '1\r\n00:00:01,000 --> 00:00:02,000\r\nA\r\n\r\n2\r\n00:00:01,00 --> 00:00:02,000\r\nB\r\n',
    expected: error('bad_timestamp', 6),
  },
  {
    name: 'lone CR line endings: errors on the right line',
    format: 'srt',
    input:
      '1\r00:00:01,000 --> 00:00:02,000\rA\r\r2\r00:00:01,00 --> 00:00:02,000\rB\r',
    expected: error('bad_timestamp', 6),
  },
]

export const PLAIN_FIXTURES: readonly TranscriptFixture[] = [
  {
    name: 'CRLF, lone CR and mixed endings become \\n',
    format: 'auto',
    input: 'one\r\ntwo\rthree\nfour\r\n',
    expected: { format: 'plain', text: 'one\ntwo\nthree\nfour', segments: [] },
  },
  {
    name: 'trailing whitespace, blank-line runs, leading and trailing blank lines',
    format: 'auto',
    input: '\n\n  \nAlice: Hi   \n\n\n\n\tBob: Hello\t there \n\n \n',
    expected: {
      format: 'plain',
      text: 'Alice: Hi\n\n\tBob: Hello\t there',
      segments: [],
    },
  },
  {
    name: 'two line breaks are kept',
    format: 'auto',
    input: 'a\n\nb',
    expected: { format: 'plain', text: 'a\n\nb', segments: [] },
  },
  {
    name: 'control characters are removed, tabs kept',
    format: 'auto',
    input: 'a\u0001b\tc\u001fd\u007f',
    expected: { format: 'plain', text: 'ab\tcd', segments: [] },
  },
  {
    name: 'speaker labels are kept verbatim',
    format: 'auto',
    input: 'Alice: We shipped it.\nBOB: Great --> next.',
    expected: {
      format: 'plain',
      text: 'Alice: We shipped it.\nBOB: Great --> next.',
      segments: [],
    },
  },
  {
    name: 'a lone number is plain text',
    format: 'auto',
    input: '42\n',
    expected: { format: 'plain', text: '42', segments: [] },
  },
  {
    name: 'WEBVTTX is plain text',
    format: 'auto',
    input: 'WEBVTTX\n00:00:01.000 --> 00:00:02.000\nHi',
    expected: {
      format: 'plain',
      text: 'WEBVTTX\n00:00:01.000 --> 00:00:02.000\nHi',
      segments: [],
    },
  },
  {
    name: 'a timing line further down is plain text',
    format: 'auto',
    input: 'Notes\n1\n00:00:01,000 --> 00:00:02,000\nHi',
    expected: {
      format: 'plain',
      text: 'Notes\n1\n00:00:01,000 --> 00:00:02,000\nHi',
      segments: [],
    },
  },
  {
    name: 'auto detects WEBVTT',
    format: 'auto',
    input: 'WEBVTT\n\n00:01.000 --> 00:02.000\nHi',
    expected: cues('vtt', seg(1000, 2000, 'Hi')),
  },
  {
    name: 'auto detects WEBVTT - x after blank lines',
    format: 'auto',
    input: '\n\nWEBVTT - x\n\n00:01.000 --> 00:02.000\nHi',
    expected: cues('vtt', seg(1000, 2000, 'Hi')),
  },
  {
    name: 'auto detects SRT',
    format: 'auto',
    input: '1\n00:00:01,000 --> 00:00:02,000\nHi',
    expected: cues('srt', seg(1000, 2000, 'Hi')),
  },
  {
    name: 'pasted malformed VTT',
    format: 'auto',
    input: 'WEBVTT\n\n00:00:02.000 --> 00:00:01.000\nHi',
    expected: error('end_before_start', 3),
  },
  {
    name: 'one leading U+FEFF is removed from pasted text',
    format: 'auto',
    input: '﻿Hello',
    expected: { format: 'plain', text: 'Hello', segments: [] },
  },
  {
    name: 'whitespace only is empty',
    format: 'auto',
    input: ' \n\t\r\n  ',
    expected: error('empty'),
  },
  {
    name: 'a lone U+FEFF is empty',
    format: 'auto',
    input: '﻿',
    expected: error('empty'),
  },
  {
    name: 'a VTT file of only whitespace is empty',
    format: 'vtt',
    input: '  \n\n',
    expected: error('empty'),
  },
  {
    name: 'U+0000 is not text',
    format: 'auto',
    input: 'a\u0000b',
    expected: error('not_text'),
  },
  {
    name: 'emoji and combining marks are kept as they are (no normalization)',
    format: 'auto',
    input: 'é 😀',
    expected: { format: 'plain', text: 'é 😀', segments: [] },
  },
]

export const ALL_FIXTURES: readonly TranscriptFixture[] = [
  ...VTT_FIXTURES,
  ...SRT_FIXTURES,
  ...PLAIN_FIXTURES,
]
