import { cn } from '../../lib/utils';

type Strategy = 'optimal' | 'conservative' | 'aggressive';

interface StrategySelectorProps {
  value: Strategy;
  onChange: (strategy: Strategy) => void;
  disabled?: boolean;
}

const strategies: { key: Strategy; label: string; description: string; icon: string }[] = [
  { key: 'optimal', label: 'Optimal', description: 'Minimize total cost', icon: '&#9733;' },
  { key: 'conservative', label: 'Conservative', description: 'Never miss a due date', icon: '&#128170;' },
  { key: 'aggressive', label: 'Aggressive', description: 'Maximize cash on hand', icon: '&#9889;' },
];

export function StrategySelector({ value, onChange, disabled }: StrategySelectorProps) {
  return (
    <div className="grid grid-cols-3 gap-2">
      {strategies.map((s) => (
        <button
          key={s.key}
          onClick={() => onChange(s.key)}
          disabled={disabled}
          className={cn(
            'p-3 rounded-lg border text-center transition-colors text-sm',
            value === s.key
              ? 'border-chitty-500 bg-chitty-50 text-chitty-700'
              : 'border-card-border bg-card-bg text-card-muted hover:border-chitty-300',
            disabled && 'opacity-50 cursor-not-allowed',
          )}
        >
          <p className="font-medium text-card-text">{s.label}</p>
          <p className="text-xs mt-0.5">{s.description}</p>
        </button>
      ))}
    </div>
  );
}
