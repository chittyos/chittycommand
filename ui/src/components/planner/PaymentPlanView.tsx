import { formatCurrency, formatDate } from '../../lib/utils';
import type { PaymentPlan, ScheduleEntry, PlanWarning } from '../../lib/api';
import { Card } from '../ui/Card';
import { MetricCard } from '../ui/MetricCard';

interface PaymentPlanViewProps {
  plan: PaymentPlan;
  onDeferItem?: (obligationId: string) => void;
}

export function PaymentPlanView({ plan, onDeferItem }: PaymentPlanViewProps) {
  let schedule: ScheduleEntry[];
  try {
    const raw = typeof plan.schedule === 'string' ? JSON.parse(plan.schedule) : plan.schedule;
    schedule = Array.isArray(raw) ? raw : [];
  } catch (e) {
    console.error('[PaymentPlanView] Failed to parse plan.schedule', e);
    schedule = [];
  }

  let warnings: PlanWarning[];
  try {
    const raw = typeof plan.warnings === 'string' ? JSON.parse(plan.warnings) : plan.warnings;
    warnings = Array.isArray(raw) ? raw : [];
  } catch (e) {
    console.error('[PaymentPlanView] Failed to parse plan.warnings', e);
    warnings = [];
  }

  // Group schedule by date
  const byDate = new Map<string, ScheduleEntry[]>();
  for (const entry of schedule) {
    const entries = byDate.get(entry.date) || [];
    entries.push(entry);
    byDate.set(entry.date, entries);
  }

  // Build balance data for sparkline
  const balancePoints = schedule.map((e) => e.balance_after);
  const maxBalance = Math.max(...balancePoints, plan.starting_balance);
  const minBalance = Math.min(...balancePoints, 0);
  const range = maxBalance - minBalance || 1;

  return (
    <div className="space-y-4">
      {/* Summary metrics */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-2 lg:gap-3">
        <MetricCard label="Starting" value={formatCurrency(plan.starting_balance)} />
        <MetricCard label="Ending" value={formatCurrency(plan.ending_balance)}
          valueClassName={plan.ending_balance >= 0 ? 'text-urgency-green' : 'text-urgency-red'} />
        <MetricCard label="Lowest" value={formatCurrency(plan.lowest_balance)}
          valueClassName={plan.lowest_balance >= 0 ? 'text-urgency-amber' : 'text-urgency-red'} />
        <MetricCard label="Late Fees Risk" value={formatCurrency(plan.total_late_fees_risked)}
          valueClassName={plan.total_late_fees_risked > 0 ? 'text-urgency-red' : 'text-urgency-green'} />
      </div>

      {/* Balance sparkline */}
      {balancePoints.length > 0 && (
        <Card>
          <h3 className="text-card-text text-sm font-semibold mb-3">Balance Projection</h3>
          <svg viewBox={`0 0 ${balancePoints.length} 100`} className="w-full h-24" preserveAspectRatio="none">
            {/* Zero line */}
            <line
              x1="0" y1={100 - ((0 - minBalance) / range) * 100}
              x2={balancePoints.length} y2={100 - ((0 - minBalance) / range) * 100}
              stroke="#ef4444" strokeWidth="0.5" strokeDasharray="2,2"
            />
            {/* Balance line */}
            <polyline
              fill="none"
              stroke="#7c3aed"
              strokeWidth="1.5"
              points={balancePoints.map((b, i) =>
                `${i},${100 - ((b - minBalance) / range) * 100}`
              ).join(' ')}
            />
            {/* Red zone (below 0) */}
            {minBalance < 0 && (
              <rect
                x="0" y={100 - ((0 - minBalance) / range) * 100}
                width={balancePoints.length}
                height={((0 - minBalance) / range) * 100}
                fill="#ef4444" fillOpacity="0.1"
              />
            )}
          </svg>
          <div className="flex justify-between text-xs text-card-muted mt-1">
            <span>Today</span>
            <span>{plan.lowest_balance_date ? formatDate(plan.lowest_balance_date) + ' (lowest)' : ''}</span>
            <span>{plan.horizon_days}d</span>
          </div>
        </Card>
      )}

      {/* Warnings */}
      {warnings.length > 0 && (
        <Card urgency="amber">
          <h3 className="text-urgency-amber text-sm font-semibold mb-2">Warnings ({warnings.length})</h3>
          <div className="space-y-1.5">
            {warnings.slice(0, 5).map((w, i) => (
              <div key={i} className="flex items-start gap-2 text-xs">
                <span className={`shrink-0 w-1.5 h-1.5 rounded-full mt-1 ${
                  w.severity === 'critical' ? 'bg-red-500' : w.severity === 'warning' ? 'bg-amber-500' : 'bg-blue-500'
                }`} />
                <div>
                  <span className="text-card-muted">{formatDate(w.date)}</span>
                  <span className="text-card-text ml-1">{w.message}</span>
                </div>
              </div>
            ))}
            {warnings.length > 5 && (
              <p className="text-xs text-card-muted">+{warnings.length - 5} more warnings</p>
            )}
          </div>
        </Card>
      )}

      {/* Revenue summary */}
      {plan.revenue_summary && plan.revenue_summary.length > 0 && (
        <Card>
          <h3 className="text-card-text text-sm font-semibold mb-2">Expected Revenue</h3>
          <div className="space-y-1.5">
            {plan.revenue_summary.map((r, i) => (
              <div key={i} className="flex items-center justify-between text-sm">
                <span className="text-card-text">{r.source}</span>
                <div className="flex items-center gap-2">
                  <span className="font-mono text-card-text">{formatCurrency(r.monthly)}/mo</span>
                  <span className={`w-2 h-2 rounded-full ${
                    r.confidence >= 0.8 ? 'bg-green-500' : r.confidence >= 0.6 ? 'bg-amber-500' : 'bg-red-500'
                  }`} />
                </div>
              </div>
            ))}
          </div>
        </Card>
      )}

      {/* Timeline */}
      <Card>
        <h3 className="text-card-text text-sm font-semibold mb-3">Payment Schedule</h3>
        <div className="space-y-1">
          {Array.from(byDate.entries()).map(([date, entries]) => (
            <div key={date} className="border-b border-card-border last:border-0 py-2">
              <p className="text-xs text-card-muted font-medium mb-1">{formatDate(date)}</p>
              {entries.map((entry) => (
                <div key={entry.obligation_id + entry.date}
                  className="flex items-center justify-between py-1 ml-3">
                  <div className="flex items-center gap-2 min-w-0">
                    <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${actionColor(entry.action)}`} />
                    <span className="text-sm text-card-text truncate">{entry.payee}</span>
                    <span className={`text-xs px-1.5 py-0.5 rounded ${actionBadge(entry.action)}`}>
                      {entry.action.replace(/_/g, ' ')}
                    </span>
                  </div>
                  <div className="flex items-center gap-3 shrink-0">
                    <span className="text-sm font-mono text-card-text">
                      {entry.amount > 0 ? `-${formatCurrency(entry.amount)}` : '--'}
                    </span>
                    <span className={`text-xs font-mono ${entry.balance_after >= 0 ? 'text-card-muted' : 'text-red-600'}`}>
                      {formatCurrency(entry.balance_after)}
                    </span>
                    {onDeferItem && entry.action !== 'defer' && entry.action !== 'at_risk' && (
                      <button
                        onClick={() => onDeferItem(entry.obligation_id)}
                        className="text-xs text-amber-600 hover:text-amber-700 font-medium"
                      >
                        Defer
                      </button>
                    )}
                  </div>
                </div>
              ))}
            </div>
          ))}
        </div>
      </Card>
    </div>
  );
}

function actionColor(action: string): string {
  switch (action) {
    case 'pay_full': return 'bg-green-500';
    case 'pay_minimum': return 'bg-amber-500';
    case 'defer': return 'bg-gray-400';
    case 'at_risk': return 'bg-red-500';
    default: return 'bg-gray-400';
  }
}

function actionBadge(action: string): string {
  switch (action) {
    case 'pay_full': return 'bg-green-100 text-green-700';
    case 'pay_minimum': return 'bg-amber-100 text-amber-700';
    case 'defer': return 'bg-gray-100 text-gray-600';
    case 'at_risk': return 'bg-red-100 text-red-700';
    default: return 'bg-gray-100 text-gray-600';
  }
}
