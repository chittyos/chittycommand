import { useEffect, useState, useCallback, useRef } from 'react';
import { api, type QueueItem, type QueueStats } from '../lib/api';
import { SwipeStack } from '../components/swipe/SwipeStack';
import { SwipeStatsBar } from '../components/swipe/SwipeStatsBar';
import { DesktopControls } from '../components/swipe/DesktopControls';
import { useKeyboardShortcuts } from '../hooks/useKeyboardShortcuts';
import { ActionButton } from '../components/ui/ActionButton';
import { Card } from '../components/ui/Card';

export function ActionQueue() {
  const [items, setItems] = useState<QueueItem[]>([]);
  const [stats, setStats] = useState<QueueStats>({ approved: 0, rejected: 0, deferred: 0, modified: 0, total: 0, savings: 0 });
  const [loading, setLoading] = useState(true);
  const [generating, setGenerating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const sessionId = useRef(crypto.randomUUID());

  const loadQueue = useCallback(async () => {
    try {
      const data = await api.getQueue(10);
      setItems(data);
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : 'Failed to load queue');
    } finally {
      setLoading(false);
    }
  }, []);

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

  const handleDecide = useCallback(async (id: string, decision: 'approved' | 'rejected' | 'deferred') => {
    try {
      await api.decideQueue(id, decision, sessionId.current);
      setItems((prev) => prev.filter((item) => item.id !== id));
      loadStats();
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : 'Decision failed');
    }
  }, [loadStats]);

  const handleGenerate = useCallback(async () => {
    setGenerating(true);
    setError(null);
    try {
      await api.generateRecommendations();
      await loadQueue();
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : 'Triage failed');
    } finally {
      setGenerating(false);
    }
  }, [loadQueue]);

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
        onLoadMore={loadQueue}
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
