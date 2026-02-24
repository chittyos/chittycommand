import { Card } from '../ui/Card';
import { urgencyFromDays } from '../ui/UrgencyBorder';
import type { LegalDeadline } from '../../lib/api';
import { formatDate, daysUntil } from '../../lib/utils';

interface Props {
  deadlines: LegalDeadline[];
}

export function DeadlinesWidget({ deadlines }: Props) {
  if (deadlines.length === 0) return null;

  return (
    <div className="space-y-2">
      <h2 className="font-semibold text-chrome-text text-sm uppercase tracking-wider">Legal Deadlines</h2>
      {deadlines.map((dl) => {
        const days = daysUntil(dl.deadline_date);
        return (
          <Card key={dl.id} urgency={urgencyFromDays(days)}>
            <div className="flex items-center justify-between">
              <div>
                <p className="font-medium text-card-text">{dl.title}</p>
                <p className="text-card-muted text-xs">{dl.case_ref}</p>
              </div>
              <div className="text-right">
                <p className="font-mono font-semibold text-card-text">
                  {days > 0 ? `${days}d` : days === 0 ? 'TODAY' : `${Math.abs(days)}d ago`}
                </p>
                <p className="text-card-muted text-xs">{formatDate(dl.deadline_date)}</p>
              </div>
            </div>
          </Card>
        );
      })}
    </div>
  );
}
