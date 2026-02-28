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
        'glass-card rounded-card p-4 border-l-4 transition-all duration-200',
        borderColor,
        muted && 'opacity-60',
        onClick && 'cursor-pointer hover:shadow-card-hover hover:-translate-y-0.5',
        className,
      )}
    >
      {children}
    </div>
  );
}
