import { useState } from 'react';
import type { SyncStatus, QueueStats } from '../../lib/api';
import { api } from '../../lib/api';
import { useToast } from '../../lib/toast';
import { RefreshCw } from 'lucide-react';

interface SystemPulseProps {
  syncs: SyncStatus[];
  queueStats: QueueStats | null;
  onSyncTriggered: () => void;
}

function timeAgo(dateStr: string | null): string {
  if (!dateStr) return 'never';
  const diff = Date.now() - new Date(dateStr).getTime();
  const mins = Math.floor(diff / 60_000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

function freshnessColor(dateStr: string | null): string {
  if (!dateStr) return 'bg-chrome-border';
  const hours = (Date.now() - new Date(dateStr).getTime()) / 3_600_000;
  if (hours < 6) return 'bg-urgency-green shadow-[0_0_4px_rgba(16,185,129,0.4)]';
  if (hours < 24) return 'bg-urgency-amber shadow-[0_0_4px_rgba(245,158,11,0.3)]';
  return 'bg-urgency-red shadow-[0_0_4px_rgba(244,63,94,0.3)]';
}

function statusLabel(status: string): { text: string; color: string } {
  switch (status) {
    case 'completed': return { text: 'OK', color: 'text-urgency-green' };
    case 'started': return { text: 'RUNNING', color: 'text-urgency-amber' };
    case 'error': return { text: 'FAILED', color: 'text-urgency-red' };
    default: return { text: 'PENDING', color: 'text-chrome-muted' };
  }
}

// Deduplicate syncs — keep the most recent per source
function deduplicateSyncs(syncs: SyncStatus[]): SyncStatus[] {
  const map = new Map<string, SyncStatus>();
  for (const s of syncs) {
    const existing = map.get(s.source);
    if (!existing) {
      map.set(s.source, s);
      continue;
    }
    const existingTime = existing.completed_at || existing.started_at;
    const newTime = s.completed_at || s.started_at;
    if (newTime && (!existingTime || newTime > existingTime)) {
      map.set(s.source, s);
    }
  }
  return Array.from(map.values());
}

const CRON_SCHEDULE = [
  { label: 'Plaid + Finance sync', time: '6:00 AM CT', schedule: 'Daily' },
  { label: 'Court docket check', time: '7:00 AM CT', schedule: 'Daily' },
  { label: 'Utility scrapers', time: '8:00 AM CT', schedule: 'Mon' },
  { label: 'Mortgage + tax', time: '9:00 AM CT', schedule: '1st' },
];

export function SystemPulse({ syncs, queueStats, onSyncTriggered }: SystemPulseProps) {
  const [triggeringSource, setTriggeringSource] = useState<string | null>(null);
  const toast = useToast();

  const uniqueSyncs = deduplicateSyncs(syncs);
  const failedSyncs = uniqueSyncs.filter(s => s.status === 'error');
  const runningSyncs = uniqueSyncs.filter(s => s.status === 'started');

  const triggerSync = async (source: string) => {
    setTriggeringSource(source);
    try {
      await api.triggerSync(source);
      toast.success('Sync triggered', source);
      onSyncTriggered();
    } catch (e: unknown) {
      toast.error('Sync failed', e instanceof Error ? e.message : 'Unknown error');
    } finally {
      setTriggeringSource(null);
    }
  };

  return (
    <div className="space-y-3">
      {/* System Health Summary */}
      <div className="pulse-card">
        <h3 className="pulse-heading">System Pulse</h3>

        {/* Sync status rows */}
        <div className="space-y-0">
          {uniqueSyncs.length > 0 ? uniqueSyncs
            .sort((a, b) => {
              // Failed first, then by recency
              if (a.status === 'error' && b.status !== 'error') return -1;
              if (b.status === 'error' && a.status !== 'error') return 1;
              const aTime = a.completed_at || a.started_at;
              const bTime = b.completed_at || b.started_at;
              return (bTime || '').localeCompare(aTime || '');
            })
            .map(s => {
              const st = statusLabel(s.status);
              return (
                <div key={s.source} className="pulse-row group">
                  <div className="flex items-center gap-2 min-w-0 flex-1">
                    <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${freshnessColor(s.completed_at)}`} />
                    <span className="text-chrome-text text-xs font-medium truncate">{formatSourceName(s.source)}</span>
                  </div>
                  <span className={`text-[9px] font-mono font-semibold uppercase tracking-wider ${st.color}`}>{st.text}</span>
                  <span className="text-chrome-muted text-[10px] font-mono tabular-nums w-14 text-right">{timeAgo(s.completed_at)}</span>
                  {s.status === 'error' && (
                    <button
                      onClick={() => triggerSync(s.source)}
                      disabled={triggeringSource === s.source}
                      className="opacity-0 group-hover:opacity-100 transition-opacity p-1 rounded-md hover:bg-chrome-border/40 text-chrome-muted hover:text-chrome-text"
                      title="Retry sync"
                    >
                      <RefreshCw size={10} className={triggeringSource === s.source ? 'animate-spin' : ''} />
                    </button>
                  )}
                </div>
              );
            })
          : (
            <p className="text-chrome-muted text-xs py-2">No sync data yet</p>
          )}
        </div>

        {/* Failed syncs callout */}
        {failedSyncs.length > 0 && (
          <div className="mt-2 px-2.5 py-2 rounded-lg bg-urgency-red/5 border border-urgency-red/10">
            <p className="text-urgency-red text-[10px] font-mono font-semibold uppercase tracking-wider">
              {failedSyncs.length} source{failedSyncs.length > 1 ? 's' : ''} failing
            </p>
            <p className="text-chrome-muted text-[10px] mt-0.5">
              {failedSyncs.map(s => formatSourceName(s.source)).join(', ')}
            </p>
          </div>
        )}

        {/* Running syncs */}
        {runningSyncs.length > 0 && (
          <div className="mt-2 px-2.5 py-2 rounded-lg bg-urgency-amber/5 border border-urgency-amber/10">
            <div className="flex items-center gap-2">
              <RefreshCw size={10} className="text-urgency-amber animate-spin" />
              <p className="text-urgency-amber text-[10px] font-mono font-semibold uppercase tracking-wider">
                Syncing {runningSyncs.map(s => formatSourceName(s.source)).join(', ')}
              </p>
            </div>
          </div>
        )}
      </div>

      {/* Queue Intelligence */}
      {queueStats && queueStats.total > 0 && (
        <div className="pulse-card">
          <h3 className="pulse-heading">Intelligence</h3>
          <div className="grid grid-cols-2 gap-x-4 gap-y-1">
            <PulseStat label="Reviewed" value={String(queueStats.approved + queueStats.rejected + queueStats.deferred)} />
            <PulseStat label="Approved" value={String(queueStats.approved)} color="text-urgency-green" />
            <PulseStat label="Rejected" value={String(queueStats.rejected)} color="text-urgency-red" />
            <PulseStat label="Deferred" value={String(queueStats.deferred)} color="text-urgency-amber" />
            {queueStats.savings > 0 && (
              <PulseStat label="Savings ID'd" value={`$${queueStats.savings.toLocaleString()}`} color="text-urgency-green" />
            )}
            <PulseStat label="Pending" value={String(Math.max(0, queueStats.total - queueStats.approved - queueStats.rejected - queueStats.deferred))} />
          </div>
        </div>
      )}

      {/* Cron Schedule */}
      <div className="pulse-card">
        <h3 className="pulse-heading">Automation Schedule</h3>
        <div className="space-y-0">
          {CRON_SCHEDULE.map(cron => (
            <div key={cron.label} className="pulse-row">
              <span className="text-chrome-text text-xs flex-1 truncate">{cron.label}</span>
              <span className="text-chrome-muted text-[10px] font-mono">{cron.schedule}</span>
              <span className="text-chrome-muted text-[10px] font-mono w-16 text-right">{cron.time}</span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

function PulseStat({ label, value, color }: { label: string; value: string; color?: string }) {
  return (
    <div className="flex items-center justify-between py-1">
      <span className="text-chrome-muted text-[10px] font-mono uppercase tracking-wider">{label}</span>
      <span className={`text-xs font-bold font-mono tabular-nums ${color || 'text-chrome-text'}`}>{value}</span>
    </div>
  );
}

function formatSourceName(source: string): string {
  const names: Record<string, string> = {
    mercury: 'Mercury',
    wave: 'Wave',
    stripe: 'Stripe',
    plaid: 'Plaid',
    turbotenant: 'TurboTenant',
    comed: 'ComEd',
    peoples_gas: 'Peoples Gas',
    xfinity: 'Xfinity',
    mr_cooper: 'Mr. Cooper',
    citi: 'Citi',
    home_depot: 'Home Depot',
    lowes: "Lowe's",
    cook_county_tax: 'Cook County Tax',
    court_docket: 'Court Docket',
    notion_tasks: 'Notion Tasks',
    notion_disputes: 'Notion Disputes',
    chittyfinance: 'ChittyFinance',
  };
  return names[source] || source.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
}
