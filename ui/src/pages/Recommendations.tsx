import { useEffect, useState } from 'react';
import { api, type Recommendation } from '../lib/api';
import { Card } from '../components/ui/Card';
import { MetricCard } from '../components/ui/MetricCard';
import { ActionButton } from '../components/ui/ActionButton';
import { formatCurrency, cn } from '../lib/utils';
import { useToast } from '../lib/toast';
import { Calendar, Mail, Globe, Clock, X } from 'lucide-react';

type FollowThrough = {
  recId: string;
  type: string;
};

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
  const [followThrough, setFollowThrough] = useState<FollowThrough | null>(null);
  const [deferDate, setDeferDate] = useState('');
  const toast = useToast();

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
    // Actions that need follow-through UI
    const needsFollowThrough = ['defer', 'send_email', 'execute_browser', 'negotiate'];
    if (needsFollowThrough.includes(action)) {
      setFollowThrough({ recId: id, type: action });
      return;
    }

    try {
      await api.actOnRecommendation(id, { action_taken: action });
      setRecs(recs.filter(r => r.id !== id));
      toast.success('Action taken', `Recommendation marked as ${action}`);
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : 'Action failed';
      setError(msg);
    }
  };

  const confirmFollowThrough = async () => {
    if (!followThrough) return;
    const action = followThrough.type === 'defer' && deferDate
      ? `deferred_until:${deferDate}`
      : followThrough.type;

    try {
      await api.actOnRecommendation(followThrough.recId, { action_taken: action });
      setRecs(recs.filter(r => r.id !== followThrough.recId));
      toast.success('Action completed', `${followThrough.type} action recorded`);
      setFollowThrough(null);
      setDeferDate('');
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : 'Action failed');
    }
  };

  const dismiss = async (id: string) => {
    try {
      await api.dismissRecommendation(id);
      setRecs(recs.filter(r => r.id !== id));
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : 'Dismiss failed';
      setError(msg);
    }
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
      prepare_legal: 'Prepare', review_cashflow: 'Review', execute_browser: 'Automate', send_email: 'Send Email',
    };
    return labels[type || ''] || 'Act';
  };

  const actionIcon = (type: string | null) => {
    if (type === 'defer') return Calendar;
    if (type === 'send_email') return Mail;
    if (type === 'execute_browser') return Globe;
    if (type === 'negotiate') return Clock;
    return null;
  };

  const activeRec = followThrough ? recs.find(r => r.id === followThrough.recId) : null;

  return (
    <div className="space-y-6">
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
        <h1 className="text-lg lg:text-xl font-bold text-chrome-text">AI Recommendations</h1>
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
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-2 lg:gap-3">
          <MetricCard label="Scored" value={String(triageResult.obligations_scored)} />
          <MetricCard label="New Recs" value={String(triageResult.recommendations_created)} />
          <MetricCard label="Cash Available" value={formatCurrency(triageResult.cash_position.total_cash)} valueClassName="text-urgency-green" />
          <MetricCard label="30d Surplus" value={`${triageResult.cash_position.surplus >= 0 ? '+' : ''}${formatCurrency(triageResult.cash_position.surplus)}`} valueClassName={triageResult.cash_position.surplus >= 0 ? 'text-urgency-green' : 'text-urgency-red'} />
        </div>
      )}

      {/* Follow-through panel */}
      {followThrough && activeRec && (
        <Card urgency="amber">
          <div className="space-y-3">
            <div className="flex items-center justify-between">
              <h3 className="font-semibold text-card-text text-sm">
                {followThrough.type === 'defer' && 'Set Deferral Date'}
                {followThrough.type === 'send_email' && 'Email Action'}
                {followThrough.type === 'execute_browser' && 'Browser Automation'}
                {followThrough.type === 'negotiate' && 'Negotiation Plan'}
              </h3>
              <button onClick={() => { setFollowThrough(null); setDeferDate(''); }} className="text-card-muted hover:text-card-text">
                <X size={16} />
              </button>
            </div>

            <p className="text-card-muted text-sm">{activeRec.title}</p>

            {followThrough.type === 'defer' && (
              <div className="flex items-center gap-3">
                <input
                  type="date"
                  value={deferDate}
                  onChange={(e) => setDeferDate(e.target.value)}
                  min={new Date().toISOString().split('T')[0]}
                  className="px-3 py-2 rounded-lg bg-slate-50 border border-slate-200 text-card-text text-sm focus:outline-none focus:ring-2 focus:ring-chitty-500/50"
                />
                <ActionButton label="Confirm Deferral" onClick={confirmFollowThrough} disabled={!deferDate} />
              </div>
            )}

            {followThrough.type === 'send_email' && (
              <div className="space-y-2">
                <p className="text-xs text-card-muted">This will record the email action. Use Litigation AI to draft the email first.</p>
                <div className="flex gap-2">
                  <ActionButton label="Mark Email Sent" onClick={confirmFollowThrough} />
                  <ActionButton label="Draft in Litigation AI" variant="secondary" onClick={() => { window.location.href = '/litigation'; }} />
                </div>
              </div>
            )}

            {followThrough.type === 'execute_browser' && (
              <div className="space-y-2">
                <p className="text-xs text-card-muted">Browser automation tasks are queued for Claude in Chrome execution.</p>
                <ActionButton label="Queue for Automation" onClick={confirmFollowThrough} />
              </div>
            )}

            {followThrough.type === 'negotiate' && (
              <div className="space-y-2">
                <p className="text-xs text-card-muted">Record that you've initiated negotiation. Track progress in the dispute.</p>
                <div className="flex gap-2">
                  <ActionButton label="Mark Negotiation Started" onClick={confirmFollowThrough} />
                  {activeRec.dispute_title && (
                    <ActionButton label="View Dispute" variant="secondary" onClick={() => { window.location.href = '/disputes'; }} />
                  )}
                </div>
              </div>
            )}
          </div>
        </Card>
      )}

      {recs.length === 0 ? (
        <Card className="text-center py-8">
          <p className="text-card-muted">No active recommendations.</p>
          <p className="text-card-muted text-sm mt-1">Click "Run Triage" to analyze obligations.</p>
        </Card>
      ) : (
        <div className="space-y-2">
          {recs.map((rec) => {
            const Icon = actionIcon(rec.action_type);
            return (
              <Card key={rec.id} urgency={rec.priority <= 2 ? 'amber' : rec.priority <= 3 ? 'green' : null}>
                <div className="space-y-3">
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 mb-1 flex-wrap">
                      <span className={cn('text-xs px-2 py-0.5 rounded-full font-medium', priorityColors[rec.priority] || priorityColors[5])}>
                        P{rec.priority}
                      </span>
                      <span className={cn('text-xs px-2 py-0.5 rounded-full border', typeColors[rec.rec_type] || 'bg-gray-50 text-gray-600 border-gray-200')}>
                        {rec.rec_type}
                      </span>
                      {rec.obligation_payee && <span className="text-xs text-card-muted">{rec.obligation_payee}</span>}
                      {rec.dispute_title && <span className="text-xs text-card-muted">{rec.dispute_title}</span>}
                    </div>
                    <h3 className="font-medium text-card-text">{rec.title}</h3>
                    <p className="text-card-muted text-sm mt-1">{rec.reasoning}</p>
                  </div>
                  <div className="flex gap-2">
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
            );
          })}
        </div>
      )}
    </div>
  );
}
