import { Card } from '../ui/Card';
import { ProgressDots } from '../ui/ProgressDots';
import type { Dispute } from '../../lib/api';
import { formatCurrency } from '../../lib/utils';

const DISPUTE_STAGES = ['filed', 'response_pending', 'in_review', 'resolved'];

function disputeStageIndex(status: string): number {
  const idx = DISPUTE_STAGES.indexOf(status);
  return idx >= 0 ? idx : 0;
}

interface Props {
  disputes: Dispute[];
}

export function DisputesWidget({ disputes }: Props) {
  if (disputes.length === 0) {
    return (
      <div className="bg-card-bg rounded-card border border-card-border p-4">
        <h2 className="font-semibold text-card-text mb-2">Active Disputes</h2>
        <p className="text-card-muted text-sm text-center py-4">No active disputes</p>
      </div>
    );
  }

  return (
    <div className="space-y-2">
      <h2 className="font-semibold text-chrome-text text-sm uppercase tracking-wider">Active Disputes</h2>
      {disputes.map((d) => (
        <Card key={d.id} urgency={d.priority <= 1 ? 'red' : d.priority <= 3 ? 'amber' : 'green'}>
          <div className="flex items-start justify-between gap-2">
            <div className="min-w-0 flex-1">
              <p className="font-medium text-card-text truncate">{d.title}</p>
              <p className="text-card-muted text-xs">vs {d.counterparty}</p>
              <ProgressDots completed={disputeStageIndex(d.status) + 1} total={DISPUTE_STAGES.length} className="mt-2" />
            </div>
            <div className="text-right shrink-0">
              {d.amount_at_stake && (
                <p className="font-mono font-semibold text-urgency-red">{formatCurrency(d.amount_at_stake)}</p>
              )}
              {d.next_action && (
                <a href="/disputes" className="text-xs text-chitty-500 hover:underline mt-1 block">{d.next_action}</a>
              )}
            </div>
          </div>
        </Card>
      ))}
    </div>
  );
}
