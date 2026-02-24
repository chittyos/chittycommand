import { cn } from '../../lib/utils';

interface MetricCardProps {
  label: string;
  value: string;
  trend?: 'up' | 'down' | null;
  className?: string;
  valueClassName?: string;
}

export function MetricCard({ label, value, trend, className, valueClassName }: MetricCardProps) {
  return (
    <div className={cn('bg-card-bg rounded-card border border-card-border p-4', className)}>
      <p className="text-card-muted text-xs uppercase tracking-wider font-medium">{label}</p>
      <div className="flex items-baseline gap-1 mt-1">
        <p className={cn('text-2xl font-bold font-mono', valueClassName || 'text-card-text')}>{value}</p>
        {trend === 'up' && <span className="text-urgency-green text-sm">&#9650;</span>}
        {trend === 'down' && <span className="text-urgency-red text-sm">&#9660;</span>}
      </div>
    </div>
  );
}
