import { cn } from '../../lib/utils';

export type ProgressDotsTint = 'default' | 'amber' | 'blue' | 'green';

interface ProgressDotsProps {
  completed: number;
  total: number;
  tint?: ProgressDotsTint;
  className?: string;
}

const TINT_FILLED: Record<ProgressDotsTint, string> = {
  default: 'bg-urgency-green',
  amber: 'bg-urgency-amber',
  blue: 'bg-chitty-400',
  green: 'bg-urgency-green',
};

const TINT_LABEL: Record<ProgressDotsTint, string> = {
  default: 'text-card-muted',
  amber: 'text-urgency-amber',
  blue: 'text-chitty-500',
  green: 'text-urgency-green',
};

export function ProgressDots({ completed, total, tint = 'default', className }: ProgressDotsProps) {
  const safeTotal = Math.max(1, Math.floor(total));
  const safeCompleted = Math.max(0, Math.min(Math.floor(completed), safeTotal));

  return (
    <div className={cn('flex items-center gap-1', className)}>
      {Array.from({ length: safeTotal }, (_, i) => (
        <span
          key={i}
          className={cn(
            'w-2 h-2 rounded-full transition-colors duration-200',
            i < safeCompleted ? TINT_FILLED[tint] : 'bg-card-border',
          )}
        />
      ))}
      <span className={cn('text-xs ml-1', TINT_LABEL[tint])}>
        {safeCompleted}/{safeTotal}
      </span>
    </div>
  );
}
