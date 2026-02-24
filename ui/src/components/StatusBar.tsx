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

  // Pick the most recent sync per source for freshness display
  const sourceFreshness = syncs.reduce<Record<string, string | null>>((acc, s) => {
    const current = acc[s.source];
    if (!current || (s.completed_at && s.completed_at > current)) {
      acc[s.source] = s.completed_at;
    }
    return acc;
  }, {});

  return (
    <header className="h-12 bg-chrome-surface border-b border-chrome-border flex items-center justify-between px-4 sticky top-0 z-10">
      <div className="flex items-center gap-6 text-sm">
        {cashPosition && (
          <div className="flex items-center gap-2">
            <span className="text-chrome-muted">Cash</span>
            <span className="text-urgency-green font-mono font-semibold">
              ${parseFloat(cashPosition).toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: 0 })}
            </span>
          </div>
        )}
        {overdueCount && Number(overdueCount) > 0 && (
          <div className="flex items-center gap-2">
            <span className="text-chrome-muted">Overdue</span>
            <span className="text-urgency-red font-mono font-semibold">{overdueCount}</span>
          </div>
        )}
        {dueThisWeek && Number(dueThisWeek) > 0 && (
          <div className="flex items-center gap-2">
            <span className="text-chrome-muted">Due This Week</span>
            <span className="text-urgency-amber font-mono font-semibold">{dueThisWeek}</span>
          </div>
        )}

        {/* Freshness dots */}
        {Object.keys(sourceFreshness).length > 0 && (
          <div className="flex items-center gap-1.5 ml-2">
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
        className="flex items-center gap-2 px-3 py-1.5 rounded-lg text-sm font-medium transition-colors bg-chrome-border/50 hover:bg-chrome-border text-chrome-text"
        title={focusMode ? 'Show full dashboard' : 'Focus on urgent items'}
      >
        {focusMode ? <Eye size={16} /> : <EyeOff size={16} />}
        {focusMode ? 'Focus' : 'Full View'}
      </button>
    </header>
  );
}
