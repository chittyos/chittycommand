import { describe, it, expect } from 'vitest';
import { computeVendorRisk, vendorRiskInputFromRow, numOrNull, type VendorRiskInput } from '../../src/lib/vendor-risk';

// Helper to create a YYYY-MM-DD date string N days from now (UTC)
function daysFromNow(n: number): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

const base: VendorRiskInput = {
  payment_status: 'active',
  auto_pay: false,
  next_bill_date: null,
  mtd_spend: null,
  budget_limit: null,
  spending_limit: null,
  status: 'active',
};

describe('computeVendorRisk', () => {
  it('healthy active vendor with no signals scores 0 (low)', () => {
    const r = computeVendorRisk(base);
    expect(r.score).toBe(0);
    expect(r.level).toBe('low');
  });

  // ── Payment health ──────────────────────────────────────────
  describe('payment status', () => {
    it('failed adds 50 (high) and explains the bounce', () => {
      const r = computeVendorRisk({ ...base, payment_status: 'failed' });
      expect(r.score).toBe(50);
      expect(r.level).toBe('high');
      expect(r.reasons.some((x) => x.includes('payment failed'))).toBe(true);
    });

    it('limited adds 35 (medium)', () => {
      expect(computeVendorRisk({ ...base, payment_status: 'limited' }).score).toBe(35);
    });

    it('unknown adds 5 (low)', () => {
      expect(computeVendorRisk({ ...base, payment_status: 'unknown' }).score).toBe(5);
    });

    it('active adds 0', () => {
      expect(computeVendorRisk({ ...base, payment_status: 'active' }).score).toBe(0);
    });
  });

  // ── Provider spending limit ─────────────────────────────────
  describe('spending limit headroom', () => {
    it('at/over the cap adds 25', () => {
      expect(computeVendorRisk({ ...base, mtd_spend: 100, spending_limit: 100 }).score).toBe(25);
      expect(computeVendorRisk({ ...base, mtd_spend: 150, spending_limit: 100 }).score).toBe(25);
    });

    it('>= 90% adds 15', () => {
      expect(computeVendorRisk({ ...base, mtd_spend: 90, spending_limit: 100 }).score).toBe(15);
    });

    it('>= 75% adds 8', () => {
      expect(computeVendorRisk({ ...base, mtd_spend: 75, spending_limit: 100 }).score).toBe(8);
    });

    it('< 75% adds 0', () => {
      expect(computeVendorRisk({ ...base, mtd_spend: 74, spending_limit: 100 }).score).toBe(0);
    });

    it('ignores a zero/invalid limit', () => {
      expect(computeVendorRisk({ ...base, mtd_spend: 100, spending_limit: 0 }).score).toBe(0);
    });

    it('ignores when mtd_spend is null', () => {
      expect(computeVendorRisk({ ...base, mtd_spend: null, spending_limit: 100 }).score).toBe(0);
    });
  });

  // ── Internal budget ─────────────────────────────────────────
  describe('budget overrun', () => {
    it('over budget adds 15', () => {
      expect(computeVendorRisk({ ...base, mtd_spend: 101, budget_limit: 100 }).score).toBe(15);
    });

    it('at 90% (incl. exactly at budget) adds 8', () => {
      expect(computeVendorRisk({ ...base, mtd_spend: 90, budget_limit: 100 }).score).toBe(8);
      expect(computeVendorRisk({ ...base, mtd_spend: 100, budget_limit: 100 }).score).toBe(8);
    });

    it('< 90% adds 0', () => {
      expect(computeVendorRisk({ ...base, mtd_spend: 89, budget_limit: 100 }).score).toBe(0);
    });
  });

  // ── Bill imminence ──────────────────────────────────────────
  describe('bill imminence (manual)', () => {
    it('due within 3 days adds 20', () => {
      expect(computeVendorRisk({ ...base, next_bill_date: daysFromNow(2) }).score).toBe(20);
      expect(computeVendorRisk({ ...base, next_bill_date: daysFromNow(0) }).score).toBe(20);
    });

    it('due within 7 days adds 10', () => {
      expect(computeVendorRisk({ ...base, next_bill_date: daysFromNow(5) }).score).toBe(10);
    });

    it('due within 14 days adds 5', () => {
      expect(computeVendorRisk({ ...base, next_bill_date: daysFromNow(10) }).score).toBe(5);
    });

    it('due beyond 14 days adds 0', () => {
      expect(computeVendorRisk({ ...base, next_bill_date: daysFromNow(20) }).score).toBe(0);
    });

    it('past-due (stale) adds 10', () => {
      expect(computeVendorRisk({ ...base, next_bill_date: daysFromNow(-1) }).score).toBe(10);
    });

    it('invalid date contributes nothing', () => {
      expect(computeVendorRisk({ ...base, next_bill_date: 'not-a-date' }).score).toBe(0);
    });
  });

  describe('bill imminence (autopay) is softer', () => {
    it('autopay bill due in 2 days adds only 8 (before the healthy-autopay credit)', () => {
      // payment_status 'unknown' avoids the active-only healthy-autopay credit,
      // isolating the autopay bill weighting: 5 (unknown) + 8 (autopay <=3d) = 13
      const r = computeVendorRisk({ ...base, payment_status: 'unknown', auto_pay: true, next_bill_date: daysFromNow(2) });
      expect(r.score).toBe(13);
    });
  });

  // ── Healthy autopay credit ──────────────────────────────────
  describe('healthy autopay', () => {
    it('active + autopay reduces by 15 (clamped to 0 alone)', () => {
      const r = computeVendorRisk({ ...base, auto_pay: true });
      expect(r.score).toBe(0);
      expect(r.reasons.some((x) => x.includes('autopay active'))).toBe(true);
    });

    it('credit nets against other risk', () => {
      // active + autopay healthy (-15) + spend at cap (+25) = 10
      expect(computeVendorRisk({ ...base, auto_pay: true, mtd_spend: 100, spending_limit: 100 }).score).toBe(10);
    });

    it('no credit when payment is not active', () => {
      // failed + autopay: the credit requires active status, so 50 stands
      expect(computeVendorRisk({ ...base, payment_status: 'failed', auto_pay: true }).score).toBe(50);
    });
  });

  // ── Status modifiers ────────────────────────────────────────
  describe('status', () => {
    it('cancelled short-circuits to 0 regardless of other signals', () => {
      const r = computeVendorRisk({
        ...base,
        status: 'cancelled',
        payment_status: 'failed',
        mtd_spend: 999,
        spending_limit: 100,
        next_bill_date: daysFromNow(-5),
      });
      expect(r.score).toBe(0);
      expect(r.reasons[0]).toContain('cancelled');
    });

    it('paused reduces by 20', () => {
      // spend at cap (+25) + paused (-20) = 5
      expect(computeVendorRisk({ ...base, status: 'paused', mtd_spend: 100, spending_limit: 100 }).score).toBe(5);
    });

    it('zombie still scores like active (live billing risk remains)', () => {
      expect(computeVendorRisk({ ...base, status: 'zombie', mtd_spend: 100, spending_limit: 100 }).score).toBe(25);
    });
  });

  // ── Clamping ────────────────────────────────────────────────
  describe('clamping', () => {
    it('clamps to 100 when signals stack past the ceiling', () => {
      const r = computeVendorRisk({
        ...base,
        payment_status: 'failed',     // +50
        mtd_spend: 200,
        spending_limit: 100,          // +25
        budget_limit: 100,            // +15 (over budget)
        next_bill_date: daysFromNow(2), // +20 (manual, <=3d)
        auto_pay: false,
      });
      expect(r.score).toBe(100);
      expect(r.level).toBe('critical');
    });

    it('clamps to 0 when reductions exceed signals', () => {
      expect(computeVendorRisk({ ...base, status: 'paused', auto_pay: true }).score).toBe(0);
    });
  });

  it('failed payment + spend over cap is critical', () => {
    const r = computeVendorRisk({ ...base, payment_status: 'failed', mtd_spend: 200, spending_limit: 100 });
    expect(r.score).toBe(75);
    expect(r.level).toBe('critical');
  });
});

// ── Row coercion helpers ──────────────────────────────────────
describe('numOrNull', () => {
  it('passes through finite numbers', () => expect(numOrNull(5)).toBe(5));
  it('parses numeric strings (Neon NUMERIC)', () => expect(numOrNull('150.00')).toBe(150));
  it('returns null for null/undefined', () => {
    expect(numOrNull(null)).toBeNull();
    expect(numOrNull(undefined)).toBeNull();
  });
  it('returns null for non-numeric strings', () => expect(numOrNull('abc')).toBeNull());
});

describe('vendorRiskInputFromRow', () => {
  it('coerces a raw DB row (string numerics) into a scored input', () => {
    const row = {
      payment_status: 'failed',
      auto_pay: false,
      next_bill_date: null,
      mtd_spend: '150.00',
      budget_limit: null,
      spending_limit: '100.00',
      status: 'active',
    };
    const r = computeVendorRisk(vendorRiskInputFromRow(row));
    // failed (+50) + spend over cap (+25) = 75
    expect(r.score).toBe(75);
  });

  it('defaults missing payment_status/status sensibly', () => {
    const input = vendorRiskInputFromRow({});
    expect(input.payment_status).toBe('unknown');
    expect(input.status).toBe('active');
    expect(input.mtd_spend).toBeNull();
  });
});
