import { useEffect, useState, useCallback, useRef } from 'react';
import { api, type DashboardData, type Obligation, type Recommendation } from '../lib/api';
import { useFocusMode } from '../lib/focus-mode';
import { FocusView } from '../components/dashboard/FocusView';
import { FullView } from '../components/dashboard/FullView';
import { ConfirmDialog } from '../components/ui/ConfirmDialog';
import { useToast } from '../lib/toast';
import { formatCurrency } from '../lib/utils';

export function Dashboard() {
  const [data, setData] = useState<DashboardData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [payingId, setPayingId] = useState<string | null>(null);
  const [executingId, setExecutingId] = useState<string | null>(null);
  const [pendingPayment, setPendingPayment] = useState<Obligation | null>(null);
  const { focusMode } = useFocusMode();
  const toast = useToast();
  const payingIdRef = useRef<string | null>(null);

  const reload = useCallback(() => {
    api.getDashboard().then(setData).catch((e) => setError(e.message));
  }, []);

  useEffect(() => { reload(); }, [reload]);

  const requestPayNow = useCallback((ob: Obligation) => {
    if (payingId) return;
    setPendingPayment(ob);
  }, [payingId]);

  const handleConfirmPayNow = useCallback(async () => {
    const currentPayment = pendingPayment;
    if (!currentPayment || payingIdRef.current) return;
    payingIdRef.current = currentPayment.id;
    setPayingId(currentPayment.id);
    try {
      await api.markPaid(currentPayment.id);
      toast.success(
        'Marked as paid',
        `${currentPayment.payee}: ${formatCurrency(currentPayment.amount_due)}`,
        { durationMs: 2500 },
      );
      setPendingPayment(null);
      reload();
    } catch (e: unknown) {
      const message = e instanceof Error ? e.message : 'Payment failed';
      setError(message);
      toast.error('Could not mark paid', message);
    } finally {
      payingIdRef.current = null;
      setPayingId(null);
    }
  }, [pendingPayment, reload, toast]);

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

  if (error && !data) {
    return (
      <div className="text-center py-20">
        <p className="text-urgency-red text-lg font-medium">Failed to load dashboard</p>
        <p className="text-card-muted mt-2">{error}</p>
      </div>
    );
  }

  if (!data) {
    return <div className="text-center py-20 text-chrome-muted">Loading...</div>;
  }

  const viewProps = { data, onPayNow: requestPayNow, onExecute: handleExecute, payingId, executingId };

  return (
    <>
      {focusMode ? <FocusView {...viewProps} /> : <FullView {...viewProps} />}
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
    </>
  );
}
