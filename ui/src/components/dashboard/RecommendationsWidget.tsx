import { Card } from '../ui/Card';
import { ActionButton } from '../ui/ActionButton';
import type { Recommendation } from '../../lib/api';

interface Props {
  recommendations: Recommendation[];
  onExecute: (rec: Recommendation) => void;
  executingId: string | null;
}

export function RecommendationsWidget({ recommendations, onExecute, executingId }: Props) {
  if (recommendations.length === 0) return null;

  return (
    <div className="space-y-2">
      <h2 className="font-semibold text-chrome-text text-sm uppercase tracking-wider">AI Recommendations</h2>
      {recommendations.map((rec) => (
        <Card key={rec.id} urgency={rec.priority <= 2 ? 'amber' : null}>
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2 mb-1">
                <span className="text-xs px-1.5 py-0.5 rounded font-medium bg-chitty-600 text-white">{rec.rec_type}</span>
              </div>
              <p className="font-medium text-card-text">{rec.title}</p>
              <p className="text-card-muted text-xs mt-0.5 line-clamp-2">{rec.reasoning}</p>
            </div>
            {rec.action_type && (
              <ActionButton
                label="Execute"
                onClick={() => onExecute(rec)}
                loading={executingId === rec.id}
                className="shrink-0"
              />
            )}
          </div>
        </Card>
      ))}
    </div>
  );
}
