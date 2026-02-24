import { useFocusMode } from '../lib/focus-mode';
import { Eye, EyeOff } from 'lucide-react';

interface StatusBarProps {
  cashPosition?: string;
  nextDue?: string;
}

export function StatusBar({ cashPosition, nextDue }: StatusBarProps) {
  const { focusMode, toggleFocusMode } = useFocusMode();

  return (
    <header className="h-12 bg-chrome-surface border-b border-chrome-border flex items-center justify-between px-4 sticky top-0 z-10">
      <div className="flex items-center gap-6 text-sm">
        {cashPosition && (
          <div className="flex items-center gap-2">
            <span className="text-chrome-muted">Cash</span>
            <span className="text-urgency-green font-mono font-semibold">{cashPosition}</span>
          </div>
        )}
        {nextDue && (
          <div className="flex items-center gap-2">
            <span className="text-chrome-muted">Next Due</span>
            <span className="text-chrome-text font-mono">{nextDue}</span>
          </div>
        )}
      </div>

      <button
        onClick={toggleFocusMode}
        className="flex items-center gap-2 px-3 py-1.5 rounded-lg text-sm font-medium transition-colors bg-chrome-border/50 hover:bg-chrome-border text-chrome-text"
        title={focusMode ? 'Show full dashboard' : 'Focus on urgent items'}
      >
        {focusMode ? <Eye size={16} /> : <EyeOff size={16} />}
        {focusMode ? 'Focus' : 'Full View'}
      </button>
    </header>
  );
}
