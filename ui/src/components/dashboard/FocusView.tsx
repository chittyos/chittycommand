import { useNavigate } from 'react-router-dom';
import { Card } from '../ui/Card';
import { ActionButton } from '../ui/ActionButton';
import { urgencyLevel } from '../ui/UrgencyBorder';
import type { DashboardData, Obligation, Recommendation } from '../../lib/api';
import { formatCurrency, formatDate, daysUntil } from '../../lib/utils';

interface FocusViewProps {
  data: DashboardData;
  onPayNow: (ob: Obligation) => void;
  onExecute: (rec: Recommendation) => void;
  payingId: string | null;
  executingId: string | null;
}

interface FocusItem {
  id: string;
  type: 'obligation' | 'dispute' | 'deadline' | 'recommendation';
  urgency: number;
  title: string;
  subtitle: string;
  metric: string;
  action: { label: string; onClick: () => void; loading: boolean };
}

export function FocusView({ data, onPayNow, onExecute, payingId, executingId }: FocusViewProps) {
  const navigate = useNavigate();
  const { obligations, disputes, deadlines, recommendations } = data;

  const items: FocusItem[] = [];

  obligations.urgent.forEach((ob) => {
    items.push({
      id: `ob-${ob.id}`,
      type: 'obligation',
      urgency: ob.urgency_score ?? 0,
      title: ob.payee,
      subtitle: ob.status === 'overdue'
        ? `OVERDUE ${Math.abs(daysUntil(ob.due_date))} days`
        : `Due ${formatDate(ob.due_date)}`,
      metric: formatCurrency(ob.amount_due),
      action: {
        label: 'Pay Now',
        onClick: () => onPayNow(ob),
        loading: payingId === ob.id,
      },
    });
  });

  disputes.forEach((d) => {
    items.push({
      id: `disp-${d.id}`,
      type: 'dispute',
      urgency: (6 - d.priority) * 20,
      title: d.title,
      subtitle: `vs ${d.counterparty}`,
      metric: d.amount_at_stake ? formatCurrency(d.amount_at_stake) : '',
      action: {
        label: d.next_action ? 'Take Action' : 'View',
        onClick: () => navigate('/disputes'),
        loading: false,
      },
    });
  });

  deadlines.forEach((dl) => {
    const days = daysUntil(dl.deadline_date);
    items.push({
      id: `dl-${dl.id}`,
      type: 'deadline',
      urgency: dl.urgency_score ?? (days <= 7 ? 80 : 30),
      title: dl.title,
      subtitle: dl.case_ref,
      metric: days > 0 ? `${days}d left` : days === 0 ? 'TODAY' : `${Math.abs(days)}d ago`,
      action: {
        label: 'View',
        onClick: () => navigate('/legal'),
        loading: false,
      },
    });
  });

  recommendations.slice(0, 3).forEach((rec) => {
    items.push({
      id: `rec-${rec.id}`,
      type: 'recommendation',
      urgency: (6 - rec.priority) * 15,
      title: rec.title,
      subtitle: rec.reasoning,
      metric: '',
      action: {
        label: rec.action_type ? 'Execute' : 'View',
        onClick: () => rec.action_type ? onExecute(rec) : navigate('/recommendations'),
        loading: executingId === rec.id,
      },
    });
  });

  const top3 = items.sort((a, b) => b.urgency - a.urgency).slice(0, 3);
  const unreviewedCount = recommendations.length;

  if (top3.length === 0) {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="text-center">
          <p className="text-2xl font-semibold text-card-text">All clear</p>
          <p className="text-card-muted mt-1">Nothing urgent right now.</p>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-4 max-w-2xl mx-auto">
      <p className="text-chrome-muted text-sm font-medium uppercase tracking-wider">Needs your attention</p>
      {unreviewedCount > 3 && (
        <Card className="flex items-center justify-between gap-4">
          <div className="flex-1 min-w-0">
            <p className="font-semibold text-card-text">{unreviewedCount} actions to review</p>
            <p className="text-card-muted text-sm mt-0.5">AI has recommendations ready for your approval.</p>
          </div>
          <ActionButton label="Review Queue" onClick={() => navigate('/queue')} />
        </Card>
      )}
      {top3.map((item) => (
        <Card
          key={item.id}
          urgency={urgencyLevel(item.urgency)}
          className="flex items-center justify-between gap-4"
        >
          <div className="flex-1 min-w-0">
            <p className="font-semibold text-card-text truncate">{item.title}</p>
            <p className="text-card-muted text-sm mt-0.5">{item.subtitle}</p>
          </div>
          {item.metric && (
            <p className="text-lg font-bold font-mono text-card-text shrink-0">{item.metric}</p>
          )}
          <ActionButton
            label={item.action.label}
            onClick={item.action.onClick}
            loading={item.action.loading}
          />
        </Card>
      ))}
    </div>
  );
}
