import { useEffect, useState, useCallback, useRef } from 'react';
import { api, type QueueItem, type QueueStats, type DecisionHistory } from '../lib/api';
import { SwipeStack } from '../components/swipe/SwipeStack';
import { SwipeStatsBar } from '../components/swipe/SwipeStatsBar';
import { DesktopControls } from '../components/swipe/DesktopControls';
import { useKeyboardShortcuts } from '../hooks/useKeyboardShortcuts';
import { ActionButton } from '../components/ui/ActionButton';
import { Card } from '../components/ui/Card';
import { useToast } from '../lib/toast';
import { formatDate, formatCurrency, cn } from '../lib/utils';
import { History, CheckCircle, XCircle, Clock } from 'lucide-react';

type QueueTab = 'active' | 'history';

export function ActionQueue() {
  const [items, setItems] = useState<QueueItem[]>([]);
  const [stats, setStats] = useState<QueueStats>({ approved: 0, rejected: 0, deferred: 0, modified: 0, total: 0, savings: 0 });
  const [loading, setLoading] = useState(true);
  const [generating, setGenerating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState<QueueTab>('active');
  const [history, setHistory] = useState<DecisionHistory[]>([]);
  const [historyLoading, setHistoryLoading] = useState(false);
  const sessionId = useRef(crypto.randomUUID());
  const autoTriageAttempted = useRef(false);
  const toast = useToast();

  const runTriage = useCallback(async (auto = false) => {
    setGenerating(true);
    setError(null);

    if (auto) {
      toast.info('Queue is empty', 'Running triage automatically...');
    }

    try {
      const result = await api.generateRecommendations();
      const created = result.recommendations_created;
      if (created > 0) {
        toast.success(
          auto ? 'Queue ready' : 'Triage complete',
          `Created ${created} recommendation${created === 1 ? '' : 's'}.`,
          { durationMs: 2500 },
        );
      } else {
        toast.info('No new recommendations', 'Everything is already up to date.', { durationMs: 2500 });
      }
      return true;
    } catch (e: unknown) {
      const message = e instanceof Error ? e.message : 'Triage failed';
      setError(message);
      toast.error('Triage failed', message);
      return false;
    } finally {
      setGenerating(false);
    }
  }, [toast]);

  const loadQueue = useCallback(async (allowAutoTriage = true) => {
    try {
      const data = await api.getQueue(10);

      if (data.length === 0 && allowAutoTriage && !autoTriageAttempted.current) {
        autoTriageAttempted.current = true;
        const generated = await runTriage(true);
        if (generated) {
          const refreshed = await api.getQueue(10);
          setItems(refreshed);
          return;
        }
      }

      setItems(data);
    } catch (e: unknown) {
      const message = e instanceof Error ? e.message : 'Failed to load queue';
      setError(message);
      toast.error('Could not load queue', message);
    } finally {
      setLoading(false);
    }
  }, [runTriage, toast]);

  const loadStats = useCallback(async () => {
    try {
      const data = await api.getQueueStats(sessionId.current);
      setStats(data);
    } catch {
      // Stats are non-critical
    }
  }, []);

  const [historyError, setHistoryError] = useState(false);

  const loadHistory = useCallback(async () => {
    setHistoryLoading(true);
    setHistoryError(false);
    try {
      const data = await api.getQueueHistory(50);
      setHistory(data);
    } catch (e: unknown) {
      console.error('[ActionQueue] history load failed:', e);
      setHistoryError(true);
    } finally {
      setHistoryLoading(false);
    }
  }, []);

  useEffect(() => {
    loadQueue();
    loadStats();
  }, [loadQueue, loadStats]);

  useEffect(() => {
    if (activeTab === 'history' && history.length === 0) loadHistory();
  }, [activeTab, history.length, loadHistory]);

  const isPaymentAction = useCallback((item: QueueItem) => {
    const type = item.action_type;
    return type === 'pay_now' || type === 'pay_full' || type === 'pay_minimum';
  }, []);

  const handleDecide = useCallback(async (id: string, decision: 'approved' | 'rejected' | 'deferred') => {
    try {
      const current = items.find((item) => item.id === id);
      await api.decideQueue(id, decision, sessionId.current);

      // Queue approval now only records decision; execute payment explicitly.
      if (decision === 'approved' && current?.obligation_id && isPaymentAction(current)) {
        try {
          await api.markPaid(current.obligation_id);
          toast.success('Payment executed', current.title, { durationMs: 2200 });
        } catch (paymentErr: unknown) {
          const message = paymentErr instanceof Error ? paymentErr.message : 'Payment execution failed';
          toast.error('Approved, but execution failed', message);
        }
      }

      setItems((prev) => prev.filter((item) => item.id !== id));
      loadStats();

      if (current) {
        const title = current.title.length > 60 ? `${current.title.slice(0, 57)}...` : current.title;
        if (decision === 'approved') {
          if (!current.obligation_id || !isPaymentAction(current)) {
            toast.success('Approved', title, { durationMs: 2000 });
          }
        } else if (decision === 'rejected') {
          toast.info('Rejected', title, { durationMs: 2000 });
        } else {
          toast.info('Deferred', title, { durationMs: 2000 });
        }
      }
    } catch (e: unknown) {
      const message = e instanceof Error ? e.message : 'Decision failed';
      setError(message);
      toast.error('Decision failed', message);
    }
  }, [isPaymentAction, items, loadStats, toast]);

  const handleGenerate = useCallback(async () => {
    const generated = await runTriage(false);
    if (generated) {
      await loadQueue(false);
    }
  }, [loadQueue, runTriage]);

  // Keyboard shortcuts for desktop
  const currentItem = items[0];
  useKeyboardShortcuts({
    onApprove: () => currentItem && handleDecide(currentItem.id, 'approved'),
    onReject: () => currentItem && handleDecide(currentItem.id, 'rejected'),
    onDefer: () => currentItem && handleDecide(currentItem.id, 'deferred'),
    enabled: items.length > 0,
  });

  if (loading) {
    return <div className="text-chrome-muted py-8 text-center">Loading action queue...</div>;
  }

  const decisionIcon = (decision: string) => {
    if (decision === 'approved') return <CheckCircle size={14} className="text-urgency-green" />;
    if (decision === 'rejected') return <XCircle size={14} className="text-urgency-red" />;
    return <Clock size={14} className="text-urgency-amber" />;
  };

  return (
    <div className="space-y-4">
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
        <h1 className="text-lg lg:text-xl font-bold text-chrome-text">Action Queue</h1>
        <div className="flex items-center gap-2">
          {activeTab === 'active' && (
            <ActionButton
              label={generating ? 'Analyzing...' : 'Run Triage'}
              onClick={handleGenerate}
              loading={generating}
            />
          )}
        </div>
      </div>

      {/* Tabs */}
      <div className="flex gap-1 bg-card-hover rounded-lg p-1 border border-card-border">
        <button
          onClick={() => setActiveTab('active')}
          className={cn(
            'flex-1 px-3 py-1.5 rounded-md text-sm font-medium transition-colors flex items-center justify-center gap-2',
            activeTab === 'active' ? 'bg-chitty-600 text-white' : 'text-card-muted hover:text-card-text',
          )}
        >
          Active ({items.length})
        </button>
        <button
          onClick={() => setActiveTab('history')}
          className={cn(
            'flex-1 px-3 py-1.5 rounded-md text-sm font-medium transition-colors flex items-center justify-center gap-2',
            activeTab === 'history' ? 'bg-chitty-600 text-white' : 'text-card-muted hover:text-card-text',
          )}
        >
          <History size={14} /> History
        </button>
      </div>

      {error && (
        <Card urgency="red">
          <p className="text-urgency-red text-sm">{error}</p>
        </Card>
      )}

      {/* Active tab */}
      {activeTab === 'active' && (
        <>
          {/* Stats bar */}
          {stats.total > 0 && (
            <SwipeStatsBar
              approved={stats.approved}
              rejected={stats.rejected}
              deferred={stats.deferred}
              total={stats.total}
              savings={stats.savings}
            />
          )}

          {/* Swipe stack */}
          <SwipeStack
            items={items}
            onDecide={handleDecide}
            onLoadMore={() => loadQueue(false)}
          />

          {/* Desktop controls */}
          {items.length > 0 && (
            <DesktopControls
              onApprove={() => currentItem && handleDecide(currentItem.id, 'approved')}
              onReject={() => currentItem && handleDecide(currentItem.id, 'rejected')}
              onDefer={() => currentItem && handleDecide(currentItem.id, 'deferred')}
              disabled={!currentItem}
            />
          )}

          {/* Mobile swipe hint */}
          {items.length > 0 && (
            <p className="text-center text-card-muted text-xs sm:hidden">
              Swipe right to approve, left to reject, up to defer
            </p>
          )}
        </>
      )}

      {/* History tab */}
      {activeTab === 'history' && (
        <div className="space-y-2">
          {historyLoading ? (
            <p className="text-card-muted text-center py-8">Loading history...</p>
          ) : historyError ? (
            <Card className="text-center py-8">
              <p className="text-urgency-red">Failed to load decision history.</p>
              <ActionButton label="Retry" variant="secondary" onClick={loadHistory} className="mt-2" />
            </Card>
          ) : history.length === 0 ? (
            <Card className="text-center py-8">
              <p className="text-card-muted">No decision history yet.</p>
              <p className="text-card-muted text-sm mt-1">Decisions you make in the Action Queue will appear here.</p>
            </Card>
          ) : (
            history.map((h) => (
              <Card key={h.id}>
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-3 min-w-0 flex-1">
                    {decisionIcon(h.decision)}
                    <div className="min-w-0 flex-1">
                      <p className="text-card-text text-sm font-medium truncate">{h.title || 'Untitled'}</p>
                      <div className="flex items-center gap-2 mt-0.5 flex-wrap">
                        <span className={cn(
                          'text-xs px-1.5 py-0.5 rounded-full font-medium',
                          h.decision === 'approved' ? 'bg-green-100 text-green-700' :
                          h.decision === 'rejected' ? 'bg-red-100 text-red-700' :
                          'bg-amber-100 text-amber-700',
                        )}>{h.decision}</span>
                        {h.rec_type && <span className="text-xs text-card-muted">{h.rec_type}</span>}
                        {h.obligation_payee && <span className="text-xs text-card-muted">{h.obligation_payee}</span>}
                      </div>
                    </div>
                  </div>
                  <div className="text-right shrink-0">
                    {h.estimated_savings && parseFloat(h.estimated_savings) > 0 && (
                      <p className="text-xs text-urgency-green font-mono">{formatCurrency(h.estimated_savings)}</p>
                    )}
                    <p className="text-xs text-card-muted">{formatDate(h.created_at)}</p>
                  </div>
                </div>
              </Card>
            ))
          )}
        </div>
      )}
    </div>
  );
}
