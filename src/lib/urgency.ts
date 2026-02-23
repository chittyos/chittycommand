/**
 * Deterministic urgency scoring for obligations.
 * Returns 0-100 score. Higher = more urgent.
 */
export function computeUrgencyScore(obligation: {
  due_date: string;
  category: string;
  status: string;
  auto_pay: boolean;
  late_fee: number | null;
  grace_period_days: number;
}): number {
  let score = 0;
  const now = new Date();
  const due = new Date(obligation.due_date);
  const daysUntilDue = Math.floor((due.getTime() - now.getTime()) / (1000 * 60 * 60 * 24));

  // Time pressure
  if (daysUntilDue < -30) score += 50;       // severely overdue
  else if (daysUntilDue < -7) score += 45;   // overdue > 1 week
  else if (daysUntilDue < 0) score += 40;    // overdue
  else if (daysUntilDue === 0) score += 35;  // due today
  else if (daysUntilDue <= 3) score += 30;   // due in 3 days
  else if (daysUntilDue <= 7) score += 20;   // due in a week
  else if (daysUntilDue <= 14) score += 10;  // due in 2 weeks

  // Consequence severity by category
  const categoryWeights: Record<string, number> = {
    legal: 30,
    mortgage: 25,
    property_tax: 20,
    utility: 15,
    hoa: 12,
    credit_card: 10,
    loan: 10,
    federal_tax: 20,
    subscription: 5,
    insurance: 15,
  };
  score += categoryWeights[obligation.category] || 5;

  // Late fee increases urgency
  if (obligation.late_fee && obligation.late_fee > 50) score += 15;
  else if (obligation.late_fee && obligation.late_fee > 25) score += 10;
  else if (obligation.late_fee && obligation.late_fee > 0) score += 5;

  // Auto-pay reduces urgency (it's handled)
  if (obligation.auto_pay) score -= 25;

  // Already paid or disputed reduces urgency
  if (obligation.status === 'paid') score -= 50;
  if (obligation.status === 'disputed') score -= 10;

  return Math.min(100, Math.max(0, score));
}

export type UrgencyLevel = 'critical' | 'high' | 'medium' | 'low';

export function urgencyLevel(score: number): UrgencyLevel {
  if (score >= 70) return 'critical';
  if (score >= 50) return 'high';
  if (score >= 30) return 'medium';
  return 'low';
}
