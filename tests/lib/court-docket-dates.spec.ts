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

// Expected instants are fixed facts about 2026 Chicago time: CDT (UTC-5)
// through 2026-11-01 02:00 local, CST (UTC-6) after. All but the 11/1 case
// sit clear of a transition, so hardcoding them pins the conversion.
describe('parseDocketDate — no-offset inputs are America/Chicago local', () => {
  it.each([
    ['2026-10-02', '2026-10-02T17:00:00.000Z'], // CDT noon
    ['10/02/2026', '2026-10-02T17:00:00.000Z'], // CDT noon
    ['1/5/2026', '2026-01-05T18:00:00.000Z'], // CST noon
    ['2026-12-03', '2026-12-03T18:00:00.000Z'], // CST noon
    ['12/03/2026 09:30 AM', '2026-12-03T15:30:00.000Z'], // CST
    ['12/03/2026 9:30AM', '2026-12-03T15:30:00.000Z'],
    ['12/03/2026 12:00 AM', '2026-12-03T06:00:00.000Z'],
    ['12/03/2026 12:15 PM', '2026-12-03T18:15:00.000Z'],
    ['7/15/2026 2:05 PM', '2026-07-15T19:05:00.000Z'], // CDT
    ['11/1/2026 3:00 AM', '2026-11-01T09:00:00.000Z'], // first hour after fall-back
  ])('%s → %s', (input, expected) => {
    expect(parseDocketDate(input)).toBe(expected);
  });

  it('is stable across repeated calls and independent of process.env.TZ', () => {
    const saved = process.env.TZ;
    try {
      const results = new Set<string | null>();
      for (const tz of ['UTC', 'Pacific/Auckland', 'America/Los_Angeles', 'Asia/Kolkata']) {
        process.env.TZ = tz;
        results.add(parseDocketDate('10/02/2026'));
        results.add(parseDocketDate('10/02/2026'));
      }
      expect([...results]).toEqual(['2026-10-02T17:00:00.000Z']);
    } finally {
      if (saved === undefined) delete process.env.TZ;
      else process.env.TZ = saved;
    }
  });
});
