import { useEffect, useState, useCallback, useRef } from 'react';
import { api, type QueueItem, type QueueStats } from '../lib/api';
import { SwipeStack } from '../components/swipe/SwipeStack';
import { SwipeStatsBar } from '../components/swipe/SwipeStatsBar';
import { DesktopControls } from '../components/swipe/DesktopControls';
import { useKeyboardShortcuts } from '../hooks/useKeyboardShortcuts';
import { ActionButton } from '../components/ui/ActionButton';
import { Card } from '../components/ui/Card';
import { useToast } from '../lib/toast';

export function ActionQueue() {
  const [items, setItems] = useState<QueueItem[]>([]);
  const [stats, setStats] = useState<QueueStats>({ approved: 0, rejected: 0, deferred: 0, modified: 0, total: 0, savings: 0 });
  const [loading, setLoading] = useState(true);
  const [generating, setGenerating] = useState(false);
  const [error, setError] = useState<string | null>(null);
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

  useEffect(() => {
    loadQueue();
    loadStats();
  }, [loadQueue, loadStats]);

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

  return (
    <div className="space-y-4">
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
        <h1 className="text-lg lg:text-xl font-bold text-chrome-text">Action Queue</h1>
        <ActionButton
          label={generating ? 'Analyzing...' : 'Run Triage'}
          onClick={handleGenerate}
          loading={generating}
        />
      </div>

      {error && (
        <Card urgency="red">
          <p className="text-urgency-red text-sm">{error}</p>
        </Card>
      )}

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
    </div>
  );
}
