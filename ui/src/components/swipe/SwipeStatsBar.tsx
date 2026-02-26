import { formatCurrency } from '../../lib/utils';

interface SwipeStatsBarProps {
  approved: number;
  rejected: number;
  deferred: number;
  total: number;
  savings: number;
}

export function SwipeStatsBar({ approved, rejected, deferred, total, savings }: SwipeStatsBarProps) {
  return (
    <div className="flex items-center gap-3 sm:gap-4 px-1 py-2 overflow-x-auto scrollbar-hide">
      <Stat label="Approved" value={approved} color="text-green-600" />
      <Stat label="Rejected" value={rejected} color="text-red-600" />
      <Stat label="Deferred" value={deferred} color="text-amber-600" />
      <div className="w-px h-6 bg-card-border shrink-0" />
      <Stat label="Total" value={total} color="text-card-text" />
      {savings > 0 && (
        <>
          <div className="w-px h-6 bg-card-border shrink-0" />
          <div className="shrink-0">
            <p className="text-[10px] text-card-muted uppercase tracking-wider">Savings</p>
            <p className="text-sm font-bold font-mono text-green-600">{formatCurrency(savings)}</p>
          </div>
        </>
      )}
    </div>
  );
}

function Stat({ label, value, color }: { label: string; value: number; color: string }) {
  return (
    <div className="shrink-0 text-center">
      <p className="text-[10px] text-card-muted uppercase tracking-wider">{label}</p>
      <p className={`text-lg font-bold font-mono ${color}`}>{value}</p>
    </div>
  );
}
