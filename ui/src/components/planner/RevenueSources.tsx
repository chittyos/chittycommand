import { useEffect, useState, useCallback } from 'react';
import { api, type RevenueSource } from '../../lib/api';
import { formatCurrency } from '../../lib/utils';
import { Card } from '../ui/Card';
import { ActionButton } from '../ui/ActionButton';

export function RevenueSources() {
  const [sources, setSources] = useState<RevenueSource[]>([]);
  const [summary, setSummary] = useState({ count: 0, total_monthly: 0, weighted_monthly: 0 });
  const [discovering, setDiscovering] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const data = await api.getRevenueSources();
      setSources(data.sources);
      setSummary(data.summary);
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : 'Failed to load');
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  const discover = async () => {
    setDiscovering(true);
    setError(null);
    try {
      const result = await api.discoverRevenue();
      await load();
      if (result.sources_discovered === 0 && result.sources_updated === 0) {
        setError('No new patterns found. Need more transaction history for discovery.');
      }
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : 'Discovery failed');
    } finally {
      setDiscovering(false);
    }
  };

  return (
    <div className="space-y-4">
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
        <div>
          <h2 className="text-card-text font-semibold">Revenue Sources</h2>
          <p className="text-card-muted text-xs mt-0.5">
            {summary.count} sources | {formatCurrency(summary.weighted_monthly)}/mo (confidence-weighted)
          </p>
        </div>
        <ActionButton
          label={discovering ? 'Discovering...' : 'Discover from History'}
          onClick={discover}
          loading={discovering}
        />
      </div>

      {error && (
        <p className="text-urgency-amber text-sm">{error}</p>
      )}

      {sources.length === 0 ? (
        <Card className="text-center py-6">
          <p className="text-card-muted">No revenue sources discovered yet.</p>
          <p className="text-card-muted text-sm mt-1">Click "Discover from History" to scan transaction data.</p>
        </Card>
      ) : (
        <div className="space-y-2">
          {sources.map((src) => (
            <Card key={src.id}>
              <div className="flex items-center justify-between">
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <h3 className="text-card-text text-sm font-medium truncate">{src.description}</h3>
                    <span className="text-xs px-1.5 py-0.5 rounded bg-gray-100 text-gray-600 shrink-0">
                      {src.source}
                    </span>
                    {src.verified_by && (
                      <span className="text-xs px-1.5 py-0.5 rounded bg-green-100 text-green-700 shrink-0">
                        {src.verified_by.replace(/_/g, ' ')}
                      </span>
                    )}
                  </div>
                  {src.account_name && (
                    <p className="text-card-muted text-xs mt-0.5">{src.institution} - {src.account_name}</p>
                  )}
                </div>
                <div className="flex items-center gap-3 shrink-0">
                  <div className="text-right">
                    <p className="text-card-text font-mono font-medium">{formatCurrency(parseFloat(src.amount))}</p>
                    <p className="text-card-muted text-xs">{src.recurrence || 'one-time'}</p>
                  </div>
                  <span className={`w-2.5 h-2.5 rounded-full ${
                    parseFloat(src.confidence) >= 0.8 ? 'bg-green-500'
                      : parseFloat(src.confidence) >= 0.6 ? 'bg-amber-500'
                        : 'bg-red-500'
                  }`} title={`${Math.round(parseFloat(src.confidence) * 100)}% confidence`} />
                </div>
              </div>
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}
