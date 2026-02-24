import { cn } from '../../lib/utils';

interface ProgressDotsProps {
  completed: number;
  total: number;
  className?: string;
}

export function ProgressDots({ completed, total, className }: ProgressDotsProps) {
  const safeTotal = Math.max(1, Math.floor(total));
  const safeCompleted = Math.max(0, Math.min(Math.floor(completed), safeTotal));

  return (
    <div className={cn('flex items-center gap-1', className)}>
      {Array.from({ length: safeTotal }, (_, i) => (
        <span
          key={i}
          className={cn(
            'w-2 h-2 rounded-full',
            i < safeCompleted ? 'bg-urgency-green' : 'bg-card-border',
          )}
        />
      ))}
      <span className="text-xs text-card-muted ml-1">
        {safeCompleted}/{safeTotal}
      </span>
    </div>
  );
}
