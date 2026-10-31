import { describe, expect, it, vi } from 'vitest'
import {
  addWeeks,
  defaultCycleTitle,
  formatWeekStart,
  weekStartOf,
} from './cycleWeek'

// Zones on both sides of UTC, where a local date and the UTC date differ.
const TIME_ZONES = [
  'UTC',
  'America/Los_Angeles',
  'Pacific/Kiritimati',
  'Pacific/Pago_Pago',
  'Asia/Kolkata',
]

// vi.stubEnv sets process.env.TZ, which Node applies to local dates at once.
// setupTests restores it after every test with vi.unstubAllEnvs().
function setTimeZone(zone: string): void {
  vi.stubEnv('TZ', zone)
}

describe('weekStartOf', () => {
  it('returns a Monday itself', () => {
    expect(weekStartOf(new Date(2026, 9, 26, 9, 0))).toBe('2026-10-26')
  })

  it('returns the previous Monday for a Sunday', () => {
    expect(weekStartOf(new Date(2026, 10, 1, 12, 0))).toBe('2026-10-26')
  })

  it('crosses a month and a year boundary', () => {
    // Thursday 2026-12-31.
    expect(weekStartOf(new Date(2026, 11, 31, 12, 0))).toBe('2026-12-28')
    // Saturday 2027-01-02 belongs to the same week.
    expect(weekStartOf(new Date(2027, 0, 2, 12, 0))).toBe('2026-12-28')
  })

  it('handles a leap day', () => {
    // Saturday 2028-02-29.
    expect(weekStartOf(new Date(2028, 1, 29, 12, 0))).toBe('2028-02-28')
  })

  it.each(TIME_ZONES)(
    'uses the local date, not the UTC date, in %s',
    (zone) => {
      setTimeZone(zone)
      // Sunday 23:30 local time is still the week of Monday 2026-10-26.
      expect(weekStartOf(new Date(2026, 10, 1, 23, 30))).toBe('2026-10-26')
      // Monday 00:10 local time starts the next week.
      expect(weekStartOf(new Date(2026, 10, 2, 0, 10))).toBe('2026-11-02')
    },
  )

  it('differs from the UTC week when the local and UTC dates differ', () => {
    setTimeZone('America/Los_Angeles')
    const sundayNight = new Date(2026, 10, 1, 23, 30)
    // In UTC this instant is already Monday 2026-11-02.
    expect(sundayNight.toISOString().slice(0, 10)).toBe('2026-11-02')
    expect(weekStartOf(sundayNight)).toBe('2026-10-26')

    setTimeZone('Pacific/Kiritimati')
    const mondayMorning = new Date(2026, 10, 2, 0, 10)
    // In UTC this instant is still Sunday 2026-11-01.
    expect(mondayMorning.toISOString().slice(0, 10)).toBe('2026-11-01')
    expect(weekStartOf(mondayMorning)).toBe('2026-11-02')
  })
})

describe('addWeeks', () => {
  it('moves by whole weeks across months and years', () => {
    expect(addWeeks('2026-10-26', -1)).toBe('2026-10-19')
    expect(addWeeks('2026-10-26', 1)).toBe('2026-11-02')
    expect(addWeeks('2026-12-28', 1)).toBe('2027-01-04')
    expect(addWeeks('2028-02-28', 1)).toBe('2028-03-06')
  })

  it('rejects a value that is not YYYY-MM-DD', () => {
    expect(() => addWeeks('2026-10-26T00:00:00Z', 1)).toThrow(RangeError)
  })
})

describe('formatWeekStart', () => {
  it.each(TIME_ZONES)('formats the stored day unchanged in %s', (zone) => {
    setTimeZone(zone)
    expect(formatWeekStart('2026-10-26')).toBe('Oct 26, 2026')
    expect(formatWeekStart('2026-12-28')).toBe('Dec 28, 2026')
    expect(defaultCycleTitle('2026-10-26')).toBe('Week of Oct 26, 2026')
  })
})
