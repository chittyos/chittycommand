import { useEffect, useState } from 'react';
import { api, type LegalDeadline } from '../lib/api';
import { formatDate, daysUntil } from '../lib/utils';
import { Card } from '../components/ui/Card';

export function Legal() {
  const [deadlines, setDeadlines] = useState<LegalDeadline[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api.getLegalDeadlines().then(setDeadlines).catch((e) => setError(e.message));
  }, []);

  if (error) return <div className="bg-red-50 border border-red-200 rounded-card p-3 text-urgency-red text-sm">{error}</div>;

  const urgencyFromDays = (days: number): 'red' | 'amber' | 'green' | null => {
    if (days < 0) return 'red';
    if (days <= 7) return 'amber';
    if (days <= 30) return 'green';
    return null;
  };

  const countdownColor = (days: number): string => {
    if (days < 0) return 'text-urgency-red';
    if (days <= 7) return 'text-urgency-amber';
    if (days <= 30) return 'text-urgency-amber';
    return 'text-card-muted';
  };

  return (
    <div className="space-y-6">
      <h1 className="text-xl font-bold text-chrome-text">Legal Deadlines</h1>

      <div className="space-y-2">
        {deadlines.map((dl) => {
          const days = daysUntil(dl.deadline_date);
          const isPast = days < 0;

          return (
            <Card key={dl.id} urgency={urgencyFromDays(days)}>
              <div className="flex items-center justify-between">
                <div>
                  <div className="flex items-center gap-2">
                    <span className="text-xs px-2 py-0.5 rounded-full bg-purple-100 text-purple-700 font-medium">
                      {dl.deadline_type}
                    </span>
                    <span className="text-xs text-card-muted">{dl.case_ref}</span>
                  </div>
                  <h3 className="text-card-text font-medium mt-1">{dl.title}</h3>
                </div>
                <div className="text-right">
                  <p className={`text-lg font-mono font-bold ${countdownColor(days)}`}>
                    {isPast ? `${Math.abs(days)}d PAST` : days === 0 ? 'TODAY' : `${days}d`}
                  </p>
                  <p className="text-card-muted text-xs">{formatDate(dl.deadline_date)}</p>
                </div>
              </div>
            </Card>
          );
        })}
      </div>

      {deadlines.length === 0 && (
        <Card className="text-center py-8">
          <p className="text-card-muted">No upcoming legal deadlines</p>
        </Card>
      )}
    </div>
  );
}
