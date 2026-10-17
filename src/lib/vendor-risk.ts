/**
 * Deterministic vendor spend-risk scoring.
 *
 * Sibling to src/lib/urgency.ts (obligation urgency). Where urgency answers
 * "which bill needs attention", this answers "which recurring vendor is about
 * to bounce a charge, blow a budget, or hit a provider spending cap" — the
 * failure mode behind a surprise billing block. Pure + deterministic so it is
 * unit-testable and safe to run identically in cron, routes, and the MCP
 * surface.
 *
 * Returns 0-100; higher = more at risk. Level buckets reuse urgencyLevel so the
 * dashboard speaks one risk vocabulary across obligations and vendors.
 */
import { urgencyLevel, type UrgencyLevel } from './urgency';

// Score at/above which a vendor is "at risk" (high/critical). Mirrors the
// urgencyLevel 'high' boundary; centralised so routes, MCP, and cron agree.
export const AT_RISK_THRESHOLD = 50;

export type VendorPaymentStatus = 'active' | 'failed' | 'limited' | 'unknown';
export type VendorStatus = 'active' | 'paused' | 'cancelled' | 'zombie';

export interface VendorRiskInput {
  payment_status: VendorPaymentStatus;
  auto_pay: boolean;
  next_bill_date: string | null; // YYYY-MM-DD
  mtd_spend: number | null;
  budget_limit: number | null;
  spending_limit: number | null;
  status: VendorStatus;
}

export interface VendorRisk {
  score: number;
  level: UrgencyLevel;
  reasons: string[];
}

function isFiniteNum(n: number | null | undefined): n is number {
  return n != null && Number.isFinite(n);
}

function money(n: number): string {
  return n.toFixed(2);
}

// Whole-day difference from today (UTC, date-only) to a YYYY-MM-DD date.
// Mirrors the date handling in urgency.ts. Returns null for invalid input.
function daysUntil(dateStr: string): number | null {
  const target = new Date(dateStr + 'T00:00:00Z');
  if (isNaN(target.getTime())) return null;
  const now = new Date();
  const today = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  return Math.floor((target.getTime() - today.getTime()) / 86400000);
}

export function computeVendorRisk(v: VendorRiskInput): VendorRisk {
  const reasons: string[] = [];

  // Cancelled vendors carry no live billing risk.
  if (v.status === 'cancelled') {
    return { score: 0, level: urgencyLevel(0), reasons: ['vendor cancelled — no active billing'] };
  }

  let score = 0;

  // ── Payment health (the autopay-bounce signal) ──
  if (v.payment_status === 'failed') {
    score += 50;
    reasons.push('payment failed — next charge will bounce');
  } else if (v.payment_status === 'limited') {
    score += 35;
    reasons.push('account limited / spending cap reached');
  } else if (v.payment_status === 'unknown') {
    score += 5;
    reasons.push('payment status unknown');
  }

  const mtd = isFiniteNum(v.mtd_spend) ? v.mtd_spend : null;

  // ── Provider spending-limit headroom (hard cap → charge bounces) ──
  if (mtd != null && isFiniteNum(v.spending_limit) && v.spending_limit > 0) {
    const ratio = mtd / v.spending_limit;
    if (ratio >= 1) {
      score += 25;
      reasons.push(`MTD $${money(mtd)} at/over spending limit $${money(v.spending_limit)}`);
    } else if (ratio >= 0.9) {
      score += 15;
      reasons.push(`MTD $${money(mtd)} ≥ 90% of spending limit`);
    } else if (ratio >= 0.75) {
      score += 8;
      reasons.push(`MTD $${money(mtd)} ≥ 75% of spending limit`);
    }
  }

  // ── Internal budget overrun (our cap, not the provider's) ──
  if (mtd != null && isFiniteNum(v.budget_limit) && v.budget_limit > 0) {
    if (mtd > v.budget_limit) {
      score += 15;
      reasons.push(`MTD $${money(mtd)} over budget $${money(v.budget_limit)}`);
    } else if (mtd >= 0.9 * v.budget_limit) {
      score += 8;
      reasons.push(`MTD $${money(mtd)} ≥ 90% of budget`);
    }
  }

  // ── Bill imminence (manual bills are riskier than autopay) ──
  if (v.next_bill_date) {
    const days = daysUntil(v.next_bill_date);
    if (days != null) {
      if (days < 0) {
        score += 10;
        reasons.push('next bill date is in the past (stale / unreconciled)');
      } else if (days <= 3) {
        score += v.auto_pay ? 8 : 20;
        reasons.push(`bill due in ${days}d${v.auto_pay ? '' : ' (manual)'}`);
      } else if (days <= 7) {
        score += v.auto_pay ? 4 : 10;
        reasons.push(`bill due in ${days}d${v.auto_pay ? '' : ' (manual)'}`);
      } else if (days <= 14 && !v.auto_pay) {
        score += 5;
        reasons.push(`bill due in ${days}d (manual)`);
      }
    }
  }

  // ── Healthy autopay reduces surprise risk (it's handled) ──
  if (v.auto_pay && v.payment_status === 'active') {
    score -= 15;
    reasons.push('autopay active & healthy');
  }

  // ── Paused vendors are lower risk ──
  if (v.status === 'paused') {
    score -= 20;
    reasons.push('vendor paused');
  }

  score = Math.min(100, Math.max(0, score));
  return { score, level: urgencyLevel(score), reasons };
}

/**
 * Coerce an unknown DB value to a finite number, else null. Neon returns
 * NUMERIC columns as strings, so spend/limit fields need this.
 */
export function numOrNull(v: unknown): number | null {
  if (v == null) return null;
  const n = typeof v === 'number' ? v : parseFloat(String(v));
  return Number.isFinite(n) ? n : null;
}

/**
 * Build a VendorRiskInput from a raw cc_vendors DB row. Centralised so routes,
 * cron, and MCP all assess rows identically.
 */
export function vendorRiskInputFromRow(r: Record<string, unknown>): VendorRiskInput {
  return {
    payment_status: (r.payment_status as VendorPaymentStatus) || 'unknown',
    auto_pay: Boolean(r.auto_pay),
    next_bill_date: (r.next_bill_date as string) ?? null,
    mtd_spend: numOrNull(r.mtd_spend),
    budget_limit: numOrNull(r.budget_limit),
    spending_limit: numOrNull(r.spending_limit),
    status: (r.status as VendorStatus) || 'active',
  };
}
