import { useEffect, useState, useCallback } from 'react';
import { api, type DashboardData, type Obligation, type Recommendation } from '../lib/api';
import { useFocusMode } from '../lib/focus-mode';
import { FocusView } from '../components/dashboard/FocusView';
import { FullView } from '../components/dashboard/FullView';

export function Dashboard() {
  const [data, setData] = useState<DashboardData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [payingId, setPayingId] = useState<string | null>(null);
  const [executingId, setExecutingId] = useState<string | null>(null);
  const { focusMode } = useFocusMode();

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

  const viewProps = { data, onPayNow: handlePayNow, onExecute: handleExecute, payingId, executingId };

  return focusMode ? <FocusView {...viewProps} /> : <FullView {...viewProps} />;
}
