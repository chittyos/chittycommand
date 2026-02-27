import { formatCurrency, daysUntil, formatDate } from '../../lib/utils';
import type { QueueItem } from '../../lib/api';

interface SwipeCardProps {
  item: QueueItem;
  offset: { x: number; y: number };
  showDetails: boolean;
  onToggleDetails: () => void;
}

export function SwipeCard({ item, offset, showDetails, onToggleDetails }: SwipeCardProps) {
  const days = item.obligation_due_date ? daysUntil(item.obligation_due_date) : null;
  const amount = item.obligation_amount ? parseFloat(item.obligation_amount) : null;
  const confidence = item.confidence ?? item.live_confidence ?? 0.5;

  // Swipe overlay opacity based on drag distance
  const approveOpacity = Math.min(1, Math.max(0, offset.x / 120));
  const rejectOpacity = Math.min(1, Math.max(0, -offset.x / 120));
  const deferOpacity = Math.min(1, Math.max(0, -offset.y / 80));

  const rotation = offset.x * 0.05;
  const transform = `translate(${offset.x}px, ${offset.y}px) rotate(${rotation}deg)`;

  return (
    <div
      className="relative bg-card-bg border border-card-border rounded-2xl shadow-lg overflow-hidden select-none"
      style={{ transform, transition: offset.x === 0 && offset.y === 0 ? 'transform 0.3s ease-out' : 'none' }}
    >
      {/* Swipe overlays */}
      {approveOpacity > 0 && (
        <div className="absolute inset-0 bg-green-500/20 flex items-center justify-center z-10 pointer-events-none"
          style={{ opacity: approveOpacity }}>
          <span className="text-3xl font-bold text-green-600 border-4 border-green-600 rounded-xl px-6 py-2 rotate-[-15deg]">
            APPROVE
          </span>
        </div>
      )}
      {rejectOpacity > 0 && (
        <div className="absolute inset-0 bg-red-500/20 flex items-center justify-center z-10 pointer-events-none"
          style={{ opacity: rejectOpacity }}>
          <span className="text-3xl font-bold text-red-600 border-4 border-red-600 rounded-xl px-6 py-2 rotate-[15deg]">
            REJECT
          </span>
        </div>
      )}
      {deferOpacity > 0 && (
        <div className="absolute inset-0 bg-amber-500/20 flex items-center justify-center z-10 pointer-events-none"
          style={{ opacity: deferOpacity }}>
          <span className="text-3xl font-bold text-amber-600 border-4 border-amber-600 rounded-xl px-6 py-2">
            DEFER
          </span>
        </div>
      )}

      {/* Card content */}
      <div className="p-5 sm:p-6">
        {/* Header: category + confidence */}
        <div className="flex items-center justify-between mb-3">
          <div className="flex items-center gap-2">
            <span className={`text-xs px-2 py-0.5 rounded-full font-medium ${recTypeColor(item.rec_type)}`}>
              {item.rec_type}
            </span>
            <span className={`text-xs px-2 py-0.5 rounded-full font-medium ${priorityColor(item.priority)}`}>
              P{item.priority}
            </span>
            {item.obligation_category && (
              <span className="text-xs text-card-muted">{item.obligation_category}</span>
            )}
          </div>
          <ConfidenceDot confidence={confidence} />
        </div>

        {/* Title + payee */}
        <h2 className="text-lg font-semibold text-card-text leading-tight">{item.title}</h2>
        {item.obligation_payee && (
          <p className="text-card-muted text-sm mt-1">{item.obligation_payee}</p>
        )}
        {item.dispute_counterparty && (
          <p className="text-card-muted text-sm mt-1">vs {item.dispute_counterparty}</p>
        )}

        {/* Amount + due date */}
        <div className="flex items-end justify-between mt-4">
          {amount != null && amount > 0 ? (
            <p className="text-2xl font-bold font-mono text-card-text">{formatCurrency(amount)}</p>
          ) : null}
          {item.dispute_amount && (
            <p className="text-2xl font-bold font-mono text-card-text">{formatCurrency(parseFloat(item.dispute_amount))}</p>
          )}
          {days != null && (
            <div className="text-right">
              <p className={`text-lg font-mono font-bold ${daysColor(days)}`}>
                {days < 0 ? `${Math.abs(days)}d PAST` : days === 0 ? 'TODAY' : `${days}d`}
              </p>
              <p className="text-card-muted text-xs">{formatDate(item.obligation_due_date!)}</p>
              {item.obligation_grace_days != null && item.obligation_grace_days > 0 && (
                <p className="text-xs text-amber-600">+{item.obligation_grace_days}d grace</p>
              )}
            </div>
          )}
        </div>

        {/* Escalation risk */}
        {item.escalation_risk && (
          <div className="mt-3 px-3 py-2 rounded-lg bg-red-50 border border-red-200">
            <p className="text-xs font-medium text-red-700">
              Escalation risk: {item.escalation_risk.replace(/_/g, ' ')}
            </p>
          </div>
        )}

        {/* Reasoning */}
        <p className="text-card-muted text-sm mt-3 leading-relaxed">{item.reasoning}</p>

        {/* Scenario impact preview */}
        {item.scenario_impact != null && (
          <div className="mt-3 grid grid-cols-2 gap-2 text-xs">
            <div className="p-2 rounded-lg bg-green-50 border border-green-200">
              <p className="text-green-700 font-medium">If approved</p>
              <p className="text-green-600">
                {(item.scenario_impact as { approve_balance?: number }).approve_balance != null
                  ? `Balance: ${formatCurrency((item.scenario_impact as { approve_balance: number }).approve_balance)}`
                  : 'Action executed'}
              </p>
            </div>
            <div className="p-2 rounded-lg bg-red-50 border border-red-200">
              <p className="text-red-700 font-medium">If skipped</p>
              <p className="text-red-600">
                {(item.scenario_impact as { skip_consequence?: string }).skip_consequence || 'No immediate impact'}
              </p>
            </div>
          </div>
        )}

        {/* Expand details */}
        <button
          onClick={(e) => { e.stopPropagation(); onToggleDetails(); }}
          className="mt-3 text-xs text-chitty-500 hover:text-chitty-600 font-medium"
        >
          {showDetails ? 'Hide details' : 'Show details'}
        </button>

        {showDetails && (
          <div className="mt-3 space-y-2 text-xs text-card-muted border-t border-card-border pt-3">
            {item.suggested_amount && (
              <p>Suggested amount: <span className="text-card-text font-medium">{formatCurrency(parseFloat(item.suggested_amount))}</span></p>
            )}
            {item.obligation_late_fee && (
              <p>Late fee: <span className="text-red-600 font-medium">${item.obligation_late_fee}</span></p>
            )}
            {item.obligation_auto_pay && (
              <p className="text-green-600">Auto-pay enabled</p>
            )}
            {item.estimated_savings && parseFloat(item.estimated_savings) > 0 && (
              <p>Estimated savings: <span className="text-green-600 font-medium">{formatCurrency(parseFloat(item.estimated_savings))}</span></p>
            )}
            <p>Action: <span className="text-card-text">{item.action_type || 'review'}</span></p>
          </div>
        )}
      </div>
    </div>
  );
}

function ConfidenceDot({ confidence }: { confidence: number }) {
  const color = confidence >= 0.8 ? 'bg-green-500' : confidence >= 0.6 ? 'bg-amber-500' : 'bg-red-500';
  return (
    <div className="flex items-center gap-1.5">
      <div className={`w-2 h-2 rounded-full ${color}`} />
      <span className="text-xs text-card-muted">{Math.round(confidence * 100)}%</span>
    </div>
  );
}

function recTypeColor(type: string): string {
  const colors: Record<string, string> = {
    payment: 'bg-green-100 text-green-700',
    negotiate: 'bg-purple-100 text-purple-700',
    defer: 'bg-gray-100 text-gray-600',
    dispute: 'bg-orange-100 text-orange-700',
    legal: 'bg-red-100 text-red-700',
    warning: 'bg-amber-100 text-amber-700',
    strategy: 'bg-blue-100 text-blue-700',
  };
  return colors[type] || 'bg-gray-100 text-gray-600';
}

function priorityColor(priority: number): string {
  if (priority <= 1) return 'bg-red-100 text-red-700';
  if (priority <= 2) return 'bg-orange-100 text-orange-700';
  if (priority <= 3) return 'bg-amber-100 text-amber-700';
  return 'bg-gray-100 text-gray-600';
}

function daysColor(days: number): string {
  if (days < 0) return 'text-red-600';
  if (days <= 3) return 'text-amber-600';
  if (days <= 7) return 'text-amber-500';
  return 'text-card-muted';
}
