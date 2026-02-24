import { cn } from '../../lib/utils';

interface FreshnessDotProps {
  status: 'fresh' | 'stale' | 'failed' | 'unknown';
  className?: string;
}

export function FreshnessDot({ status, className }: FreshnessDotProps) {
  const color = status === 'fresh'
    ? 'bg-urgency-green'
    : status === 'stale'
    ? 'bg-urgency-amber'
    : status === 'failed'
    ? 'bg-urgency-red'
    : 'bg-chrome-muted';

  return <span className={cn('inline-block w-2 h-2 rounded-full', color, className)} />;
}

export function freshnessFromDate(dateStr: string | null): 'fresh' | 'stale' | 'failed' | 'unknown' {
  if (!dateStr) return 'unknown';
  const hours = (Date.now() - new Date(dateStr).getTime()) / (1000 * 60 * 60);
  if (hours < 24) return 'fresh';
  if (hours < 72) return 'stale';
  return 'failed';
}
