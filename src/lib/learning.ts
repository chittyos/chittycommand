import type { NeonQueryFunction } from '@neondatabase/serverless';

/**
 * Decision learning engine.
 *
 * Computes confidence scores from historical user decisions in cc_decision_feedback.
 * No ML — simple acceptance-rate aggregation that works with small data.
 *
 * Confidence = blend of base confidence and observed acceptance rate.
 * Requires 5+ decisions for a type before influencing confidence.
 */

const BASE_CONFIDENCE: Record<string, number> = {
  payment: 0.70,
  negotiate: 0.50,
  defer: 0.60,
  dispute: 0.55,
  legal: 0.80,
  warning: 0.65,
  strategy: 0.55,
};

export async function computeConfidence(
  sql: NeonQueryFunction<false, false>,
  recType: string,
  payee?: string,
): Promise<number> {
  const base = BASE_CONFIDENCE[recType] ?? 0.50;

  // Query past decisions for similar rec_type (and optionally payee)
  const rows = await sql`
    SELECT
      df.decision,
      COUNT(*)::int AS cnt
    FROM cc_decision_feedback df
    JOIN cc_recommendations r ON df.recommendation_id = r.id
    WHERE r.rec_type = ${recType}
      AND df.created_at > NOW() - INTERVAL '90 days'
    GROUP BY df.decision
  `;

  let approved = 0;
  let rejected = 0;
  let total = 0;

  for (const row of rows) {
    const r = row as { decision: string; cnt: number };
    total += r.cnt;
    if (r.decision === 'approved') approved += r.cnt;
    if (r.decision === 'rejected') rejected += r.cnt;
  }

  // Not enough data — return base confidence
  if (total < 5) return base;

  const acceptanceRate = approved / (approved + rejected || 1);

  // Blend: 50% base + 50% observed
  const blended = 0.5 * base + 0.5 * acceptanceRate;

  // If we have payee-specific data, refine further
  if (payee) {
    const payeeRows = await sql`
      SELECT df.decision, COUNT(*)::int AS cnt
      FROM cc_decision_feedback df
      JOIN cc_recommendations r ON df.recommendation_id = r.id
      JOIN cc_obligations o ON r.obligation_id = o.id
      WHERE o.payee = ${payee}
        AND df.created_at > NOW() - INTERVAL '90 days'
      GROUP BY df.decision
    `;

    let pApproved = 0;
    let pTotal = 0;

    for (const row of payeeRows) {
      const r = row as { decision: string; cnt: number };
      pTotal += r.cnt;
      if (r.decision === 'approved') pApproved += r.cnt;
    }

    // Only apply payee-specific refinement if enough data
    if (pTotal >= 3) {
      const payeeRate = pApproved / pTotal;
      // 70% type-level + 30% payee-level
      return Math.min(0.99, Math.max(0.10, 0.7 * blended + 0.3 * payeeRate));
    }
  }

  return Math.min(0.99, Math.max(0.10, blended));
}

export async function recordOutcome(
  sql: NeonQueryFunction<false, false>,
  feedbackId: string,
  status: 'succeeded' | 'failed' | 'partial',
): Promise<void> {
  await sql`
    UPDATE cc_decision_feedback
    SET outcome_status = ${status}, outcome_recorded_at = NOW()
    WHERE id = ${feedbackId}::uuid
  `;
}

export async function getDecisionStats(
  sql: NeonQueryFunction<false, false>,
  sessionId?: string,
): Promise<{ approved: number; rejected: number; deferred: number; modified: number; total: number; savings: number }> {
  const whereClause = sessionId
    ? sql`WHERE df.session_id = ${sessionId}::uuid`
    : sql`WHERE df.created_at > NOW() - INTERVAL '24 hours'`;

  const [stats] = await sql`
    SELECT
      COUNT(*) FILTER (WHERE df.decision = 'approved')::int AS approved,
      COUNT(*) FILTER (WHERE df.decision = 'rejected')::int AS rejected,
      COUNT(*) FILTER (WHERE df.decision = 'deferred')::int AS deferred,
      COUNT(*) FILTER (WHERE df.decision = 'modified')::int AS modified,
      COUNT(*)::int AS total,
      COALESCE(SUM(r.estimated_savings) FILTER (WHERE df.decision = 'approved'), 0)::numeric AS savings
    FROM cc_decision_feedback df
    LEFT JOIN cc_recommendations r ON df.recommendation_id = r.id
    ${whereClause}
  `;

  const s = stats as Record<string, number>;
  return {
    approved: s.approved || 0,
    rejected: s.rejected || 0,
    deferred: s.deferred || 0,
    modified: s.modified || 0,
    total: s.total || 0,
    savings: parseFloat(String(s.savings || '0')),
  };
}
