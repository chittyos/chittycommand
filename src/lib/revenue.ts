import type { NeonQueryFunction } from '@neondatabase/serverless';
import { typedRows } from './db';

/**
 * Revenue source discovery engine.
 *
 * Scans real transaction history to identify recurring income patterns.
 * No stubs or estimates — if there's no transaction history, returns zeros.
 *
 * Sources discovered from:
 *   - Mercury checking/savings inflows (payroll, client payments)
 *   - Stripe payouts (revenue)
 *   - Any recurring inflow pattern from cc_transactions
 */

export interface RevenueDiscoveryResult {
  sources_discovered: number;
  sources_updated: number;
  total_monthly_expected: number;
}

interface InflowPattern {
  counterparty: string;
  account_id: string;
  avg_amount: number;
  occurrence_count: number;
  months_span: number;
  min_amount: number;
  max_amount: number;
  last_date: string;
  source: string;
}

// Known revenue platforms with pre-assigned confidence levels.
// Counterparty names are matched case-insensitively via ILIKE/includes.
const KNOWN_REVENUE_PLATFORMS: Record<string, number> = {
  'AIRBNB': 0.95,
  'TURBOTENANT': 0.95,
  'DOORLOOP': 0.90,
  'VENMO': 0.60,       // could be personal or business
  'CHECK DEPOSIT': 0.75, // likely tenant/client checks
};

function getPlatformConfidence(counterparty: string): { confidence: number; verified: boolean } | null {
  const upper = counterparty.toUpperCase();
  for (const [platform, conf] of Object.entries(KNOWN_REVENUE_PLATFORMS)) {
    if (upper.includes(platform)) return { confidence: conf, verified: true };
  }
  return null;
}

export async function discoverRevenueSources(
  sql: NeonQueryFunction<false, false>,
): Promise<RevenueDiscoveryResult> {
  // Find recurring inflow patterns from the last 6 months of real transaction data.
  // Excludes internal Mercury transfers, auto-transfer rules, bank-to-bank moves,
  // cashback credits, and counterparties matching internal Mercury account names.
  const patterns = typedRows<InflowPattern>(await sql`
    WITH monthly_inflows AS (
      SELECT
        t.counterparty,
        t.account_id,
        a.source,
        DATE_TRUNC('month', t.tx_date::date) AS month,
        SUM(t.amount::numeric) AS monthly_total,
        COUNT(*) AS tx_count
      FROM cc_transactions t
      JOIN cc_accounts a ON t.account_id = a.id
      WHERE t.direction = 'inflow'
        AND t.tx_date::date >= CURRENT_DATE - INTERVAL '6 months'
        AND t.counterparty IS NOT NULL
        AND t.counterparty != ''
        -- Exclude internal Mercury transfers
        AND t.description NOT LIKE 'Transfer between your Mercury%'
        -- Exclude Mercury auto-transfer rules
        AND t.description NOT LIKE 'Percentage-based%auto-transfer'
        -- Exclude external bank-to-bank transfers (not revenue)
        AND t.description NOT LIKE 'Transfer from another bank%'
        -- Exclude cashback credits
        AND t.description != 'Mercury IO Cashback'
        -- Exclude counterparties that match internal Mercury account names
        AND NOT EXISTS (
          SELECT 1 FROM cc_accounts ia
          WHERE ia.source = 'mercury'
            AND t.counterparty ILIKE ia.account_name
        )
        -- Exclude transactions tagged as internal transfers via Mercury kind
        AND COALESCE(t.metadata->>'mercury_kind', '') NOT IN ('internalTransfer', 'externalTransfer')
      GROUP BY t.counterparty, t.account_id, a.source, DATE_TRUNC('month', t.tx_date::date)
    )
    SELECT
      counterparty,
      account_id,
      source,
      ROUND(AVG(monthly_total)::numeric, 2) AS avg_amount,
      COUNT(DISTINCT month)::int AS occurrence_count,
      COALESCE(EXTRACT(MONTH FROM AGE(MAX(month), MIN(month)))::int, 0) + 1 AS months_span,
      ROUND(MIN(monthly_total)::numeric, 2) AS min_amount,
      ROUND(MAX(monthly_total)::numeric, 2) AS max_amount,
      MAX(month)::text AS last_date
    FROM monthly_inflows
    GROUP BY counterparty, account_id, source
    HAVING COUNT(DISTINCT month) >= 2
    ORDER BY AVG(monthly_total) DESC
  `);

  let discovered = 0;
  let updated = 0;
  let totalMonthly = 0;

  for (const raw of patterns) {
    // Parse numeric fields (Neon returns strings for numeric/rounded columns)
    const p = {
      ...raw,
      avg_amount: typeof raw.avg_amount === 'string' ? parseFloat(raw.avg_amount) : raw.avg_amount,
      min_amount: typeof raw.min_amount === 'string' ? parseFloat(raw.min_amount) : raw.min_amount,
      max_amount: typeof raw.max_amount === 'string' ? parseFloat(raw.max_amount) : raw.max_amount,
      occurrence_count: typeof raw.occurrence_count === 'string' ? parseInt(raw.occurrence_count, 10) : raw.occurrence_count,
      months_span: typeof raw.months_span === 'string' ? parseInt(raw.months_span, 10) : raw.months_span,
    };

    // Compute confidence from consistency + known platform matching
    const amountVariance = p.max_amount > 0 ? (p.max_amount - p.min_amount) / p.max_amount : 0;
    let confidence: number;
    let verifiedBy = 'transaction_history';

    // Check if counterparty matches a known revenue platform
    const platformMatch = getPlatformConfidence(p.counterparty);

    if (platformMatch) {
      // Known platform — use platform confidence as floor, history can push higher
      confidence = platformMatch.confidence;
      verifiedBy = 'validated_match';
      // Boost further if history is very consistent
      if (p.occurrence_count >= 5 && amountVariance < 0.1 && confidence < 0.95) {
        confidence = 0.95;
      }
    } else if (p.occurrence_count >= 5 && amountVariance < 0.1) {
      confidence = 0.90; // Very consistent unknown source
    } else if (p.occurrence_count >= 3 && amountVariance < 0.25) {
      confidence = 0.80; // Regular with some variation
    } else if (p.occurrence_count >= 3) {
      confidence = 0.65; // Regular but varying amounts
    } else {
      confidence = 0.45; // Only 2 occurrences — uncertain
    }

    // Determine recurrence
    const recurrence = p.occurrence_count >= 3 ? 'monthly' : 'irregular';

    // Check if we already track this source
    const [existing] = await sql`
      SELECT id FROM cc_revenue_sources
      WHERE source = ${p.source}
        AND description = ${p.counterparty}
        AND account_id = ${p.account_id}::uuid
      LIMIT 1
    `;

    if (existing) {
      // Update with latest data
      await sql`
        UPDATE cc_revenue_sources SET
          amount = ${p.avg_amount},
          confidence = ${confidence},
          recurrence = ${recurrence},
          verified_by = ${verifiedBy},
          next_expected_date = (${p.last_date}::date + INTERVAL '1 month')::date,
          updated_at = NOW()
        WHERE id = ${(existing as { id: string }).id}::uuid
      `;
      updated++;
    } else {
      // Discover new source
      await sql`
        INSERT INTO cc_revenue_sources (source, description, amount, recurrence, next_expected_date, confidence, verified_by, account_id)
        VALUES (
          ${p.source},
          ${p.counterparty},
          ${p.avg_amount},
          ${recurrence},
          (${p.last_date}::date + INTERVAL '1 month')::date,
          ${confidence},
          ${verifiedBy},
          ${p.account_id}::uuid
        )
      `;
      discovered++;
    }

    totalMonthly += p.avg_amount;
  }

  return {
    sources_discovered: discovered,
    sources_updated: updated,
    total_monthly_expected: Math.round(totalMonthly * 100) / 100,
  };
}
