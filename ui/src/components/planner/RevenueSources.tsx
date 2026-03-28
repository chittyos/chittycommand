import { useEffect, useState, useCallback } from 'react';
import { api, type RevenueSource } from '../../lib/api';
import { formatCurrency } from '../../lib/utils';
import { Card } from '../ui/Card';
import { ActionButton } from '../ui/ActionButton';
import { useToast } from '../../lib/toast';
import { Plus, X, Pencil, Check } from 'lucide-react';

const emptyForm = { description: '', amount: '', recurrence: 'monthly', source: 'manual', confidence: '0.8' };

export function RevenueSources() {
  const [sources, setSources] = useState<RevenueSource[]>([]);
  const [summary, setSummary] = useState({ count: 0, total_monthly: 0, weighted_monthly: 0 });
  const [discovering, setDiscovering] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showAdd, setShowAdd] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const toast = useToast();
  const [form, setForm] = useState(emptyForm);

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

  const handleAdd = async () => {
    if (!form.description || !form.amount) return;
    setSaving(true);
    try {
      await api.addRevenueSource({
        description: form.description,
        amount: form.amount,
        recurrence: form.recurrence,
        source: form.source,
        confidence: form.confidence,
        status: 'active',
      });
      setShowAdd(false);
      setForm(emptyForm);
      await load();
      toast.success('Revenue source added', form.description);
    } catch (e: unknown) {
      toast.error('Add failed', e instanceof Error ? e.message : 'Unknown error');
    } finally {
      setSaving(false);
    }
  };

  const startEdit = (src: RevenueSource) => {
    setEditingId(src.id);
    setForm({
      description: src.description,
      amount: src.amount,
      recurrence: src.recurrence || 'monthly',
      source: src.source,
      confidence: src.confidence,
    });
  };

  const handleUpdate = async () => {
    if (!editingId || !form.description || !form.amount) return;
    setSaving(true);
    try {
      await api.updateRevenueSource(editingId, {
        description: form.description,
        amount: form.amount,
        recurrence: form.recurrence,
        confidence: form.confidence,
      });
      setEditingId(null);
      setForm(emptyForm);
      await load();
      toast.success('Revenue source updated', form.description);
    } catch (e: unknown) {
      toast.error('Update failed', e instanceof Error ? e.message : 'Unknown error');
    } finally {
      setSaving(false);
    }
  };

  const recurrenceOptions = ['weekly', 'biweekly', 'monthly', 'quarterly', 'annually', 'one-time'];

  return (
    <div className="space-y-4">
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
        <div>
          <h2 className="text-card-text font-semibold">Revenue Sources</h2>
          <p className="text-card-muted text-xs mt-0.5">
            {summary.count} sources | {formatCurrency(summary.weighted_monthly)}/mo (confidence-weighted)
          </p>
        </div>
        <div className="flex gap-2">
          <ActionButton
            label={showAdd ? 'Cancel' : 'Add Source'}
            variant={showAdd ? 'secondary' : 'primary'}
            onClick={() => { setShowAdd(!showAdd); setEditingId(null); setForm(emptyForm); }}
          />
          <ActionButton
            label={discovering ? 'Discovering...' : 'Auto-Discover'}
            variant="secondary"
            onClick={discover}
            loading={discovering}
          />
        </div>
      </div>

      {error && <p className="text-urgency-amber text-sm">{error}</p>}

      {/* Add / Edit form */}
      {(showAdd || editingId) && (
        <Card>
          <div className="space-y-3">
            <h3 className="font-semibold text-card-text text-sm flex items-center gap-2">
              {editingId ? <Pencil size={14} /> : <Plus size={14} />}
              {editingId ? 'Edit Revenue Source' : 'New Revenue Source'}
            </h3>
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
              <div className="sm:col-span-2">
                <label className="block text-xs font-medium text-card-muted mb-1">Description *</label>
                <input
                  value={form.description}
                  onChange={(e) => setForm(f => ({ ...f, description: e.target.value }))}
                  placeholder="e.g. Rental income - 550 W Surf"
                  className="w-full px-3 py-2 rounded-lg bg-slate-50 border border-slate-200 text-card-text text-sm focus:outline-none focus:ring-2 focus:ring-chitty-500/50"
                />
              </div>
              <div>
                <label className="block text-xs font-medium text-card-muted mb-1">Amount *</label>
                <input
                  type="number"
                  step="0.01"
                  value={form.amount}
                  onChange={(e) => setForm(f => ({ ...f, amount: e.target.value }))}
                  placeholder="0.00"
                  className="w-full px-3 py-2 rounded-lg bg-slate-50 border border-slate-200 text-card-text text-sm focus:outline-none focus:ring-2 focus:ring-chitty-500/50"
                />
              </div>
              <div>
                <label className="block text-xs font-medium text-card-muted mb-1">Recurrence</label>
                <select
                  value={form.recurrence}
                  onChange={(e) => setForm(f => ({ ...f, recurrence: e.target.value }))}
                  className="w-full px-3 py-2 rounded-lg bg-slate-50 border border-slate-200 text-card-text text-sm focus:outline-none"
                >
                  {recurrenceOptions.map(r => <option key={r} value={r}>{r}</option>)}
                </select>
              </div>
              <div>
                <label className="block text-xs font-medium text-card-muted mb-1">Source</label>
                <input
                  value={form.source}
                  onChange={(e) => setForm(f => ({ ...f, source: e.target.value }))}
                  placeholder="e.g. manual, plaid"
                  className="w-full px-3 py-2 rounded-lg bg-slate-50 border border-slate-200 text-card-text text-sm focus:outline-none"
                />
              </div>
              <div>
                <label className="block text-xs font-medium text-card-muted mb-1">Confidence (0-1)</label>
                <input
                  type="number"
                  step="0.1"
                  min="0"
                  max="1"
                  value={form.confidence}
                  onChange={(e) => setForm(f => ({ ...f, confidence: e.target.value }))}
                  className="w-full px-3 py-2 rounded-lg bg-slate-50 border border-slate-200 text-card-text text-sm focus:outline-none"
                />
              </div>
            </div>
            <div className="flex justify-end gap-2 pt-1">
              <ActionButton
                label="Cancel"
                variant="secondary"
                onClick={() => { setShowAdd(false); setEditingId(null); setForm(emptyForm); }}
              />
              <ActionButton
                label={saving ? 'Saving...' : editingId ? 'Update' : 'Add'}
                onClick={editingId ? handleUpdate : handleAdd}
                loading={saving}
                disabled={!form.description || !form.amount}
              />
            </div>
          </div>
        </Card>
      )}

      {sources.length === 0 ? (
        <Card className="text-center py-6">
          <p className="text-card-muted">No revenue sources discovered yet.</p>
          <p className="text-card-muted text-sm mt-1">Click "Auto-Discover" to scan transaction data or "Add Source" to enter manually.</p>
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
                  <button
                    onClick={() => startEdit(src)}
                    className="text-card-muted hover:text-chitty-500 transition-colors p-1"
                    title="Edit"
                  >
                    <Pencil size={14} />
                  </button>
                </div>
              </div>
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}
