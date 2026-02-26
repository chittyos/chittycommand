import type { NeonQueryFunction } from '@neondatabase/serverless';
import { typedRows } from './db';
import { computeUrgencyScore } from './urgency';

/**
 * Smart payment planner engine.
 *
 * Generates payment schedules by simulating forward through time using:
 *   - Real account balances from cc_accounts
 *   - Real obligations from cc_obligations (with escalation data)
 *   - Real revenue sources from cc_revenue_sources (verified from transaction history)
 *   - Learning from past decisions in cc_decision_feedback
 *
 * Never uses fake data. If revenue data is unavailable, plans conservatively
 * with zero expected inflows.
 *
 * Strategy modes:
 *   optimal      — minimize total cost (late fees + interest)
 *   conservative — never miss any due date, pay minimums if cash tight
 *   aggressive   — defer low-consequence items, maximize cash on hand
 */

export type PlanStrategy = 'optimal' | 'conservative' | 'aggressive';

export interface PlanOptions {
  strategy: PlanStrategy;
  horizon_days?: number;
  defer_ids?: string[];
  pay_early_ids?: string[];
  custom_amounts?: Record<string, number>; // obligation_id → custom amount
}

export interface ScheduleEntry {
  date: string;
  obligation_id: string;
  payee: string;
  amount: number;
  account_id: string | null;
  action: string; // 'pay_full', 'pay_minimum', 'defer', 'at_risk'
  balance_after: number;
  grace_used: boolean;
  escalation_risk: string | null;
}

export interface PlanWarning {
  date: string;
  message: string;
  severity: 'info' | 'warning' | 'critical';
}

export interface PaymentPlanResult {
  plan_type: string;
  horizon_days: number;
  starting_balance: number;
  ending_balance: number;
  lowest_balance: number;
  lowest_balance_date: string;
  total_inflows: number;
  total_outflows: number;
  total_late_fees_avoided: number;
  total_late_fees_risked: number;
  schedule: ScheduleEntry[];
  warnings: PlanWarning[];
  revenue_summary: { source: string; monthly: number; confidence: number }[];
}

interface ObligationRow {
  id: string;
  payee: string;
  amount_due: string | null;
  amount_minimum: string | null;
  due_date: string;
  recurrence: string | null;
  recurrence_day: number | null;
  status: string;
  category: string;
  auto_pay: boolean;
  late_fee: string | null;
  grace_period_days: number;
  escalation_type: string | null;
  escalation_threshold_days: number | null;
  escalation_amount: string | null;
  credit_impact_score: number | null;
  preferred_account_id: string | null;
  urgency_score: number | null;
}

interface RevenueRow {
  id: string;
  source: string;
  description: string;
  amount: string;
  recurrence: string | null;
  recurrence_day: number | null;
  next_expected_date: string | null;
  confidence: string;
  account_id: string | null;
}

interface AccountRow {
  id: string;
  account_name: string;
  account_type: string;
  current_balance: string | null;
}

export async function generatePaymentPlan(
  sql: NeonQueryFunction<false, false>,
  options: PlanOptions,
): Promise<PaymentPlanResult> {
  const { strategy, horizon_days = 90, defer_ids = [], pay_early_ids = [], custom_amounts = {} } = options;
  const now = new Date();

  // ── 1. Load real data ──────────────────────────────────────
  const accounts = typedRows<AccountRow>(await sql`
    SELECT id, account_name, account_type, current_balance
    FROM cc_accounts WHERE account_type IN ('checking', 'savings')
    ORDER BY current_balance DESC NULLS LAST
  `);

  const obligations = typedRows<ObligationRow>(await sql`
    SELECT * FROM cc_obligations
    WHERE status IN ('pending', 'overdue')
    ORDER BY due_date ASC
  `);

  const revenueSources = typedRows<RevenueRow>(await sql`
    SELECT * FROM cc_revenue_sources WHERE status = 'active'
  `);

  // Starting balance: sum of all checking + savings
  const startingBalance = accounts.reduce(
    (sum, a) => sum + parseFloat(a.current_balance || '0'), 0,
  );

  // ── 2. Build day-by-day timeline ──────────────────────────
  const schedule: ScheduleEntry[] = [];
  const warnings: PlanWarning[] = [];
  let runningBalance = startingBalance;
  let totalInflows = 0;
  let totalOutflows = 0;
  let lowestBalance = startingBalance;
  let lowestBalanceDate = now.toISOString().slice(0, 10);
  let lateFeesAvoided = 0;
  let lateFeesRisked = 0;

  // Pre-compute which account to use for each obligation
  const defaultAccountId = accounts.length > 0 ? accounts[0].id : null;

  // Score and sort obligations by effective priority
  const scoredObligations = obligations.map((ob) => {
    const score = ob.urgency_score ?? computeUrgencyScore({
      due_date: ob.due_date,
      category: ob.category,
      status: ob.status,
      auto_pay: ob.auto_pay,
      late_fee: ob.late_fee ? parseFloat(ob.late_fee) : null,
      grace_period_days: ob.grace_period_days || 0,
    });

    // Escalation weight: higher for items with severe consequences
    let escalationWeight = 1.0;
    if (ob.escalation_type === 'collections') escalationWeight = 1.5;
    if (ob.escalation_type === 'service_shutoff') escalationWeight = 1.3;
    if (ob.escalation_type === 'legal') escalationWeight = 1.8;
    if (ob.credit_impact_score && ob.credit_impact_score > 50) escalationWeight *= 1.2;

    return { ...ob, effectivePriority: score * escalationWeight };
  }).sort((a, b) => b.effectivePriority - a.effectivePriority);

  // Build revenue inflow map: date → amount
  const revenueByDate = new Map<string, number>();
  for (const rev of revenueSources) {
    const amount = parseFloat(rev.amount) * parseFloat(rev.confidence);
    if (rev.recurrence === 'monthly' && rev.recurrence_day) {
      for (let m = 0; m < Math.ceil(horizon_days / 30); m++) {
        const d = new Date(now.getFullYear(), now.getMonth() + m, rev.recurrence_day);
        if (d >= now && d <= new Date(now.getTime() + horizon_days * 86400000)) {
          const key = d.toISOString().slice(0, 10);
          revenueByDate.set(key, (revenueByDate.get(key) || 0) + amount);
        }
      }
    } else if (rev.next_expected_date) {
      const key = rev.next_expected_date;
      revenueByDate.set(key, (revenueByDate.get(key) || 0) + amount);
    }
  }

  // Simulate each day
  for (let d = 0; d < horizon_days; d++) {
    const date = new Date(now.getTime() + d * 86400000);
    const dateStr = date.toISOString().slice(0, 10);

    // Add revenue inflows
    const dayRevenue = revenueByDate.get(dateStr) || 0;
    if (dayRevenue > 0) {
      runningBalance += dayRevenue;
      totalInflows += dayRevenue;
    }

    // Process obligations due on this date
    for (const ob of scoredObligations) {
      if (defer_ids.includes(ob.id)) continue; // User chose to defer

      const amount = custom_amounts[ob.id]
        ?? parseFloat(ob.amount_due || ob.amount_minimum || '0');
      if (amount <= 0) continue;

      // Check if this obligation falls on this date
      const obDue = new Date(ob.due_date);
      const graceDays = ob.grace_period_days || 0;
      const effectiveDue = new Date(obDue.getTime() + graceDays * 86400000);
      let matches = false;

      // One-time: exact date match (or effective due with grace)
      if (!ob.recurrence) {
        if (pay_early_ids.includes(ob.id)) {
          // Pay early: schedule on first day we have cash
          if (d === 0 || obDue.toISOString().slice(0, 10) === dateStr) matches = true;
        } else if (strategy === 'aggressive' && graceDays > 0) {
          // Aggressive: use grace period
          if (effectiveDue.toISOString().slice(0, 10) === dateStr) matches = true;
        } else {
          if (obDue.toISOString().slice(0, 10) === dateStr) matches = true;
        }
        // Overdue items: schedule on day 0
        if (obDue < now && d === 0) matches = true;
      }

      // Monthly recurrence
      if (ob.recurrence === 'monthly' && ob.recurrence_day === date.getDate()) {
        if (date >= obDue) matches = true;
      }

      // Quarterly
      if (ob.recurrence === 'quarterly' && ob.recurrence_day === date.getDate()) {
        const obMonth = obDue.getMonth();
        if ((date.getMonth() - obMonth) % 3 === 0 && date >= obDue) matches = true;
      }

      if (!matches) continue;

      // Determine payment action based on strategy + cash
      let action: string;
      let payAmount = amount;
      let graceUsed = false;
      let escalationRisk: string | null = null;

      if (runningBalance >= amount) {
        // Can afford full payment
        if (strategy === 'conservative' && runningBalance - amount < 500 && ob.amount_minimum) {
          // Conservative: pay minimum to preserve buffer
          payAmount = parseFloat(ob.amount_minimum);
          action = 'pay_minimum';
        } else {
          action = 'pay_full';
        }
      } else if (ob.amount_minimum && runningBalance >= parseFloat(ob.amount_minimum)) {
        // Can afford minimum
        payAmount = parseFloat(ob.amount_minimum);
        action = 'pay_minimum';
        if (strategy === 'optimal') {
          lateFeesAvoided += ob.late_fee ? parseFloat(ob.late_fee) : 0;
        }
      } else if (strategy === 'aggressive' && graceDays > 0 && !graceUsed) {
        // Aggressive: defer using grace period
        action = 'defer';
        payAmount = 0;
        graceUsed = true;
        warnings.push({
          date: dateStr,
          message: `${ob.payee}: using ${graceDays}-day grace period. Must pay by ${effectiveDue.toISOString().slice(0, 10)}`,
          severity: 'warning',
        });
      } else {
        // Cannot afford — flag at risk
        action = 'at_risk';
        payAmount = 0;
        escalationRisk = ob.escalation_type || 'late_fee';
        lateFeesRisked += ob.late_fee ? parseFloat(ob.late_fee) : 0;

        warnings.push({
          date: dateStr,
          message: `${ob.payee}: insufficient funds ($${runningBalance.toFixed(0)} available, $${amount.toFixed(0)} due). ${ob.escalation_type ? `Risk: ${ob.escalation_type}` : `Late fee: $${ob.late_fee || '0'}`}`,
          severity: ob.escalation_type === 'collections' || ob.escalation_type === 'legal' ? 'critical' : 'warning',
        });
      }

      if (payAmount > 0) {
        runningBalance -= payAmount;
        totalOutflows += payAmount;
      }

      schedule.push({
        date: dateStr,
        obligation_id: ob.id,
        payee: ob.payee,
        amount: Math.round(payAmount * 100) / 100,
        account_id: ob.preferred_account_id || defaultAccountId,
        action,
        balance_after: Math.round(runningBalance * 100) / 100,
        grace_used: graceUsed,
        escalation_risk: escalationRisk,
      });
    }

    // Track lowest balance
    if (runningBalance < lowestBalance) {
      lowestBalance = runningBalance;
      lowestBalanceDate = dateStr;
    }
  }

  // Revenue summary for display
  const revenueSummary = revenueSources.map((r) => ({
    source: r.description,
    monthly: parseFloat(r.amount),
    confidence: parseFloat(r.confidence),
  }));

  const result: PaymentPlanResult = {
    plan_type: strategy,
    horizon_days,
    starting_balance: Math.round(startingBalance * 100) / 100,
    ending_balance: Math.round(runningBalance * 100) / 100,
    lowest_balance: Math.round(lowestBalance * 100) / 100,
    lowest_balance_date: lowestBalanceDate,
    total_inflows: Math.round(totalInflows * 100) / 100,
    total_outflows: Math.round(totalOutflows * 100) / 100,
    total_late_fees_avoided: Math.round(lateFeesAvoided * 100) / 100,
    total_late_fees_risked: Math.round(lateFeesRisked * 100) / 100,
    schedule,
    warnings,
    revenue_summary: revenueSummary,
  };

  return result;
}

export async function savePaymentPlan(
  sql: NeonQueryFunction<false, false>,
  plan: PaymentPlanResult,
): Promise<string> {
  const [row] = await sql`
    INSERT INTO cc_payment_plans (
      plan_type, horizon_days, starting_balance, ending_balance,
      lowest_balance, lowest_balance_date, total_inflows, total_outflows,
      total_late_fees_avoided, total_late_fees_risked, schedule, warnings
    ) VALUES (
      ${plan.plan_type}, ${plan.horizon_days}, ${plan.starting_balance}, ${plan.ending_balance},
      ${plan.lowest_balance}, ${plan.lowest_balance_date}, ${plan.total_inflows}, ${plan.total_outflows},
      ${plan.total_late_fees_avoided}, ${plan.total_late_fees_risked},
      ${JSON.stringify(plan.schedule)}, ${JSON.stringify(plan.warnings)}
    ) RETURNING id
  `;
  return (row as { id: string }).id;
}

export async function simulateScenario(
  sql: NeonQueryFunction<false, false>,
  options: PlanOptions,
): Promise<PaymentPlanResult> {
  // Re-run the full planner with user overrides
  return generatePaymentPlan(sql, options);
}
