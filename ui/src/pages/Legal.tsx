import { useEffect, useState } from 'react';
import { api, type LegalDeadline } from '../lib/api';
import { formatDate, daysUntil } from '../lib/utils';

export function Legal() {
  const [deadlines, setDeadlines] = useState<LegalDeadline[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api.getLegalDeadlines().then(setDeadlines).catch((e) => setError(e.message));
  }, []);

  if (error) return <p className="text-red-400">{error}</p>;

  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-bold text-white">Legal Deadlines</h1>

      <div className="space-y-3">
        {deadlines.map((dl) => {
          const days = daysUntil(dl.deadline_date);
          const isUrgent = days <= 7;
          const isPast = days < 0;

          return (
            <div
              key={dl.id}
              className={`bg-[#161822] rounded-lg border p-4 ${
                isPast ? 'border-red-700' : isUrgent ? 'border-orange-700' : 'border-gray-800'
              }`}
            >
              <div className="flex items-center justify-between">
                <div>
                  <div className="flex items-center gap-2">
                    <span className="text-xs px-2 py-0.5 rounded bg-purple-700 text-white">
                      {dl.deadline_type}
                    </span>
                    <span className="text-xs text-gray-500">{dl.case_ref}</span>
                  </div>
                  <h3 className="text-white font-medium mt-1">{dl.title}</h3>
                </div>
                <div className="text-right">
                  <p className={`text-lg font-mono font-bold ${
                    isPast ? 'text-red-400' : isUrgent ? 'text-orange-400' : days <= 30 ? 'text-yellow-400' : 'text-gray-400'
                  }`}>
                    {isPast ? `${Math.abs(days)}d PAST` : days === 0 ? 'TODAY' : `${days}d`}
                  </p>
                  <p className="text-gray-500 text-xs">{formatDate(dl.deadline_date)}</p>
                </div>
              </div>
            </div>
          );
        })}
      </div>

      {deadlines.length === 0 && (
        <p className="text-gray-500 text-center py-8">No upcoming legal deadlines</p>
      )}
    </div>
  );
}
