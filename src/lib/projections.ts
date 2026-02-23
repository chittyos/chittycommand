import type { NeonQueryFunction } from '@neondatabase/serverless';
import { typedRows } from './db';

/**
 * Cash flow projection engine.
 *
 * Generates day-by-day projections for the next 90 days based on:
 *   - Current cash position (checking + savings accounts)
 *   - Pending obligations with due dates
 *   - Recurring obligations projected forward
 *   - Known inflows (recurring income from transaction history)
 *
 * Writes to cc_cashflow_projections table.
 */

export interface ProjectionResult {
  starting_balance: number;
  ending_balance: number;
  total_inflows: number;
  total_outflows: number;
  days_projected: number;
  lowest_balance: number;
  lowest_balance_date: string;
}

interface Obligation {
  id: string;
  payee: string;
  amount_due: string | null;
  amount_minimum: string | null;
  due_date: string;
  recurrence: string | null;
  recurrence_day: number | null;
  status: string;
  category: string;
}

export async function generateProjections(sql: NeonQueryFunction<false, false>): Promise<ProjectionResult> {
  const now = new Date();
  const days = 90;

  // ── 1. Starting balance: sum of checking + savings ──
  const [balanceRow] = await sql`
    SELECT COALESCE(SUM(current_balance), 0) as total
    FROM cc_accounts WHERE account_type IN ('checking', 'savings')
  `;
  const startingBalance = parseFloat(balanceRow?.total || '0');

  // ── 2. Get all active obligations ──
  const obligations = typedRows<Obligation>(await sql`
    SELECT * FROM cc_obligations WHERE status IN ('pending', 'overdue')
  `);

  // ── 3. Estimate recurring inflows from recent transaction history ──
  const [inflowRow] = await sql`
    SELECT COALESCE(AVG(monthly_in), 0) as avg_monthly
    FROM (
      SELECT DATE_TRUNC('month', tx_date) as month, SUM(amount) as monthly_in
      FROM cc_transactions
      WHERE direction = 'inflow' AND tx_date >= NOW() - INTERVAL '3 months'
      GROUP BY DATE_TRUNC('month', tx_date)
    ) monthly_totals
  `;
  const avgMonthlyInflow = parseFloat(inflowRow?.avg_monthly || '0');
  const dailyInflow = avgMonthlyInflow / 30;

  // ── 4. Build day-by-day projection ──
  const projections: {
    date: string;
    inflow: number;
    outflow: number;
    balance: number;
    obligations: string[];
  }[] = [];

  let runningBalance = startingBalance;
  let totalInflows = 0;
  let totalOutflows = 0;
  let lowestBalance = startingBalance;
  let lowestBalanceDate = now.toISOString().slice(0, 10);

  for (let d = 0; d < days; d++) {
    const date = new Date(now.getTime() + d * 86400000);
    const dateStr = date.toISOString().slice(0, 10);
    const dayOfMonth = date.getDate();
    const month = date.getMonth();
    const year = date.getFullYear();

    let dayOutflow = 0;
    let dayInflow = dailyInflow;
    const dayObligations: string[] = [];

    for (const ob of obligations) {
      const obDue = new Date(ob.due_date);
      const amount = parseFloat(ob.amount_due || ob.amount_minimum || '0');
      if (amount <= 0) continue;

      // Check if this obligation falls on this date
      let matches = false;

      // One-time: exact date match
      if (!ob.recurrence && obDue.toISOString().slice(0, 10) === dateStr) {
        matches = true;
      }

      // Monthly: matches recurrence_day
      if (ob.recurrence === 'monthly' && ob.recurrence_day === dayOfMonth) {
        // Only if the first occurrence is on or before this date
        if (date >= obDue) matches = true;
      }

      // Quarterly: every 3 months on due date day
      if (ob.recurrence === 'quarterly' && ob.recurrence_day === dayOfMonth) {
        const obMonth = obDue.getMonth();
        if ((month - obMonth) % 3 === 0 && date >= obDue) matches = true;
      }

      // Annual: same month and day
      if (ob.recurrence === 'annual') {
        if (obDue.getMonth() === month && obDue.getDate() === dayOfMonth && date >= obDue) {
          matches = true;
        }
      }

      // Non-recurring, past due but still pending — count on day 0
      if (!ob.recurrence && obDue < now && d === 0) {
        matches = true;
      }

      if (matches) {
        dayOutflow += amount;
        dayObligations.push(ob.payee);
      }
    }

    totalInflows += dayInflow;
    totalOutflows += dayOutflow;
    runningBalance = runningBalance + dayInflow - dayOutflow;

    if (runningBalance < lowestBalance) {
      lowestBalance = runningBalance;
      lowestBalanceDate = dateStr;
    }

    projections.push({
      date: dateStr,
      inflow: Math.round(dayInflow * 100) / 100,
      outflow: Math.round(dayOutflow * 100) / 100,
      balance: Math.round(runningBalance * 100) / 100,
      obligations: dayObligations,
    });
  }

  // ── 5. Clear old projections and write new ones ──
  await sql`DELETE FROM cc_cashflow_projections WHERE generated_at < NOW() - INTERVAL '1 day'`;

  // Batch insert (write weekly summaries + any day with an obligation)
  for (let dayIndex = 0; dayIndex < projections.length; dayIndex++) {
    const p = projections[dayIndex];
    // Write: first day, every 7th day, any day with outflows, last day
    if (dayIndex === 0 || dayIndex % 7 === 0 || p.outflow > 0 || dayIndex === days - 1) {
      await sql`
        INSERT INTO cc_cashflow_projections (projection_date, projected_inflow, projected_outflow, projected_balance, obligations, confidence)
        VALUES (${p.date}, ${p.inflow}, ${p.outflow}, ${p.balance}, ${JSON.stringify(p.obligations)}, ${dayIndex < 30 ? 0.9 : dayIndex < 60 ? 0.7 : 0.5})
      `;
    }
  }

  return {
    starting_balance: startingBalance,
    ending_balance: Math.round(runningBalance * 100) / 100,
    total_inflows: Math.round(totalInflows * 100) / 100,
    total_outflows: Math.round(totalOutflows * 100) / 100,
    days_projected: days,
    lowest_balance: Math.round(lowestBalance * 100) / 100,
    lowest_balance_date: lowestBalanceDate,
  };
}
