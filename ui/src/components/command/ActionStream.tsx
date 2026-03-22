import { useNavigate } from 'react-router-dom';
import type { DashboardData, Obligation, Recommendation, QueueItem } from '../../lib/api';
import { formatCurrency, daysUntil, formatDate } from '../../lib/utils';

interface ActionStreamProps {
  data: DashboardData;
  queueItems: QueueItem[];
  onPayNow: (ob: Obligation) => void;
  onExecute: (rec: Recommendation) => void;
  onDecideQueue: (id: string, decision: 'approved' | 'rejected' | 'deferred') => void;
  payingId: string | null;
  executingId: string | null;
}

interface StreamItem {
  id: string;
  type: 'obligation' | 'dispute' | 'deadline' | 'recommendation' | 'queue';
  urgency: number;
  title: string;
  subtitle: string;
  amount: string | null;
  badge: { label: string; color: string };
  actions: { label: string; onClick: () => void; loading?: boolean; variant?: 'primary' | 'secondary' | 'danger' }[];
  timestamp?: string;
}

export function ActionStream({ data, queueItems, onPayNow, onExecute, onDecideQueue, payingId, executingId }: ActionStreamProps) {
  const navigate = useNavigate();
  const items: StreamItem[] = [];

  // Obligations → stream items
  data.obligations.urgent.forEach(ob => {
    const days = daysUntil(ob.due_date);
    const isOverdue = days < 0;
    items.push({
      id: `ob-${ob.id}`,
      type: 'obligation',
      urgency: ob.urgency_score ?? (isOverdue ? 90 : 40),
      title: ob.payee,
      subtitle: isOverdue
        ? `${Math.abs(days)}d overdue · ${ob.category}`
        : days === 0
          ? `Due today · ${ob.category}`
          : `Due ${formatDate(ob.due_date)} · ${days}d · ${ob.category}`,
      amount: formatCurrency(ob.amount_due),
      badge: isOverdue
        ? { label: 'OVERDUE', color: 'badge-red' }
        : days <= 3
          ? { label: 'URGENT', color: 'badge-amber' }
          : { label: 'DUE', color: 'badge-default' },
      actions: ob.status !== 'paid' ? [{
        label: ob.auto_pay ? 'Auto-pay' : 'Mark Paid',
        onClick: () => onPayNow(ob),
        loading: payingId === ob.id,
        variant: 'primary' as const,
      }] : [],
    });
  });

  // Disputes → stream items
  data.disputes.forEach(d => {
    const hasDeadline = d.next_action_date ? daysUntil(d.next_action_date) <= 7 : false;
    items.push({
      id: `disp-${d.id}`,
      type: 'dispute',
      urgency: hasDeadline ? 75 : (6 - d.priority) * 15,
      title: d.title,
      subtitle: `vs ${d.counterparty}${d.next_action ? ` · Next: ${d.next_action}` : ''}`,
      amount: d.amount_at_stake ? formatCurrency(d.amount_at_stake) : null,
      badge: d.priority <= 2
        ? { label: `P${d.priority}`, color: 'badge-red' }
        : d.priority <= 4
          ? { label: `P${d.priority}`, color: 'badge-amber' }
          : { label: `P${d.priority}`, color: 'badge-default' },
      actions: [{
        label: d.next_action ? 'Take Action' : 'Open',
        onClick: () => navigate(`/disputes?expand=${d.id}`),
        variant: d.next_action ? 'primary' as const : 'secondary' as const,
      }],
      timestamp: d.next_action_date ? formatDate(d.next_action_date) : undefined,
    });
  });

  // Legal deadlines → stream items
  data.deadlines.forEach(dl => {
    const days = daysUntil(dl.deadline_date);
    items.push({
      id: `dl-${dl.id}`,
      type: 'deadline',
      urgency: dl.urgency_score ?? (days < 0 ? 95 : days <= 3 ? 85 : days <= 7 ? 70 : 30),
      title: dl.title,
      subtitle: `${dl.case_ref} · ${dl.deadline_type}`,
      amount: null,
      badge: days < 0
        ? { label: 'PAST DUE', color: 'badge-red' }
        : days === 0
          ? { label: 'TODAY', color: 'badge-red' }
          : days <= 7
            ? { label: `${days}D`, color: 'badge-amber' }
            : { label: `${days}D`, color: 'badge-default' },
      actions: [{
        label: 'View',
        onClick: () => dl.dispute_id ? navigate(`/disputes?expand=${dl.dispute_id}`) : navigate('/legal'),
        variant: 'secondary' as const,
      }],
      timestamp: formatDate(dl.deadline_date),
    });
  });

  // Recommendations → stream items (only top 5 not already in queue)
  const queuedRecIds = new Set(queueItems.map(q => q.id));
  data.recommendations.filter(r => !queuedRecIds.has(r.id)).slice(0, 5).forEach(rec => {
    items.push({
      id: `rec-${rec.id}`,
      type: 'recommendation',
      urgency: (6 - rec.priority) * 12,
      title: rec.title,
      subtitle: rec.reasoning,
      amount: null,
      badge: { label: rec.rec_type.toUpperCase(), color: 'badge-brand' },
      actions: [
        ...(rec.action_type ? [{
          label: actionLabel(rec.action_type),
          onClick: () => onExecute(rec),
          loading: executingId === rec.id,
          variant: 'primary' as const,
        }] : []),
        {
          label: 'View',
          onClick: () => navigate('/recommendations'),
          variant: 'secondary' as const,
        },
      ],
    });
  });

  // Queue items → stream items (top 3)
  queueItems.slice(0, 3).forEach(qi => {
    items.push({
      id: `q-${qi.id}`,
      type: 'queue',
      urgency: qi.live_confidence * 10 + (qi.priority <= 2 ? 30 : 0),
      title: qi.title,
      subtitle: qi.obligation_payee
        ? `${qi.obligation_payee} · ${qi.rec_type}`
        : qi.dispute_title
          ? `${qi.dispute_title} · ${qi.rec_type}`
          : qi.rec_type,
      amount: qi.suggested_amount ? formatCurrency(qi.suggested_amount) : qi.obligation_amount ? formatCurrency(qi.obligation_amount) : null,
      badge: { label: 'QUEUE', color: 'badge-brand' },
      actions: [
        { label: 'Approve', onClick: () => onDecideQueue(qi.id, 'approved'), variant: 'primary' as const },
        { label: 'Reject', onClick: () => onDecideQueue(qi.id, 'rejected'), variant: 'danger' as const },
        { label: 'Defer', onClick: () => onDecideQueue(qi.id, 'deferred'), variant: 'secondary' as const },
      ],
    });
  });

  // Sort by urgency descending
  items.sort((a, b) => b.urgency - a.urgency);

  if (items.length === 0) {
    return (
      <div className="command-empty">
        <div className="command-empty-dot" />
        <p className="text-chrome-text font-medium text-lg">All clear</p>
        <p className="text-chrome-muted text-sm mt-1">No items need your attention right now.</p>
      </div>
    );
  }

  return (
    <div className="space-y-1.5">
      <div className="flex items-center justify-between mb-1">
        <h2 className="text-[10px] text-chrome-muted uppercase tracking-[0.2em] font-mono font-semibold">
          Action Stream
          <span className="text-chrome-border ml-2">{items.length} items</span>
        </h2>
      </div>
      {items.map((item, i) => (
        <StreamItemCard key={item.id} item={item} index={i} />
      ))}
    </div>
  );
}

function StreamItemCard({ item, index }: { item: StreamItem; index: number }) {
  const urgencyBarColor =
    item.urgency >= 70 ? 'bg-urgency-red' :
    item.urgency >= 40 ? 'bg-urgency-amber' :
    item.urgency >= 20 ? 'bg-urgency-green' :
    'bg-chrome-border';

  return (
    <div
      className={`stream-item animate-fade-in-up`}
      style={{ animationDelay: `${Math.min(index * 30, 200)}ms` }}
    >
      {/* Urgency bar */}
      <div className={`stream-item-bar ${urgencyBarColor}`} />

      {/* Content */}
      <div className="flex-1 min-w-0 py-0.5">
        <div className="flex items-center gap-2 flex-wrap">
          <span className={`stream-badge ${item.badge.color}`}>
            {item.badge.label}
          </span>
          <span className="text-chrome-text text-sm font-medium truncate">{item.title}</span>
          {item.timestamp && (
            <span className="text-chrome-muted text-[10px] font-mono shrink-0 hidden sm:inline">{item.timestamp}</span>
          )}
        </div>
        <p className="text-chrome-muted text-xs mt-0.5 truncate">{item.subtitle}</p>
      </div>

      {/* Amount */}
      {item.amount && (
        <span className="text-chrome-text text-base font-bold font-mono tabular-nums shrink-0 hidden sm:block">
          {item.amount}
        </span>
      )}

      {/* Actions */}
      <div className="flex items-center gap-1.5 shrink-0">
        {item.actions.map(action => (
          <button
            key={action.label}
            onClick={action.onClick}
            disabled={action.loading}
            className={`stream-action ${
              action.variant === 'primary' ? 'stream-action-primary' :
              action.variant === 'danger' ? 'stream-action-danger' :
              'stream-action-secondary'
            } ${action.loading ? 'opacity-50 pointer-events-none' : ''}`}
          >
            {action.loading ? (
              <span className="w-3 h-3 border-2 border-current/30 border-t-current rounded-full animate-spin" />
            ) : action.label}
          </button>
        ))}
      </div>
    </div>
  );
}

function actionLabel(type: string): string {
  const labels: Record<string, string> = {
    pay_now: 'Pay Now',
    pay_minimum: 'Pay Min',
    pay_full: 'Pay Full',
    negotiate: 'Negotiate',
    defer: 'Defer',
    execute_action: 'Execute',
    plan_action: 'Plan',
    prepare_legal: 'Prepare',
    review_cashflow: 'Review',
    execute_browser: 'Automate',
    send_email: 'Send',
  };
  return labels[type] || 'Act';
}
