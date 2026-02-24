import { cn } from '../../lib/utils';

interface ProgressDotsProps {
  completed: number;
  total: number;
  className?: string;
}

export function ProgressDots({ completed, total, className }: ProgressDotsProps) {
  return (
    <div className={cn('flex items-center gap-1', className)}>
      {Array.from({ length: total }, (_, i) => (
        <span
          key={i}
          className={cn(
            'w-2 h-2 rounded-full',
            i < completed ? 'bg-urgency-green' : 'bg-card-border',
          )}
        />
      ))}
      <span className="text-xs text-card-muted ml-1">
        {completed}/{total}
      </span>
    </div>
  );
}
