/**
 * Unit spec for the strict docket date parser (src/lib/court-docket.ts).
 * No database, no network: pure parsing.
 */

import { describe, it, expect } from 'vitest';
import { parseDocketDate, parseIsoInstant } from '../../src/lib/court-docket';

describe('parseDocketDate — rejects anything outside the accepted forms', () => {
  it.each([
    'Status 3',
    'Continued to 11',
    'continued generally',
    '',
    '   ',
    'Oct 2, 2026',
    '2026/10/02',
    '10/02/26',
    '10-02-2026',
    '2026-10-02T14:30:00',
    '2026-10-02 14:30',
    '12/03/2026 9:30',
    '12/03/2026 13:30 PM',
    '12/03/2026 00:30 AM',
    '2026-13-01',
    '2026-02-30',
    '02/30/2026',
    '13/01/2026',
    '2026-10-02T24:00:00Z',
  ])('%j → null', (input) => {
    expect(parseDocketDate(input)).toBeNull();
  });

  it('non-strings → null', () => {
    expect(parseDocketDate(undefined)).toBeNull();
    expect(parseDocketDate(null)).toBeNull();
    expect(parseDocketDate(20261002)).toBeNull();
  });
});

describe('parseDocketDate — ISO datetime with explicit offset is taken as given', () => {
  it.each([
    ['2026-12-03T14:30:00Z', '2026-12-03T14:30:00.000Z'],
    ['2026-12-03T14:30Z', '2026-12-03T14:30:00.000Z'],
    ['2026-12-03T08:30:00-06:00', '2026-12-03T14:30:00.000Z'],
    ['2026-12-03T20:00:00+0530', '2026-12-03T14:30:00.000Z'],
    ['2026-12-03T14:30:00.123456Z', '2026-12-03T14:30:00.123Z'],
  ])('%s → %s', (input, expected) => {
    expect(parseDocketDate(input)).toBe(expected);
    expect(parseIsoInstant(input)).toBe(expected);
  });

  it('parseIsoInstant refuses date-only and US forms', () => {
    expect(parseIsoInstant('2026-12-03')).toBeNull();
    expect(parseIsoInstant('12/03/2026')).toBeNull();
  });
});
