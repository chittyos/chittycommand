import type { DashboardData, SyncStatus } from '../../lib/api';
import { daysUntil } from '../../lib/utils';

interface VitalSignsProps {
  data: DashboardData;
  syncs: SyncStatus[];
}

function formatCompact(value: number): string {
  if (Math.abs(value) >= 1_000_000) return `$${(value / 1_000_000).toFixed(1)}M`;
  if (Math.abs(value) >= 1_000) return `$${(value / 1_000).toFixed(1)}k`;
  return `$${value.toFixed(0)}`;
}

export function VitalSigns({ data, syncs }: VitalSignsProps) {
  const { summary, obligations } = data;

  const cash = parseFloat(summary.total_cash) || 0;
  const due30d = parseFloat(obligations.total_due_30d) || 0;
  const runwayDays = due30d > 0 ? Math.floor((cash / due30d) * 30) : 999;
  const overdueCount = parseInt(obligations.overdue_count) || 0;
  const activeDisputes = data.disputes.filter(d => d.status !== 'resolved').length;
  const urgentDeadlines = data.deadlines.filter(dl => {
    const days = daysUntil(dl.deadline_date);
    return days <= 14;
  }).length;

  // System health from sync statuses
  const totalSyncs = Math.max(syncs.length, 1);
  const healthySyncs = syncs.filter(s => s.status === 'completed').length;
  const failedSyncs = syncs.filter(s => s.status === 'error').length;
  const systemHealthPct = Math.round((healthySyncs / totalSyncs) * 100);

  const runwayColor = runwayDays < 30 ? 'text-urgency-red' : runwayDays < 90 ? 'text-urgency-amber' : 'text-urgency-green';
  const systemColor = failedSyncs > 0 ? 'text-urgency-red' : systemHealthPct >= 80 ? 'text-urgency-green' : 'text-urgency-amber';

  return (
    <div className="vital-signs-strip animate-fade-in">
      <Vital label="CASH" value={formatCompact(cash)} color="text-urgency-green" />
      <VitalDivider />
      <Vital label="30D OUT" value={formatCompact(due30d)} color="text-urgency-red" />
      <VitalDivider />
      <Vital label="RUNWAY" value={runwayDays > 365 ? '365d+' : `${runwayDays}d`} color={runwayColor} />
      <VitalDivider />
      <Vital
        label="OVERDUE"
        value={String(overdueCount)}
        color={overdueCount > 0 ? 'text-urgency-red' : 'text-urgency-green'}
        dot={overdueCount > 0 ? 'red' : 'green'}
        pulse={overdueCount > 0}
      />
      <VitalDivider />
      <Vital
        label="DISPUTES"
        value={String(activeDisputes)}
        color={activeDisputes > 0 ? 'text-urgency-amber' : 'text-chrome-muted'}
        dot={activeDisputes > 0 ? 'amber' : undefined}
      />
      {urgentDeadlines > 0 && (
        <>
          <VitalDivider />
          <Vital
            label="DEADLINES"
            value={String(urgentDeadlines)}
            color="text-urgency-red"
            dot="red"
            pulse
          />
        </>
      )}
      <VitalDivider />
      <Vital
        label="SYS"
        value={failedSyncs > 0 ? `${failedSyncs} FAIL` : `${systemHealthPct}%`}
        color={systemColor}
        dot={failedSyncs > 0 ? 'red' : systemHealthPct === 100 ? 'green' : 'amber'}
      />
    </div>
  );
}

function Vital({ label, value, color, dot, pulse }: {
  label: string;
  value: string;
  color: string;
  dot?: 'red' | 'amber' | 'green';
  pulse?: boolean;
}) {
  const dotColors = {
    red: 'bg-urgency-red shadow-[0_0_6px_rgba(244,63,94,0.5)]',
    amber: 'bg-urgency-amber shadow-[0_0_6px_rgba(245,158,11,0.5)]',
    green: 'bg-urgency-green shadow-[0_0_6px_rgba(16,185,129,0.5)]',
  };

  return (
    <div className="flex items-center gap-2 shrink-0">
      {dot && (
        <span className={`w-1.5 h-1.5 rounded-full ${dotColors[dot]} ${pulse ? 'animate-pulse-glow' : ''}`} />
      )}
      <span className="text-[9px] text-chrome-muted uppercase tracking-[0.15em] font-medium font-mono">{label}</span>
      <span className={`text-sm font-bold font-mono tabular-nums ${color}`}>{value}</span>
    </div>
  );
}

function VitalDivider() {
  return <span className="text-chrome-border text-xs hidden sm:inline select-none">|</span>;
}
