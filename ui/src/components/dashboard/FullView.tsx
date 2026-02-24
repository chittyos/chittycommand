import { MetricCard } from '../ui/MetricCard';
import { ObligationsWidget } from './ObligationsWidget';
import { DisputesWidget } from './DisputesWidget';
import { DeadlinesWidget } from './DeadlinesWidget';
import { RecommendationsWidget } from './RecommendationsWidget';
import type { DashboardData, Obligation, Recommendation } from '../../lib/api';
import { formatCurrency } from '../../lib/utils';

interface FullViewProps {
  data: DashboardData;
  onPayNow: (ob: Obligation) => void;
  onExecute: (rec: Recommendation) => void;
  payingId: string | null;
  executingId: string | null;
}

export function FullView({ data, onPayNow, onExecute, payingId, executingId }: FullViewProps) {
  const { summary, obligations, disputes, deadlines, recommendations } = data;

  return (
    <div className="space-y-6">
      <div className="grid grid-cols-4 gap-3">
        <MetricCard label="Cash Available" value={formatCurrency(summary.total_cash)} valueClassName="text-urgency-green" />
        <MetricCard label="Credit Owed" value={formatCurrency(summary.total_credit_owed)} valueClassName="text-urgency-red" />
        <MetricCard label="Due Next 30d" value={formatCurrency(obligations.total_due_30d)} valueClassName="text-urgency-amber" />
        <MetricCard
          label="Overdue"
          value={obligations.overdue_count}
          valueClassName={Number(obligations.overdue_count) > 0 ? 'text-urgency-red' : 'text-urgency-green'}
        />
      </div>

      <div className="grid grid-cols-2 gap-6">
        <ObligationsWidget obligations={obligations.urgent} onPayNow={onPayNow} payingId={payingId} />
        <DisputesWidget disputes={disputes} />
      </div>

      <div className="grid grid-cols-2 gap-6">
        <DeadlinesWidget deadlines={deadlines} />
        <RecommendationsWidget recommendations={recommendations} onExecute={onExecute} executingId={executingId} />
      </div>
    </div>
  );
}
