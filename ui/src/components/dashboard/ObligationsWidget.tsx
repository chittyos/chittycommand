import { Card } from '../ui/Card';
import { urgencyLevel } from '../ui/UrgencyBorder';
import type { Obligation } from '../../lib/api';
import { formatCurrency, formatDate, daysUntil } from '../../lib/utils';

interface Props {
  obligations: Obligation[];
  onPayNow: (ob: Obligation) => void;
  payingId: string | null;
}

export function ObligationsWidget({ obligations, onPayNow, payingId }: Props) {
  if (obligations.length === 0) {
    return (
      <div className="bg-card-bg rounded-card border border-card-border p-4">
        <h2 className="font-semibold text-card-text mb-2">Upcoming Bills</h2>
        <p className="text-card-muted text-sm text-center py-4">No pending obligations</p>
      </div>
    );
  }

  return (
    <div className="space-y-2">
      <h2 className="font-semibold text-chrome-text text-sm uppercase tracking-wider">Upcoming Bills</h2>
      {obligations.map((ob) => {
        const days = daysUntil(ob.due_date);
        return (
          <Card key={ob.id} urgency={urgencyLevel(ob.urgency_score)} muted={!ob.urgency_score || ob.urgency_score < 30}>
            <div className="flex items-center justify-between">
              <div className="min-w-0 flex-1">
                <p className="font-medium text-card-text truncate">{ob.payee}</p>
                <p className="text-card-muted text-xs">
                  {ob.category} — {ob.status === 'overdue'
                    ? `${Math.abs(days)}d overdue`
                    : `Due ${formatDate(ob.due_date)}`}
                </p>
              </div>
              <div className="flex items-center gap-3 shrink-0">
                <p className="font-mono font-semibold text-card-text">{formatCurrency(ob.amount_due)}</p>
                {ob.status !== 'paid' && (
                  <button
                    onClick={() => onPayNow(ob)}
                    disabled={payingId === ob.id}
                    className="px-3 py-1 text-xs font-medium bg-chitty-600 text-white rounded-lg hover:bg-chitty-700 disabled:opacity-50"
                  >
                    {payingId === ob.id ? '...' : 'Pay'}
                  </button>
                )}
              </div>
            </div>
          </Card>
        );
      })}
    </div>
  );
}
