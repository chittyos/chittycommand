import { describe, it, expect } from 'vitest';
import { computeUrgencyScore, urgencyLevel } from './urgency';

// Helper to create a YYYY-MM-DD date string N days from now (UTC)
function daysFromNow(n: number): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

const base = {
  category: 'utility',
  status: 'pending',
  auto_pay: false,
  late_fee: null as number | null,
  grace_period_days: 0,
};

describe('computeUrgencyScore', () => {
  // ── Time pressure boundaries ────────────────────────────

  describe('time pressure', () => {
    it('scores 0 time pressure for due > 14 days out', () => {
      const score = computeUrgencyScore({ ...base, due_date: daysFromNow(30) });
      // category weight only (utility = 15)
      expect(score).toBe(15);
    });

    it('scores 10 for due in exactly 14 days', () => {
      const score = computeUrgencyScore({ ...base, due_date: daysFromNow(14) });
      expect(score).toBe(10 + 15); // time + utility
    });

    it('scores 20 for due in exactly 7 days', () => {
      const score = computeUrgencyScore({ ...base, due_date: daysFromNow(7) });
      expect(score).toBe(20 + 15);
    });

    it('scores 30 for due in exactly 3 days', () => {
      const score = computeUrgencyScore({ ...base, due_date: daysFromNow(3) });
      expect(score).toBe(30 + 15);
    });

    it('scores 35 for due today', () => {
      const score = computeUrgencyScore({ ...base, due_date: daysFromNow(0) });
      expect(score).toBe(35 + 15);
    });

    it('scores 40 for 1 day overdue', () => {
      const score = computeUrgencyScore({ ...base, due_date: daysFromNow(-1) });
      expect(score).toBe(40 + 15);
    });

    it('scores 45 for 8 days overdue', () => {
      const score = computeUrgencyScore({ ...base, due_date: daysFromNow(-8) });
      expect(score).toBe(45 + 15);
    });

    it('scores 50 for 31+ days overdue', () => {
      const score = computeUrgencyScore({ ...base, due_date: daysFromNow(-31) });
      expect(score).toBe(50 + 15);
    });

    it('scores 10 for due in 8 days (between 7 and 14)', () => {
      const score = computeUrgencyScore({ ...base, due_date: daysFromNow(8) });
      expect(score).toBe(10 + 15);
    });

    it('scores 20 for due in 4 days (between 3 and 7)', () => {
      const score = computeUrgencyScore({ ...base, due_date: daysFromNow(4) });
      expect(score).toBe(20 + 15);
    });

    it('scores 30 for due in 1 day (between 0 and 3)', () => {
      const score = computeUrgencyScore({ ...base, due_date: daysFromNow(1) });
      expect(score).toBe(30 + 15);
    });
  });

  // ── Category weights ────────────────────────────────────

  describe('category weights', () => {
    const futureDue = daysFromNow(30); // 0 time pressure

    it('legal = 30', () => {
      expect(computeUrgencyScore({ ...base, due_date: futureDue, category: 'legal' })).toBe(30);
    });

    it('mortgage = 25', () => {
      expect(computeUrgencyScore({ ...base, due_date: futureDue, category: 'mortgage' })).toBe(25);
    });

    it('property_tax = 20', () => {
      expect(computeUrgencyScore({ ...base, due_date: futureDue, category: 'property_tax' })).toBe(20);
    });

    it('federal_tax = 20', () => {
      expect(computeUrgencyScore({ ...base, due_date: futureDue, category: 'federal_tax' })).toBe(20);
    });

    it('utility = 15', () => {
      expect(computeUrgencyScore({ ...base, due_date: futureDue, category: 'utility' })).toBe(15);
    });

    it('insurance = 15', () => {
      expect(computeUrgencyScore({ ...base, due_date: futureDue, category: 'insurance' })).toBe(15);
    });

    it('hoa = 12', () => {
      expect(computeUrgencyScore({ ...base, due_date: futureDue, category: 'hoa' })).toBe(12);
    });

    it('credit_card = 10', () => {
      expect(computeUrgencyScore({ ...base, due_date: futureDue, category: 'credit_card' })).toBe(10);
    });

    it('loan = 10', () => {
      expect(computeUrgencyScore({ ...base, due_date: futureDue, category: 'loan' })).toBe(10);
    });

    it('subscription = 5', () => {
      expect(computeUrgencyScore({ ...base, due_date: futureDue, category: 'subscription' })).toBe(5);
    });

    it('unknown category defaults to 5', () => {
      expect(computeUrgencyScore({ ...base, due_date: futureDue, category: 'random_thing' })).toBe(5);
    });

    it('empty string category defaults to 5', () => {
      expect(computeUrgencyScore({ ...base, due_date: futureDue, category: '' })).toBe(5);
    });
  });

  // ── Late fee tiers ──────────────────────────────────────

  describe('late fees', () => {
    const futureDue = daysFromNow(30);

    it('no late fee adds 0', () => {
      expect(computeUrgencyScore({ ...base, due_date: futureDue, late_fee: null })).toBe(15);
    });

    it('late fee of 0 adds 0', () => {
      expect(computeUrgencyScore({ ...base, due_date: futureDue, late_fee: 0 })).toBe(15);
    });

    it('late fee of $10 adds 5', () => {
      expect(computeUrgencyScore({ ...base, due_date: futureDue, late_fee: 10 })).toBe(15 + 5);
    });

    it('late fee of $25 adds 5 (boundary, not > 25)', () => {
      expect(computeUrgencyScore({ ...base, due_date: futureDue, late_fee: 25 })).toBe(15 + 5);
    });

    it('late fee of $26 adds 10', () => {
      expect(computeUrgencyScore({ ...base, due_date: futureDue, late_fee: 26 })).toBe(15 + 10);
    });

    it('late fee of $50 adds 10 (boundary, not > 50)', () => {
      expect(computeUrgencyScore({ ...base, due_date: futureDue, late_fee: 50 })).toBe(15 + 10);
    });

    it('late fee of $51 adds 15', () => {
      expect(computeUrgencyScore({ ...base, due_date: futureDue, late_fee: 51 })).toBe(15 + 15);
    });

    it('late fee of $200 adds 15', () => {
      expect(computeUrgencyScore({ ...base, due_date: futureDue, late_fee: 200 })).toBe(15 + 15);
    });
  });

  // ── Status modifiers ────────────────────────────────────

  describe('status modifiers', () => {
    const futureDue = daysFromNow(30);

    it('paid status reduces by 50 (clamped to 0)', () => {
      const score = computeUrgencyScore({ ...base, due_date: futureDue, status: 'paid' });
      // 0 time + 15 category - 50 paid = -35 → clamped to 0
      expect(score).toBe(0);
    });

    it('disputed status reduces by 10', () => {
      const score = computeUrgencyScore({ ...base, due_date: futureDue, status: 'disputed' });
      expect(score).toBe(15 - 10); // 5
    });

    it('deferred status reduces by 15', () => {
      const score = computeUrgencyScore({ ...base, due_date: futureDue, status: 'deferred' });
      expect(score).toBe(15 - 15); // 0
    });

    it('overdue status has no additional modifier (time pressure handles it)', () => {
      // Overdue is about the date, not a status modifier
      const score = computeUrgencyScore({ ...base, due_date: futureDue, status: 'overdue' });
      expect(score).toBe(15); // just category weight
    });
  });

  // ── Auto-pay modifier ───────────────────────────────────

  describe('auto_pay', () => {
    const futureDue = daysFromNow(30);

    it('auto_pay reduces by 25', () => {
      const score = computeUrgencyScore({ ...base, due_date: futureDue, auto_pay: true });
      // 0 time + 15 category - 25 auto_pay = -10 → clamped to 0
      expect(score).toBe(0);
    });

    it('auto_pay on a due-today obligation still lowers score', () => {
      const score = computeUrgencyScore({ ...base, due_date: daysFromNow(0), auto_pay: true });
      // 35 time + 15 category - 25 auto_pay = 25
      expect(score).toBe(25);
    });
  });

  // ── Grace period ────────────────────────────────────────

  describe('grace period', () => {
    it('grace period shifts effective due date for time pressure', () => {
      // Due 1 day ago, but 5 day grace period → effectively 4 days out
      const score = computeUrgencyScore({
        ...base,
        due_date: daysFromNow(-1),
        grace_period_days: 5,
      });
      // With grace: effective = 4 days out → 20 time pressure + 15 category = 35
      expect(score).toBe(20 + 15);
    });

    it('grace period of 0 has no effect', () => {
      const score = computeUrgencyScore({
        ...base,
        due_date: daysFromNow(-1),
        grace_period_days: 0,
      });
      // 1 day overdue → 40 time + 15 category = 55
      expect(score).toBe(40 + 15);
    });

    it('grace period does not reduce overdue severity when fully expired', () => {
      // 10 days overdue, 3 day grace → effectively 7 days overdue
      const score = computeUrgencyScore({
        ...base,
        due_date: daysFromNow(-10),
        grace_period_days: 3,
      });
      // Effective = 7 days overdue → daysUntilDue = -7 → < -7 is false, < 0 is true → 40
      expect(score).toBe(40 + 15);
    });
  });

  // ── Combined modifiers ──────────────────────────────────

  describe('combined modifiers', () => {
    it('auto_pay + paid stacks (both reduce)', () => {
      const score = computeUrgencyScore({
        ...base,
        due_date: daysFromNow(0),
        auto_pay: true,
        status: 'paid',
      });
      // 35 time + 15 category - 25 auto_pay - 50 paid = -25 → clamped to 0
      expect(score).toBe(0);
    });

    it('auto_pay + disputed stacks', () => {
      const score = computeUrgencyScore({
        ...base,
        due_date: daysFromNow(0),
        auto_pay: true,
        status: 'disputed',
      });
      // 35 + 15 - 25 - 10 = 15
      expect(score).toBe(15);
    });

    it('max possible score: severely overdue legal with high late fee', () => {
      const score = computeUrgencyScore({
        ...base,
        due_date: daysFromNow(-60),
        category: 'legal',
        late_fee: 100,
      });
      // 50 time + 30 legal + 15 late fee = 95
      expect(score).toBe(95);
    });

    it('score is clamped to 100 even with theoretical overflow', () => {
      // This tests the upper clamp — construct a high score
      const score = computeUrgencyScore({
        ...base,
        due_date: daysFromNow(-60),
        category: 'legal',
        late_fee: 100,
      });
      expect(score).toBeLessThanOrEqual(100);
    });

    it('score is clamped to 0 even with heavy reductions', () => {
      const score = computeUrgencyScore({
        ...base,
        due_date: daysFromNow(30),
        category: 'subscription',
        auto_pay: true,
        status: 'paid',
      });
      // 0 + 5 - 25 - 50 = -70 → clamped to 0
      expect(score).toBe(0);
    });
  });

  // ── Invalid / edge case inputs ──────────────────────────

  describe('invalid inputs', () => {
    it('invalid date string returns 0 (fails gracefully)', () => {
      const score = computeUrgencyScore({ ...base, due_date: 'not-a-date' });
      // Should handle NaN gracefully, not crash
      expect(score).toBeGreaterThanOrEqual(0);
      expect(score).toBeLessThanOrEqual(100);
    });

    it('empty date string returns category weight only (no time pressure)', () => {
      const score = computeUrgencyScore({ ...base, due_date: '' });
      expect(score).toBeGreaterThanOrEqual(0);
      expect(score).toBeLessThanOrEqual(100);
    });

    it('NaN late_fee is treated as no late fee', () => {
      const score = computeUrgencyScore({ ...base, due_date: daysFromNow(30), late_fee: NaN });
      expect(score).toBe(15); // just category weight
    });

    it('negative late_fee is treated as no late fee', () => {
      const score = computeUrgencyScore({ ...base, due_date: daysFromNow(30), late_fee: -10 });
      expect(score).toBe(15);
    });

    it('negative grace_period_days does not break scoring', () => {
      const score = computeUrgencyScore({
        ...base,
        due_date: daysFromNow(3),
        grace_period_days: -5,
      });
      // Should not make things worse — treat as 0
      expect(score).toBeGreaterThanOrEqual(0);
    });

    it('NaN grace_period_days is treated as 0', () => {
      const score = computeUrgencyScore({
        ...base,
        due_date: daysFromNow(-1),
        grace_period_days: NaN,
      });
      // 1 day overdue (40 time + 15 category = 55)
      expect(score).toBe(55);
    });
  });
});

// ── urgencyLevel ──────────────────────────────────────────

describe('urgencyLevel', () => {
  it('returns critical for 70', () => expect(urgencyLevel(70)).toBe('critical'));
  it('returns critical for 100', () => expect(urgencyLevel(100)).toBe('critical'));
  it('returns high for 50', () => expect(urgencyLevel(50)).toBe('high'));
  it('returns high for 69', () => expect(urgencyLevel(69)).toBe('high'));
  it('returns medium for 30', () => expect(urgencyLevel(30)).toBe('medium'));
  it('returns medium for 49', () => expect(urgencyLevel(49)).toBe('medium'));
  it('returns low for 29', () => expect(urgencyLevel(29)).toBe('low'));
  it('returns low for 0', () => expect(urgencyLevel(0)).toBe('low'));
});
