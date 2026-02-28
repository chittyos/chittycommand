import { cn } from '../../lib/utils';

interface MetricCardProps {
  label: string;
  value: string;
  trend?: 'up' | 'down' | null;
  className?: string;
  valueClassName?: string;
}

export function MetricCard({ label, value, trend, className, valueClassName }: MetricCardProps) {
  const gradientClass = valueClassName?.includes('green')
    ? 'metric-green'
    : valueClassName?.includes('red')
    ? 'metric-red'
    : valueClassName?.includes('amber')
    ? 'metric-amber'
    : '';

  return (
    <div className={cn(
      'glass-card rounded-card border p-3 lg:p-4 animate-fade-in-up transition-all duration-200 hover:-translate-y-0.5 hover:shadow-card-hover',
      gradientClass,
      className,
    )}>
      <p className="text-card-muted text-[10px] lg:text-xs uppercase tracking-widest font-semibold">{label}</p>
      <div className="flex items-baseline gap-1.5 mt-1 lg:mt-1.5">
        <p className={cn('text-xl lg:text-2xl font-bold font-mono tracking-tight', valueClassName || 'text-card-text')}>{value}</p>
        {trend === 'up' && <span className="text-urgency-green text-xs lg:text-sm">&#9650;</span>}
        {trend === 'down' && <span className="text-urgency-red text-xs lg:text-sm">&#9660;</span>}
      </div>
    </div>
  );
}
