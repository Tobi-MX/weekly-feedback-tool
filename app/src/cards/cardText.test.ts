import { describe, expect, it } from 'vitest'
import {
  CARD_TEXT_EMPTY_MESSAGE,
  CARD_TEXT_TOO_LONG_MESSAGE,
  cardFormSchema,
  cardTextError,
  cardTextLength,
  trimCardText,
} from './cardText'

function parse(text: string) {
  return cardFormSchema.safeParse({ text, isAnonymous: false })
}

function messageOf(text: string): string | undefined {
  const result = parse(text)
  return result.success ? undefined : result.error.issues[0]?.message
}

describe('trimCardText', () => {
  it('removes exactly spaces, tabs, \\n and \\r at both ends', () => {
    expect(trimCardText('  Ship on Fridays \n')).toBe('Ship on Fridays')
    expect(trimCardText('\t\r\n x \r\n\t ')).toBe('x')
  })

  it('keeps interior line breaks and spacing', () => {
    expect(trimCardText('\nfirst\n\nsecond  line\r\nthird\n')).toBe(
      'first\n\nsecond  line\r\nthird',
    )
  })

  it('keeps characters outside the trim set that String.trim would remove', () => {
    expect(trimCardText(' x ')).toBe(' x ')
    expect(trimCardText(' x\u000b')).toBe(' x\u000b')
    expect(' x '.trim()).toBe('x')
  })
})

describe('cardTextLength', () => {
  it.each<[string, string, number]>([
    ['empty', '', 0],
    ['whitespace only', ' \t\n\r ', 0],
    ['500 ASCII characters', 'a'.repeat(500), 500],
    ['501 ASCII characters', 'a'.repeat(501), 501],
    ['500 é', 'é'.repeat(500), 500],
    ['500 😀', '😀'.repeat(500), 500],
    ['501 😀', '😀'.repeat(501), 501],
    ['surrounding whitespace', `  ${'a'.repeat(500)}\n`, 500],
  ])('counts %s as %i', (_label, text, length) => {
    expect(cardTextLength(text)).toBe(length)
  })

  it('counts a combining sequence per code point, like char_length', () => {
    // "e" + U+0301 COMBINING ACUTE ACCENT renders as one glyph, two points.
    const combining = 'é'
    expect(cardTextLength(combining)).toBe(2)
    expect(cardTextLength(combining.repeat(250))).toBe(500)
    expect(cardTextLength(combining.repeat(250) + 'e')).toBe(501)
  })

  it('does not count UTF-16 units', () => {
    expect('😀'.repeat(500).length).toBe(1000)
    expect(cardTextLength('😀'.repeat(500))).toBe(500)
  })
})

describe('cardFormSchema', () => {
  it.each(['', '   ', ' \t\n\r '])('rejects %j as empty', (text) => {
    expect(messageOf(text)).toBe(CARD_TEXT_EMPTY_MESSAGE)
    expect(cardTextError(text)).toBe(CARD_TEXT_EMPTY_MESSAGE)
  })

  it.each<[string, string]>([
    ['500 ASCII', 'a'.repeat(500)],
    ['500 é', 'é'.repeat(500)],
    ['500 😀', '😀'.repeat(500)],
  ])('accepts %s', (_label, text) => {
    const result = parse(text)
    expect(result.success).toBe(true)
    expect(cardTextError(text)).toBeNull()
  })

  it.each<[string, string]>([
    ['501 ASCII', 'a'.repeat(501)],
    ['501 😀', '😀'.repeat(501)],
  ])('rejects %s as too long', (_label, text) => {
    expect(messageOf(text)).toBe(CARD_TEXT_TOO_LONG_MESSAGE)
  })

  it('outputs trimmed text with interior newlines and the anonymity choice', () => {
    const result = cardFormSchema.safeParse({
      text: '  Ship on Fridays \n',
      isAnonymous: true,
    })
    expect(result.success && result.data).toEqual({
      text: 'Ship on Fridays',
      isAnonymous: true,
    })

    const multiline = parse('\nline one\nline two\n')
    expect(multiline.success && multiline.data.text).toBe('line one\nline two')
  })

  it('measures the limit after trimming', () => {
    expect(parse(`\n\n${'a'.repeat(500)}   `).success).toBe(true)
  })
})
