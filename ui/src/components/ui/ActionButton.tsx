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
  const base = 'px-4 py-2 text-sm font-semibold rounded-xl transition-all duration-200 disabled:opacity-50 focus-ring';
  const variants = {
    primary: 'bg-gradient-to-b from-chitty-500 to-chitty-600 text-white hover:from-chitty-400 hover:to-chitty-500 shadow-sm hover:shadow-glow-brand active:scale-[0.97]',
    secondary: 'bg-card-hover text-card-text border border-card-border hover:border-chitty-300 hover:bg-white active:scale-[0.97]',
    danger: 'bg-gradient-to-b from-urgency-red to-rose-600 text-white hover:from-rose-400 hover:to-rose-500 shadow-sm hover:shadow-glow-danger active:scale-[0.97]',
  };

  return (
    <button
      onClick={onClick}
      disabled={disabled || loading}
      className={cn(base, variants[variant], className)}
    >
      {loading ? (
        <span className="flex items-center gap-2">
          <span className="w-3.5 h-3.5 border-2 border-white/30 border-t-white rounded-full animate-spin" />
          Working...
        </span>
      ) : label}
    </button>
  );
}
