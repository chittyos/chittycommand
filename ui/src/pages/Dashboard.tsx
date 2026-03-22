import { useEffect, useState, useCallback, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import { api, type DashboardData, type Obligation, type Recommendation, type SyncStatus, type QueueStats, type QueueItem } from '../lib/api';
import { VitalSigns } from '../components/command/VitalSigns';
import { ActionStream } from '../components/command/ActionStream';
import { SystemPulse } from '../components/command/SystemPulse';
import { ConfirmDialog } from '../components/ui/ConfirmDialog';
import { useToast } from '../lib/toast';
import { formatCurrency, daysUntil } from '../lib/utils';

export function Dashboard() {
  const [data, setData] = useState<DashboardData | null>(null);
  const [syncs, setSyncs] = useState<SyncStatus[]>([]);
  const [queueStats, setQueueStats] = useState<QueueStats | null>(null);
  const [queueItems, setQueueItems] = useState<QueueItem[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [payingId, setPayingId] = useState<string | null>(null);
  const [executingId, setExecutingId] = useState<string | null>(null);
  const [pendingPayment, setPendingPayment] = useState<Obligation | null>(null);
  const [briefDismissed, setBriefDismissed] = useState(false);
  const toast = useToast();
  const navigate = useNavigate();
  const loadedRef = useRef(false);

  const loadAll = useCallback(async () => {
    try {
      const [dashData, syncData, statsData, queueData] = await Promise.allSettled([
        api.getDashboard(),
        api.getSyncStatus(),
        api.getQueueStats(),
        api.getQueue(5),
      ]);

      if (dashData.status === 'fulfilled') setData(dashData.value);
      else setError(dashData.reason?.message || 'Dashboard load failed');

      if (syncData.status === 'fulfilled') setSyncs(syncData.value);
      if (statsData.status === 'fulfilled') setQueueStats(statsData.value);
      if (queueData.status === 'fulfilled') setQueueItems(queueData.value);
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : 'Failed to load');
    }
  }, []);

  useEffect(() => {
    if (!loadedRef.current) {
      loadedRef.current = true;
      loadAll();
    }
  }, [loadAll]);

  // Auto-refresh every 5 minutes
  useEffect(() => {
    const interval = setInterval(loadAll, 5 * 60 * 1000);
    return () => clearInterval(interval);
  }, [loadAll]);

  const requestPayNow = useCallback((ob: Obligation) => {
    if (payingId) return;
    setPendingPayment(ob);
  }, [payingId]);

  const handleConfirmPayNow = useCallback(async () => {
    if (!pendingPayment || payingId) return;
    setPayingId(pendingPayment.id);
    try {
      await api.markPaid(pendingPayment.id);
      toast.success('Marked as paid', `${pendingPayment.payee}: ${formatCurrency(pendingPayment.amount_due)}`, { durationMs: 2500 });
      setPendingPayment(null);
      loadAll();
    } catch (e: unknown) {
      const message = e instanceof Error ? e.message : 'Payment failed';
      toast.error('Could not mark paid', message);
    } finally {
      setPayingId(null);
    }
  }, [payingId, pendingPayment, loadAll, toast]);

  const handleExecute = useCallback(async (rec: Recommendation) => {
    if (executingId) return;
    setExecutingId(rec.id);
    try {
      await api.actOnRecommendation(rec.id, { action_taken: rec.action_type || 'executed' });
      toast.success('Action executed', rec.title, { durationMs: 2500 });
      loadAll();
    } catch (e: unknown) {
      toast.error('Execution failed', e instanceof Error ? e.message : 'Unknown error');
    } finally {
      setExecutingId(null);
    }
  }, [executingId, loadAll, toast]);

  const handleDecideQueue = useCallback(async (id: string, decision: 'approved' | 'rejected' | 'deferred') => {
    try {
      const current = queueItems.find(q => q.id === id);
      await api.decideQueue(id, decision);
      setQueueItems(prev => prev.filter(q => q.id !== id));

      if (decision === 'approved' && current?.obligation_id) {
        const actionType = current.action_type;
        if (actionType === 'pay_now' || actionType === 'pay_full' || actionType === 'pay_minimum') {
          try {
            await api.markPaid(current.obligation_id);
            toast.success('Payment executed', current.title, { durationMs: 2200 });
          } catch {
            toast.error('Approved but payment failed', 'Check the action queue for details');
          }
        }
      }

      const labels = { approved: 'Approved', rejected: 'Rejected', deferred: 'Deferred' };
      if (decision !== 'approved' || !current?.obligation_id) {
        toast.info(labels[decision], current?.title || '', { durationMs: 2000 });
      }

      // Refresh stats
      api.getQueueStats().then(setQueueStats).catch(() => {});
    } catch (e: unknown) {
      toast.error('Decision failed', e instanceof Error ? e.message : 'Unknown error');
    }
  }, [queueItems, toast]);

  // Generate the morning brief
  const brief = data ? generateBrief(data, syncs, queueStats) : null;

  if (error && !data) {
    return (
      <div className="flex items-center justify-center min-h-[60vh]">
        <div className="text-center">
          <div className="w-3 h-3 rounded-full bg-urgency-red mx-auto mb-4 shadow-[0_0_12px_rgba(244,63,94,0.5)]" />
          <p className="text-chrome-text text-lg font-medium">Connection failed</p>
          <p className="text-chrome-muted mt-1 text-sm">{error}</p>
          <button
            onClick={loadAll}
            className="mt-4 px-4 py-2 bg-chitty-600 text-white rounded-xl text-sm font-medium hover:bg-chitty-700 transition-colors"
          >
            Retry
          </button>
        </div>
      </div>
    );
  }

  if (!data) {
    return <CommandSkeleton />;
  }

  return (
    <div className="space-y-4 lg:space-y-5 animate-fade-in">
      {/* Vital Signs Strip */}
      <VitalSigns data={data} syncs={syncs} />

      {/* Morning Brief */}
      {brief && !briefDismissed && (
        <div className="morning-brief animate-fade-in-up">
          <div className="flex items-start gap-3">
            <div className="w-2 h-2 rounded-full bg-chitty-500 mt-1.5 shrink-0 shadow-[0_0_8px_rgba(99,102,241,0.4)]" />
            <div className="flex-1 min-w-0">
              <p className="text-chrome-text text-sm leading-relaxed">{brief}</p>
            </div>
            <button
              onClick={() => setBriefDismissed(true)}
              className="text-chrome-muted hover:text-chrome-text text-xs shrink-0 transition-colors"
            >
              &times;
            </button>
          </div>
        </div>
      )}

      {/* Main Grid: Action Stream + System Pulse */}
      <div className="grid grid-cols-1 lg:grid-cols-[1fr_280px] gap-4 lg:gap-5 items-start">
        {/* Action Stream — primary content */}
        <ActionStream
          data={data}
          queueItems={queueItems}
          onPayNow={requestPayNow}
          onExecute={handleExecute}
          onDecideQueue={handleDecideQueue}
          payingId={payingId}
          executingId={executingId}
        />

        {/* System Pulse — sidebar on desktop, below on mobile */}
        <SystemPulse
          syncs={syncs}
          queueStats={queueStats}
          onSyncTriggered={loadAll}
        />
      </div>

      {/* Quick navigation */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
        <QuickNav label="All Bills" count={data.obligations.due_this_month} onClick={() => navigate('/bills')} />
        <QuickNav label="Cash Flow" onClick={() => navigate('/cashflow')} />
        <QuickNav label="Action Queue" count={String(queueItems.length)} onClick={() => navigate('/queue')} />
        <QuickNav label="Upload Docs" onClick={() => navigate('/upload')} />
      </div>

      {/* Confirm dialog */}
      <ConfirmDialog
        open={Boolean(pendingPayment)}
        title={pendingPayment?.action_type === 'charge' ? 'Execute payment?' : 'Mark bill as paid?'}
        message={pendingPayment?.action_type === 'charge'
          ? `This will trigger a payment for ${pendingPayment.payee} (${formatCurrency(pendingPayment.amount_due)}).`
          : `This records a manual payment for ${pendingPayment?.payee} (${formatCurrency(pendingPayment?.amount_due || 0)}).\nNo funds move unless this bill is charge-enabled.`}
        confirmLabel={pendingPayment?.action_type === 'charge' ? 'Pay now' : 'Mark paid'}
        variant={pendingPayment?.action_type === 'charge' ? 'primary' : 'danger'}
        loading={Boolean(payingId)}
        onConfirm={handleConfirmPayNow}
        onCancel={() => setPendingPayment(null)}
      />
    </div>
  );
}

/** Generate a contextual morning brief from data */
function generateBrief(data: DashboardData, syncs: SyncStatus[], queueStats: QueueStats | null): string {
  const parts: string[] = [];
  const overdueCount = parseInt(data.obligations.overdue_count) || 0;
  const dueThisWeek = parseInt(data.obligations.due_this_week) || 0;
  const cash = parseFloat(data.summary.total_cash) || 0;
  const due30d = parseFloat(data.obligations.total_due_30d) || 0;

  // Financial summary
  if (overdueCount > 0) {
    parts.push(`${overdueCount} bill${overdueCount > 1 ? 's' : ''} overdue.`);
  }
  if (dueThisWeek > 0) {
    parts.push(`${dueThisWeek} due this week.`);
  }

  // Cash position
  const surplus = cash - due30d;
  if (surplus < 0) {
    parts.push(`Cash shortfall of ${formatCurrency(Math.abs(surplus))} projected in 30 days.`);
  }

  // Disputes
  const urgentDisputes = data.disputes.filter(d => d.priority <= 2);
  if (urgentDisputes.length > 0) {
    parts.push(`${urgentDisputes.length} high-priority dispute${urgentDisputes.length > 1 ? 's' : ''} need attention.`);
  }

  // Deadlines
  const urgentDeadlines = data.deadlines.filter(dl => {
    const days = daysUntil(dl.deadline_date);
    return days <= 7 && days >= 0;
  });
  if (urgentDeadlines.length > 0) {
    parts.push(`${urgentDeadlines.length} legal deadline${urgentDeadlines.length > 1 ? 's' : ''} this week.`);
  }

  // Recommendations
  if (data.recommendations.length > 0) {
    parts.push(`${data.recommendations.length} AI recommendation${data.recommendations.length > 1 ? 's' : ''} ready to review.`);
  }

  // System health
  const failedSyncs = syncs.filter(s => s.status === 'error');
  if (failedSyncs.length > 0) {
    parts.push(`${failedSyncs.length} data source${failedSyncs.length > 1 ? 's' : ''} failing.`);
  }

  // Queue stats
  if (queueStats && queueStats.savings > 0) {
    parts.push(`$${queueStats.savings.toLocaleString()} in savings identified.`);
  }

  if (parts.length === 0) {
    return 'All systems nominal. No urgent items require attention.';
  }

  return parts.join(' ');
}

function QuickNav({ label, count, onClick }: { label: string; count?: string; onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      className="flex items-center justify-between px-3 py-2.5 rounded-xl bg-chrome-surface/60 border border-chrome-border text-sm text-chrome-muted hover:text-chrome-text hover:border-chrome-border/80 transition-all group"
    >
      <span className="font-medium group-hover:text-chrome-text transition-colors">{label}</span>
      {count && parseInt(count) > 0 && (
        <span className="text-[10px] font-mono font-bold bg-chrome-border/50 px-1.5 py-0.5 rounded-md">{count}</span>
      )}
    </button>
  );
}

function CommandSkeleton() {
  return (
    <div className="space-y-4 lg:space-y-5 animate-fade-in">
      {/* Vital signs skeleton */}
      <div className="h-10 rounded-xl skeleton-shimmer bg-chrome-surface/40" />

      {/* Brief skeleton */}
      <div className="h-12 rounded-xl skeleton-shimmer bg-chrome-surface/40" />

      {/* Main grid skeleton */}
      <div className="grid grid-cols-1 lg:grid-cols-[1fr_280px] gap-4 lg:gap-5">
        <div className="space-y-2">
          {Array.from({ length: 5 }).map((_, i) => (
            <div key={i} className="h-16 rounded-xl skeleton-shimmer bg-chrome-surface/40" style={{ animationDelay: `${i * 100}ms` }} />
          ))}
        </div>
        <div className="space-y-3">
          <div className="h-48 rounded-xl skeleton-shimmer bg-chrome-surface/40" />
          <div className="h-32 rounded-xl skeleton-shimmer bg-chrome-surface/40" />
        </div>
      </div>
    </div>
  );
}
