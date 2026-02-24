import { cn } from '../../lib/utils';

interface CardProps {
  children: React.ReactNode;
  className?: string;
  urgency?: 'red' | 'amber' | 'green' | null;
  muted?: boolean;
  onClick?: () => void;
}

export function Card({ children, className, urgency, muted, onClick }: CardProps) {
  const borderColor = urgency === 'red'
    ? 'border-l-urgency-red'
    : urgency === 'amber'
    ? 'border-l-urgency-amber'
    : urgency === 'green'
    ? 'border-l-urgency-green'
    : 'border-l-transparent';

  return (
    <div
      onClick={onClick}
      className={cn(
        'bg-card-bg rounded-card border border-card-border p-4 border-l-4 transition-shadow',
        borderColor,
        muted && 'opacity-60',
        onClick && 'cursor-pointer hover:shadow-md',
        className,
      )}
    >
      {children}
    </div>
  );
}
