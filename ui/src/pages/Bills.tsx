import { useEffect, useState } from 'react';
import { api, type Obligation } from '../lib/api';
import { Card } from '../components/ui/Card';
import { ActionButton } from '../components/ui/ActionButton';
import { urgencyLevel } from '../components/ui/UrgencyBorder';
import { formatCurrency, formatDate, daysUntil, cn } from '../lib/utils';

export function Bills() {
  const [obligations, setObligations] = useState<Obligation[]>([]);
  const [filter, setFilter] = useState<string>('');
  const [error, setError] = useState<string | null>(null);
  const [payingId, setPayingId] = useState<string | null>(null);

  useEffect(() => {
    const params: Record<string, string> = {};
    if (filter) params.status = filter;
    api.getObligations(params).then(setObligations).catch((e) => setError(e.message));
  }, [filter]);

  const handleMarkPaid = async (id: string) => {
    setPayingId(id);
    try {
      await api.markPaid(id);
      setObligations((prev) => prev.map((o) => (o.id === id ? { ...o, status: 'paid', urgency_score: 0 } : o)));
    } finally {
      setPayingId(null);
    }
  };

  if (error) return <p className="text-urgency-red">{error}</p>;

  const filters = ['', 'pending', 'overdue', 'paid'];

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-bold text-chrome-text">Bills & Obligations</h1>
        <div className="flex gap-1">
          {filters.map((f) => (
            <button
              key={f}
              onClick={() => setFilter(f)}
              className={cn(
                'px-3 py-1.5 rounded-lg text-sm font-medium transition-colors',
                filter === f
                  ? 'bg-chitty-600 text-white'
                  : 'bg-chrome-border/50 text-chrome-muted hover:text-white',
              )}
            >
              {f || 'All'}
            </button>
          ))}
        </div>
      </div>

      <div className="space-y-2">
        {obligations.map((ob) => {
          const days = ob.due_date ? daysUntil(ob.due_date) : null;
          return (
            <Card
              key={ob.id}
              urgency={urgencyLevel(ob.urgency_score)}
              muted={ob.status === 'paid' || (!ob.urgency_score || ob.urgency_score < 30)}
            >
              <div className="flex items-center justify-between gap-4">
                <div className="min-w-0 flex-1">
                  <p className="font-medium text-card-text">{ob.payee}</p>
                  <p className="text-card-muted text-xs">
                    {ob.category}
                    {ob.due_date && (
                      <span>
                        {' — '}
                        {days !== null && days < 0
                          ? <span className="text-urgency-red">{Math.abs(days)}d late</span>
                          : days === 0
                          ? <span className="text-urgency-amber">Due today</span>
                          : `Due ${formatDate(ob.due_date)}`
                        }
                      </span>
                    )}
                  </p>
                </div>
                <div className="flex items-center gap-4 shrink-0">
                  <p className="font-mono font-semibold text-card-text">{formatCurrency(ob.amount_due)}</p>
                  <span className={cn(
                    'text-xs px-2 py-0.5 rounded-full font-medium',
                    ob.status === 'paid' ? 'bg-green-100 text-green-700' :
                    ob.status === 'overdue' ? 'bg-red-100 text-red-700' :
                    ob.status === 'pending' ? 'bg-amber-100 text-amber-700' :
                    'bg-gray-100 text-gray-700',
                  )}>
                    {ob.status}
                  </span>
                  {ob.status !== 'paid' && (
                    <ActionButton
                      label="Mark Paid"
                      variant="secondary"
                      onClick={() => handleMarkPaid(ob.id)}
                      loading={payingId === ob.id}
                    />
                  )}
                </div>
              </div>
            </Card>
          );
        })}
        {obligations.length === 0 && (
          <p className="text-chrome-muted text-sm py-8 text-center">No obligations found</p>
        )}
      </div>
    </div>
  );
}
