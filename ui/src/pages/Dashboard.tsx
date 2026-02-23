import { useEffect, useState, useCallback } from 'react';
import { api, type DashboardData, type Obligation, type Recommendation } from '../lib/api';
import { formatCurrency, formatDate, daysUntil, urgencyColor, urgencyBg, statusBadgeColor } from '../lib/utils';

export function Dashboard() {
  const [data, setData] = useState<DashboardData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [payingId, setPayingId] = useState<string | null>(null);
  const [executingId, setExecutingId] = useState<string | null>(null);

  const reload = useCallback(() => {
    api.getDashboard().then(setData).catch((e) => setError(e.message));
  }, []);

  useEffect(() => { reload(); }, [reload]);

  const handlePayNow = async (ob: Obligation) => {
    if (payingId) return;
    setPayingId(ob.id);
    try {
      await api.markPaid(ob.id);
      reload();
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : 'Payment failed');
    } finally {
      setPayingId(null);
    }
  };

  const handleExecute = async (rec: Recommendation) => {
    if (executingId) return;
    setExecutingId(rec.id);
    try {
      await api.actOnRecommendation(rec.id, { action_taken: rec.action_type || 'executed' });
      reload();
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : 'Execution failed');
    } finally {
      setExecutingId(null);
    }
  };

  if (error) {
    return (
      <div className="text-center py-20">
        <p className="text-red-400 text-lg">Failed to load dashboard</p>
        <p className="text-gray-500 mt-2">{error}</p>
        <p className="text-gray-600 mt-4 text-sm">Make sure the API is running: <code>npm run dev</code></p>
      </div>
    );
  }

  if (!data) {
    return <div className="text-center py-20 text-gray-500">Loading...</div>;
  }

  const { summary, obligations, disputes, deadlines, recommendations } = data;

  return (
    <div className="space-y-6">
      {/* Summary Cards */}
      <div className="grid grid-cols-4 gap-4">
        <SummaryCard label="Cash Available" value={formatCurrency(summary.total_cash)} color="text-green-400" />
        <SummaryCard label="Credit Owed" value={formatCurrency(summary.total_credit_owed)} color="text-red-400" />
        <SummaryCard label="Due Next 30 Days" value={formatCurrency(obligations.total_due_30d)} color="text-orange-400" />
        <SummaryCard label="Overdue Bills" value={obligations.overdue_count} color={Number(obligations.overdue_count) > 0 ? 'text-red-400' : 'text-green-400'} />
      </div>

      {/* Urgency Banner */}
      {obligations.urgent.length > 0 && obligations.urgent[0].urgency_score && obligations.urgent[0].urgency_score >= 50 && (
        <div className={`p-4 rounded-lg border ${urgencyBg(obligations.urgent[0].urgency_score)}`}>
          <div className="flex items-center justify-between">
            <div>
              <span className={`text-sm font-semibold ${urgencyColor(obligations.urgent[0].urgency_score)}`}>
                MOST URGENT
              </span>
              <p className="text-white font-medium mt-1">
                {obligations.urgent[0].payee} — {formatCurrency(obligations.urgent[0].amount_due)}
              </p>
              <p className="text-gray-400 text-sm">
                {obligations.urgent[0].status === 'overdue'
                  ? `OVERDUE ${Math.abs(daysUntil(obligations.urgent[0].due_date))} days`
                  : `Due ${formatDate(obligations.urgent[0].due_date)}`}
              </p>
            </div>
            <button
              onClick={() => handlePayNow(obligations.urgent[0])}
              disabled={payingId === obligations.urgent[0].id}
              className="px-4 py-2 bg-chitty-600 text-white rounded font-medium hover:bg-chitty-700 transition-colors disabled:opacity-50"
            >
              {payingId === obligations.urgent[0].id ? 'Paying...' : 'Pay Now'}
            </button>
          </div>
        </div>
      )}

      <div className="grid grid-cols-2 gap-6">
        {/* Urgent Obligations */}
        <div className="bg-[#161822] rounded-lg border border-gray-800 p-4">
          <h2 className="text-white font-semibold mb-3">Upcoming Bills</h2>
          <div className="space-y-2">
            {obligations.urgent.map((ob) => (
              <div key={ob.id} className="flex items-center justify-between py-2 border-b border-gray-800 last:border-0">
                <div className="flex items-center gap-3">
                  <div className={`w-2 h-2 rounded-full ${ob.urgency_score && ob.urgency_score >= 70 ? 'bg-red-500' : ob.urgency_score && ob.urgency_score >= 50 ? 'bg-orange-500' : ob.urgency_score && ob.urgency_score >= 30 ? 'bg-yellow-500' : 'bg-green-500'}`} />
                  <div>
                    <p className="text-white text-sm">{ob.payee}</p>
                    <p className="text-gray-500 text-xs">{ob.category} {ob.due_date ? `- Due ${formatDate(ob.due_date)}` : ''}</p>
                  </div>
                </div>
                <div className="text-right">
                  <p className="text-white text-sm">{formatCurrency(ob.amount_due)}</p>
                  <span className={`text-xs px-1.5 py-0.5 rounded ${statusBadgeColor(ob.status)} text-white`}>
                    {ob.status}
                  </span>
                </div>
              </div>
            ))}
            {obligations.urgent.length === 0 && (
              <p className="text-gray-500 text-sm py-4 text-center">No pending obligations</p>
            )}
          </div>
        </div>

        {/* Active Disputes */}
        <div className="bg-[#161822] rounded-lg border border-gray-800 p-4">
          <h2 className="text-white font-semibold mb-3">Active Disputes</h2>
          <div className="space-y-3">
            {disputes.map((d) => (
              <div key={d.id} className="p-3 rounded bg-[#1c1f2e] border border-gray-700">
                <div className="flex items-start justify-between">
                  <div>
                    <p className="text-white text-sm font-medium">{d.title}</p>
                    <p className="text-gray-400 text-xs mt-1">vs {d.counterparty}</p>
                  </div>
                  {d.amount_at_stake && (
                    <span className="text-red-400 text-sm font-mono">{formatCurrency(d.amount_at_stake)}</span>
                  )}
                </div>
                {d.next_action && (
                  <p className="text-chitty-500 text-xs mt-2">Next: {d.next_action}</p>
                )}
              </div>
            ))}
            {disputes.length === 0 && (
              <p className="text-gray-500 text-sm py-4 text-center">No active disputes</p>
            )}
          </div>
        </div>
      </div>

      <div className="grid grid-cols-2 gap-6">
        {/* Legal Deadlines */}
        <div className="bg-[#161822] rounded-lg border border-gray-800 p-4">
          <h2 className="text-white font-semibold mb-3">Legal Deadlines</h2>
          <div className="space-y-2">
            {deadlines.map((dl) => {
              const days = daysUntil(dl.deadline_date);
              return (
                <div key={dl.id} className="flex items-center justify-between py-2 border-b border-gray-800 last:border-0">
                  <div>
                    <p className="text-white text-sm">{dl.title}</p>
                    <p className="text-gray-500 text-xs">{dl.case_ref}</p>
                  </div>
                  <div className="text-right">
                    <p className={`text-sm font-mono ${days <= 7 ? 'text-red-400' : days <= 30 ? 'text-yellow-400' : 'text-gray-400'}`}>
                      {days > 0 ? `${days}d` : days === 0 ? 'TODAY' : `${Math.abs(days)}d ago`}
                    </p>
                    <p className="text-gray-500 text-xs">{formatDate(dl.deadline_date)}</p>
                  </div>
                </div>
              );
            })}
            {deadlines.length === 0 && (
              <p className="text-gray-500 text-sm py-4 text-center">No upcoming deadlines</p>
            )}
          </div>
        </div>

        {/* AI Recommendations */}
        <div className="bg-[#161822] rounded-lg border border-gray-800 p-4">
          <h2 className="text-white font-semibold mb-3">AI Recommendations</h2>
          <div className="space-y-2">
            {recommendations.map((rec) => (
              <div key={rec.id} className="p-3 rounded bg-[#1c1f2e] border border-gray-700">
                <div className="flex items-start justify-between">
                  <div>
                    <span className="text-xs px-1.5 py-0.5 rounded bg-chitty-600 text-white mr-2">{rec.rec_type}</span>
                    <span className="text-white text-sm">{rec.title}</span>
                  </div>
                  <span className="text-gray-500 text-xs">#{rec.priority}</span>
                </div>
                <p className="text-gray-400 text-xs mt-1">{rec.reasoning}</p>
                {rec.action_type && (
                  <button
                    onClick={() => handleExecute(rec)}
                    disabled={executingId === rec.id}
                    className="mt-2 px-3 py-1 text-xs bg-chitty-600 text-white rounded hover:bg-chitty-700 disabled:opacity-50"
                  >
                    {executingId === rec.id ? 'Running...' : 'Execute'}
                  </button>
                )}
              </div>
            ))}
            {recommendations.length === 0 && (
              <p className="text-gray-500 text-sm py-4 text-center">No recommendations yet — AI triage will generate these</p>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

function SummaryCard({ label, value, color }: { label: string; value: string; color: string }) {
  return (
    <div className="bg-[#161822] rounded-lg border border-gray-800 p-4">
      <p className="text-gray-400 text-xs uppercase tracking-wider">{label}</p>
      <p className={`text-2xl font-bold mt-1 ${color}`}>{value}</p>
    </div>
  );
}
