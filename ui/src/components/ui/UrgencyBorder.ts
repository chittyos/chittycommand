export function urgencyLevel(score: number | null): 'red' | 'amber' | 'green' | null {
  if (score === null || score === undefined) return null;
  if (score >= 70) return 'red';
  if (score >= 40) return 'amber';
  return 'green';
}

export function urgencyFromDays(days: number): 'red' | 'amber' | 'green' {
  if (days <= 2) return 'red';
  if (days <= 7) return 'amber';
  return 'green';
}
