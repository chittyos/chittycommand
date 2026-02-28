import { useEffect, useState } from 'react';
import { useFocusMode } from '../lib/focus-mode';
import { api, type DashboardData, type SyncStatus } from '../lib/api';
import { FreshnessDot, freshnessFromDate } from './ui/FreshnessDot';
import { Eye, EyeOff } from 'lucide-react';

export function StatusBar() {
  const { focusMode, toggleFocusMode } = useFocusMode();
  const [data, setData] = useState<DashboardData | null>(null);
  const [syncs, setSyncs] = useState<SyncStatus[]>([]);

  useEffect(() => {
    api.getDashboard().then(setData).catch((e) => console.error('[StatusBar] dashboard load failed:', e));
    api.getSyncStatus().then(setSyncs).catch((e) => console.error('[StatusBar] sync status load failed:', e));
  }, []);

  const cashPosition = data?.summary?.total_cash;
  const overdueCount = data?.obligations?.overdue_count;
  const dueThisWeek = data?.obligations?.due_this_week;

  const sourceFreshness = syncs.reduce<Record<string, string | null>>((acc, s) => {
    const current = acc[s.source];
    if (!current || (s.completed_at && s.completed_at > current)) {
      acc[s.source] = s.completed_at;
    }
    return acc;
  }, {});

  return (
    <header className="h-11 lg:h-12 bg-chrome-surface/90 backdrop-blur-md border-b border-chrome-border flex items-center justify-between px-3 lg:px-4 sticky top-0 lg:top-0 z-10">
      {/* Metrics — horizontally scrollable on mobile */}
      <div className="flex items-center gap-3 lg:gap-6 text-xs lg:text-sm overflow-x-auto scrollbar-hide flex-1 min-w-0">
        {cashPosition && (
          <div className="flex items-center gap-1.5 shrink-0">
            <span className="text-chrome-muted hidden sm:inline text-[10px] uppercase tracking-wider font-medium">Cash</span>
            <span className="text-urgency-green font-mono font-semibold">
              ${Number(cashPosition).toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: 0 })}
            </span>
          </div>
        )}
        {overdueCount && Number(overdueCount) > 0 && (
          <div className="flex items-center gap-1.5 shrink-0">
            <span className="text-chrome-muted hidden sm:inline text-[10px] uppercase tracking-wider font-medium">Overdue</span>
            <span className="text-urgency-red font-mono font-semibold animate-pulse-glow">{overdueCount}</span>
          </div>
        )}
        {dueThisWeek && Number(dueThisWeek) > 0 && (
          <div className="flex items-center gap-1.5 shrink-0">
            <span className="text-chrome-muted hidden sm:inline text-[10px] uppercase tracking-wider font-medium">This Week</span>
            <span className="text-urgency-amber font-mono font-semibold">{dueThisWeek}</span>
          </div>
        )}

        {/* Freshness dots */}
        {Object.keys(sourceFreshness).length > 0 && (
          <div className="hidden sm:flex items-center gap-1.5 ml-1">
            {Object.entries(sourceFreshness).map(([source, lastSync]) => (
              <span key={source} title={source}>
                <FreshnessDot status={freshnessFromDate(lastSync)} />
              </span>
            ))}
          </div>
        )}
      </div>

      <button
        onClick={toggleFocusMode}
        className="flex items-center gap-1.5 px-3 py-1.5 rounded-xl text-xs lg:text-sm font-semibold transition-all duration-200 shrink-0 ml-2 border border-chrome-border hover:border-chitty-500/40 hover:shadow-glow-brand text-chrome-text"
        title={focusMode ? 'Show full dashboard' : 'Focus on urgent items'}
      >
        {focusMode ? <Eye size={14} /> : <EyeOff size={14} />}
        <span className="hidden sm:inline">{focusMode ? 'Focus' : 'Full'}</span>
      </button>
    </header>
  );
}
