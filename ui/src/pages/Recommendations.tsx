import { useEffect, useState } from 'react';
import { api, type Recommendation } from '../lib/api';
import { Card } from '../components/ui/Card';
import { MetricCard } from '../components/ui/MetricCard';
import { ActionButton } from '../components/ui/ActionButton';
import { formatCurrency } from '../lib/utils';

export function Recommendations() {
  const [recs, setRecs] = useState<Recommendation[]>([]);
  const [loading, setLoading] = useState(true);
  const [generating, setGenerating] = useState(false);
  const [triageResult, setTriageResult] = useState<{
    obligations_scored: number;
    recommendations_created: number;
    cash_position: { total_cash: number; total_due_30d: number; surplus: number };
  } | null>(null);
  const [error, setError] = useState<string | null>(null);

  const loadRecs = async () => {
    try {
      const data = await api.getRecommendations();
      setRecs(data);
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : 'Load failed');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { loadRecs(); }, []);

  const generate = async () => {
    setGenerating(true);
    setError(null);
    try {
      const result = await api.generateRecommendations();
      setTriageResult(result);
      await loadRecs();
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : 'Generation failed');
    } finally {
      setGenerating(false);
    }
  };

  const act = async (id: string, action: string) => {
    await api.actOnRecommendation(id, { action_taken: action });
    setRecs(recs.filter(r => r.id !== id));
  };

  const dismiss = async (id: string) => {
    await api.dismissRecommendation(id);
    setRecs(recs.filter(r => r.id !== id));
  };

  if (loading) return <div className="text-chrome-muted py-8">Loading recommendations...</div>;

  const priorityColors: Record<number, string> = {
    1: 'bg-red-100 text-red-700',
    2: 'bg-orange-100 text-orange-700',
    3: 'bg-amber-100 text-amber-700',
    4: 'bg-blue-100 text-blue-700',
    5: 'bg-gray-100 text-gray-700',
  };

  const typeColors: Record<string, string> = {
    payment: 'bg-green-50 text-green-700 border-green-200',
    negotiate: 'bg-purple-50 text-purple-700 border-purple-200',
    defer: 'bg-gray-50 text-gray-600 border-gray-200',
    dispute: 'bg-orange-50 text-orange-700 border-orange-200',
    legal: 'bg-red-50 text-red-700 border-red-200',
    warning: 'bg-amber-50 text-amber-700 border-amber-200',
    strategy: 'bg-blue-50 text-blue-700 border-blue-200',
  };

  const actionLabel = (type: string | null): string => {
    const labels: Record<string, string> = {
      pay_now: 'Pay Now', pay_minimum: 'Pay Minimum', negotiate: 'Start Negotiation',
      defer: 'Defer', execute_action: 'Execute', plan_action: 'Plan',
      prepare_legal: 'Prepare', review_cashflow: 'Review', execute_browser: 'Automate', send_email: 'Send',
    };
    return labels[type || ''] || 'Act';
  };

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-bold text-chrome-text">AI Recommendations</h1>
        <ActionButton
          label={generating ? 'Analyzing...' : 'Run Triage'}
          onClick={generate}
          loading={generating}
        />
      </div>

      {error && (
        <div className="bg-red-50 border border-red-200 rounded-card p-3 text-urgency-red text-sm">{error}</div>
      )}

      {triageResult && (
        <div className="grid grid-cols-4 gap-3">
          <MetricCard label="Scored" value={String(triageResult.obligations_scored)} />
          <MetricCard label="New Recs" value={String(triageResult.recommendations_created)} />
          <MetricCard label="Cash Available" value={formatCurrency(triageResult.cash_position.total_cash)} valueClassName="text-urgency-green" />
          <MetricCard label="30d Surplus" value={`${triageResult.cash_position.surplus >= 0 ? '+' : ''}${formatCurrency(triageResult.cash_position.surplus)}`} valueClassName={triageResult.cash_position.surplus >= 0 ? 'text-urgency-green' : 'text-urgency-red'} />
        </div>
      )}

      {recs.length === 0 ? (
        <Card className="text-center py-8">
          <p className="text-card-muted">No active recommendations.</p>
          <p className="text-card-muted text-sm mt-1">Click "Run Triage" to analyze obligations.</p>
        </Card>
      ) : (
        <div className="space-y-2">
          {recs.map((rec) => (
            <Card key={rec.id} urgency={rec.priority <= 2 ? 'amber' : rec.priority <= 3 ? 'green' : null}>
              <div className="flex items-start justify-between gap-4">
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 mb-1 flex-wrap">
                    <span className={`text-xs px-2 py-0.5 rounded-full font-medium ${priorityColors[rec.priority] || priorityColors[5]}`}>
                      P{rec.priority}
                    </span>
                    <span className={`text-xs px-2 py-0.5 rounded-full border ${typeColors[rec.rec_type] || 'bg-gray-50 text-gray-600 border-gray-200'}`}>
                      {rec.rec_type}
                    </span>
                    {rec.obligation_payee && <span className="text-xs text-card-muted">{rec.obligation_payee}</span>}
                    {rec.dispute_title && <span className="text-xs text-card-muted">{rec.dispute_title}</span>}
                  </div>
                  <h3 className="font-medium text-card-text">{rec.title}</h3>
                  <p className="text-card-muted text-sm mt-1">{rec.reasoning}</p>
                </div>
                <div className="flex gap-2 shrink-0">
                  <ActionButton
                    label={actionLabel(rec.action_type)}
                    onClick={() => act(rec.id, rec.action_type || 'acted')}
                  />
                  <ActionButton
                    label="Dismiss"
                    variant="secondary"
                    onClick={() => dismiss(rec.id)}
                  />
                </div>
              </div>
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}
