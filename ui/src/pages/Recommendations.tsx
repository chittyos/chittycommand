import { useEffect, useState } from 'react';
import { api, type Recommendation } from '../lib/api';

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
    } catch (e: any) {
      setError(e.message);
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
    } catch (e: any) {
      setError(e.message);
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

  if (loading) return <div className="text-gray-400">Loading recommendations...</div>;

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-bold text-white">AI Recommendations</h1>
        <button
          onClick={generate}
          disabled={generating}
          className="px-4 py-2 text-sm bg-chitty-600 text-white rounded-lg hover:bg-chitty-700 disabled:opacity-50 transition-colors font-medium"
        >
          {generating ? 'Analyzing...' : 'Run Triage'}
        </button>
      </div>

      {error && (
        <div className="bg-red-900/30 border border-red-700 rounded-lg p-3 text-red-400 text-sm">{error}</div>
      )}

      {triageResult && (
        <div className="bg-[#161822] rounded-lg border border-gray-800 p-4 grid grid-cols-4 gap-4 text-sm">
          <div>
            <p className="text-gray-500">Obligations Scored</p>
            <p className="text-white text-lg font-bold">{triageResult.obligations_scored}</p>
          </div>
          <div>
            <p className="text-gray-500">New Recommendations</p>
            <p className="text-white text-lg font-bold">{triageResult.recommendations_created}</p>
          </div>
          <div>
            <p className="text-gray-500">Cash Available</p>
            <p className="text-white text-lg font-bold">${triageResult.cash_position.total_cash.toLocaleString()}</p>
          </div>
          <div>
            <p className="text-gray-500">30-Day Surplus</p>
            <p className={`text-lg font-bold ${triageResult.cash_position.surplus >= 0 ? 'text-green-400' : 'text-red-400'}`}>
              {triageResult.cash_position.surplus >= 0 ? '+' : ''}${triageResult.cash_position.surplus.toLocaleString()}
            </p>
          </div>
        </div>
      )}

      {recs.length === 0 ? (
        <div className="bg-[#161822] rounded-lg border border-gray-800 p-8 text-center">
          <p className="text-gray-400">No active recommendations.</p>
          <p className="text-gray-600 text-sm mt-1">Click "Run Triage" to analyze your obligations and generate recommendations.</p>
        </div>
      ) : (
        <div className="space-y-3">
          {recs.map((rec) => (
            <div key={rec.id} className="bg-[#161822] rounded-lg border border-gray-800 p-4">
              <div className="flex items-start justify-between gap-4">
                <div className="flex-1">
                  <div className="flex items-center gap-2 mb-1">
                    <PriorityBadge priority={rec.priority} />
                    <TypeBadge type={rec.rec_type} />
                    {rec.obligation_payee && (
                      <span className="text-xs text-gray-500">{rec.obligation_payee}</span>
                    )}
                    {rec.dispute_title && (
                      <span className="text-xs text-gray-500">{rec.dispute_title}</span>
                    )}
                  </div>
                  <h3 className="text-white font-medium">{rec.title}</h3>
                  <p className="text-gray-400 text-sm mt-1">{rec.reasoning}</p>
                </div>
                <div className="flex gap-2 shrink-0">
                  <button
                    onClick={() => act(rec.id, rec.action_type || 'acted')}
                    className="px-3 py-1.5 text-xs bg-chitty-600 text-white rounded hover:bg-chitty-700 transition-colors font-medium"
                  >
                    {actionLabel(rec.action_type)}
                  </button>
                  <button
                    onClick={() => dismiss(rec.id)}
                    className="px-3 py-1.5 text-xs bg-gray-700 text-gray-300 rounded hover:bg-gray-600 transition-colors"
                  >
                    Dismiss
                  </button>
                </div>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function PriorityBadge({ priority }: { priority: number }) {
  const colors: Record<number, string> = {
    1: 'bg-red-600 text-white',
    2: 'bg-orange-600 text-white',
    3: 'bg-yellow-600 text-white',
    4: 'bg-blue-600 text-white',
    5: 'bg-gray-600 text-white',
  };
  return (
    <span className={`text-xs px-1.5 py-0.5 rounded font-medium ${colors[priority] || colors[5]}`}>
      P{priority}
    </span>
  );
}

function TypeBadge({ type }: { type: string }) {
  const colors: Record<string, string> = {
    payment: 'bg-green-900/50 text-green-400 border-green-800',
    negotiate: 'bg-purple-900/50 text-purple-400 border-purple-800',
    defer: 'bg-gray-800 text-gray-400 border-gray-700',
    dispute: 'bg-orange-900/50 text-orange-400 border-orange-800',
    legal: 'bg-red-900/50 text-red-400 border-red-800',
    warning: 'bg-yellow-900/50 text-yellow-400 border-yellow-800',
    strategy: 'bg-blue-900/50 text-blue-400 border-blue-800',
  };
  return (
    <span className={`text-xs px-1.5 py-0.5 rounded border ${colors[type] || 'bg-gray-800 text-gray-400 border-gray-700'}`}>
      {type}
    </span>
  );
}

function actionLabel(type: string | null): string {
  const labels: Record<string, string> = {
    pay_now: 'Pay Now',
    pay_minimum: 'Pay Minimum',
    negotiate: 'Start Negotiation',
    defer: 'Defer',
    execute_action: 'Execute',
    plan_action: 'Plan',
    prepare_legal: 'Prepare',
    review_cashflow: 'Review',
    execute_browser: 'Automate',
    send_email: 'Send',
  };
  return labels[type || ''] || 'Act';
}
