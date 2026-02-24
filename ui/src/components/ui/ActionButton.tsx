import { cn } from '../../lib/utils';

interface ActionButtonProps {
  label: string;
  onClick: () => void;
  variant?: 'primary' | 'secondary' | 'danger';
  loading?: boolean;
  disabled?: boolean;
  className?: string;
}

export function ActionButton({ label, onClick, variant = 'primary', loading, disabled, className }: ActionButtonProps) {
  const base = 'px-4 py-2 text-sm font-medium rounded-lg transition-colors disabled:opacity-50';
  const variants = {
    primary: 'bg-chitty-600 text-white hover:bg-chitty-700',
    secondary: 'bg-card-border text-card-text hover:bg-gray-200',
    danger: 'bg-urgency-red text-white hover:bg-red-600',
  };

  return (
    <button
      onClick={onClick}
      disabled={disabled || loading}
      className={cn(base, variants[variant], className)}
    >
      {loading ? 'Working...' : label}
    </button>
  );
}
