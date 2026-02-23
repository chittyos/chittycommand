import type { NeonQueryFunction } from '@neondatabase/serverless';
import { typedRows } from './db';

/**
 * Transaction-to-obligation matching engine.
 *
 * Scans recent unmatched transactions and attempts to match them against
 * pending/overdue obligations by:
 *   1. Payee name similarity (fuzzy match)
 *   2. Amount match (exact or within threshold)
 *   3. Date proximity (transaction near due date)
 *
 * When matched, marks the obligation as paid and links the transaction.
 */

export interface MatchResult {
  transactions_scanned: number;
  matches_found: number;
  obligations_marked_paid: number;
  matches: { transaction_id: string; obligation_id: string; payee: string; amount: number; confidence: number }[];
}

interface Transaction {
  id: string;
  account_id: string;
  source: string;
  amount: string;
  direction: string;
  description: string;
  counterparty: string | null;
  category: string | null;
  tx_date: string;
}

interface Obligation {
  id: string;
  payee: string;
  amount_due: string | null;
  amount_minimum: string | null;
  due_date: string;
  status: string;
  category: string;
}

export async function matchTransactions(sql: NeonQueryFunction<false, false>): Promise<MatchResult> {
  // Get recent unlinked outflow transactions (last 30 days)
  const transactions = typedRows<Transaction>(await sql`
    SELECT t.* FROM cc_transactions t
    WHERE t.direction = 'outflow'
      AND t.obligation_id IS NULL
      AND t.tx_date >= NOW() - INTERVAL '30 days'
    ORDER BY t.tx_date DESC
    LIMIT 200
  `);

  // Get all pending/overdue obligations
  const obligations = typedRows<Obligation>(await sql`
    SELECT * FROM cc_obligations
    WHERE status IN ('pending', 'overdue')
    ORDER BY due_date ASC
  `);

  const matches: MatchResult['matches'] = [];
  const matchedObligationIds = new Set<string>();

  for (const tx of transactions) {
    const txAmount = parseFloat(tx.amount);
    const txDesc = normalize(tx.description);
    const txCounterparty = tx.counterparty ? normalize(tx.counterparty) : '';

    let bestMatch: { obligation: Obligation; confidence: number } | null = null;

    for (const ob of obligations) {
      if (matchedObligationIds.has(ob.id)) continue;

      const obPayee = normalize(ob.payee);
      const obAmount = parseFloat(ob.amount_due || ob.amount_minimum || '0');

      // Score: payee name similarity
      const nameScore = computeNameScore(txDesc, txCounterparty, obPayee);
      if (nameScore < 0.3) continue; // Skip if names don't match at all

      // Score: amount proximity
      const amountScore = computeAmountScore(txAmount, obAmount);

      // Score: date proximity (transaction should be near due date)
      const dateScore = computeDateScore(tx.tx_date, ob.due_date);

      // Combined confidence (weighted)
      const confidence = (nameScore * 0.5) + (amountScore * 0.35) + (dateScore * 0.15);

      if (confidence > 0.6 && (!bestMatch || confidence > bestMatch.confidence)) {
        bestMatch = { obligation: ob, confidence };
      }
    }

    if (bestMatch) {
      matchedObligationIds.add(bestMatch.obligation.id);
      matches.push({
        transaction_id: tx.id,
        obligation_id: bestMatch.obligation.id,
        payee: bestMatch.obligation.payee,
        amount: txAmount,
        confidence: Math.round(bestMatch.confidence * 100),
      });
    }
  }

  // Apply matches: link transactions and mark obligations paid
  let obligationsPaid = 0;
  for (const match of matches) {
    // Link transaction to obligation
    await sql`
      UPDATE cc_transactions SET obligation_id = ${match.obligation_id}
      WHERE id = ${match.transaction_id}
    `;

    // Mark obligation as paid
    await sql`
      UPDATE cc_obligations SET
        status = 'paid',
        urgency_score = 0,
        updated_at = NOW()
      WHERE id = ${match.obligation_id} AND status IN ('pending', 'overdue')
    `;
    obligationsPaid++;

    // Log the auto-match
    await sql`
      INSERT INTO cc_actions_log (action_type, target_type, target_id, description, status, metadata)
      VALUES ('auto_match', 'obligation', ${match.obligation_id},
        ${'Auto-matched payment to ' + match.payee + ' ($' + match.amount.toFixed(2) + ', ' + match.confidence + '% confidence)'},
        'completed',
        ${JSON.stringify({ transaction_id: match.transaction_id, confidence: match.confidence })})
    `;
  }

  return {
    transactions_scanned: transactions.length,
    matches_found: matches.length,
    obligations_marked_paid: obligationsPaid,
    matches,
  };
}

/** Normalize a string for comparison: lowercase, strip non-alphanumeric */
function normalize(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9\s]/g, '').replace(/\s+/g, ' ').trim();
}

/** Compute name similarity score between transaction description/counterparty and obligation payee */
function computeNameScore(txDesc: string, txCounterparty: string, obPayee: string): number {
  // Extract key words from payee (e.g., "Mr. Cooper - 541 W Addison" → ["mr", "cooper", "addison"])
  const payeeTokens = obPayee.split(/\s+/).filter(t => t.length > 2);

  // Check counterparty first (more reliable)
  if (txCounterparty) {
    const counterTokens = txCounterparty.split(/\s+/);
    const counterMatch = payeeTokens.filter(pt =>
      counterTokens.some(ct => ct.includes(pt) || pt.includes(ct))
    ).length / payeeTokens.length;
    if (counterMatch > 0.4) return Math.min(1, counterMatch + 0.2);
  }

  // Fall back to description
  const descTokens = txDesc.split(/\s+/);
  const descMatch = payeeTokens.filter(pt =>
    descTokens.some(dt => dt.includes(pt) || pt.includes(dt))
  ).length / payeeTokens.length;

  return descMatch;
}

/** Compute amount proximity score (1.0 = exact match, 0 = way off) */
function computeAmountScore(txAmount: number, obAmount: number): number {
  if (obAmount === 0) return 0.5; // No amount set — neutral
  if (txAmount === obAmount) return 1.0;

  const ratio = Math.min(txAmount, obAmount) / Math.max(txAmount, obAmount);
  // Within 5% → high score, within 20% → decent, otherwise low
  if (ratio >= 0.95) return 0.95;
  if (ratio >= 0.80) return 0.7;
  if (ratio >= 0.50) return 0.3;
  return 0.1;
}

/** Compute date proximity score (transaction near due date = high score) */
function computeDateScore(txDate: string, dueDate: string): number {
  const tx = new Date(txDate);
  const due = new Date(dueDate);
  const daysDiff = Math.abs(Math.floor((tx.getTime() - due.getTime()) / 86400000));

  if (daysDiff <= 3) return 1.0;
  if (daysDiff <= 7) return 0.8;
  if (daysDiff <= 14) return 0.5;
  if (daysDiff <= 30) return 0.3;
  return 0.1;
}
